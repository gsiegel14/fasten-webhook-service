const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { Webhook } = require('standardwebhooks');
const {
  requestEHIExport,
  FASTEN_CONFIGURED
} = require('./fasten-api');

// Import Foundry integration
const {
  downloadAndProcessFHIR,
  getAllFoundryData,
  getFoundryDataForUser,
  getFoundryDataHistory,
  clearProcessedData,
  getIngestionStats
} = require('./foundry-integration');

// Import performance optimizations
const {
  OPTIMIZATION_CONFIG,
  PerformanceMonitor,
  optimizedTriggerExport,
  optimizedProcessFHIR,
  FoundryCache
} = require('./performance-optimizations');

// Initialize performance monitoring
const perfMonitor = new PerformanceMonitor();
const foundryCache = new FoundryCache();

// Make foundryCache available globally for cache invalidation
global.foundryCache = foundryCache;

// Import webhook diagnostics
const WebhookDiagnostics = require('./webhook-diagnostics');

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize diagnostics
const diagnostics = new WebhookDiagnostics();

const pendingExportRequests = new Set();

// In-memory storage for webhook events (in production, use a database)
const webhookEvents = new Map();
const processedEventIds = new Set(); // For idempotency protection
const connectionExports = new Map(); // org_connection_id -> export data
const connectionStatus = new Map(); // org_connection_id -> connection info
const userConnections = new Map(); // external_id -> Set<org_connection_id>
const userExports = new Map(); // external_id -> Map<org_connection_id, export_data>

// Middleware
app.use(helmet());
app.use(cors());

// Raw body middleware for webhook signature verification (must be before express.json)
app.use('/webhook/fasten', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    req.body = JSON.parse(req.body.toString());
  } catch (error) {
    console.error('Error parsing webhook body:', error);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path}`);
  next();
});

// Webhook signature verification using Standard-Webhooks library
function verifyWebhookSignature(body, headers, secret) {
  if (!secret) {
    return false; // Skip verification if no secret
  }
  
  try {
    const wh = new Webhook(secret);
    wh.verify(body, headers);
    return true;
  } catch (error) {
    console.error('Webhook signature verification error:', error);
    return false;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'fasten-webhook-service',
    version: '1.0.0',
    stats: {
      totalEvents: webhookEvents.size,
      processedEvents: processedEventIds.size,
      connections: connectionStatus.size,
      exports: connectionExports.size,
      uniqueUsers: userConnections.size,
      userExports: userExports.size
    }
  });
});

// Debug endpoint to show recent events
app.get('/debug/events', (req, res) => {
  console.log(`${new Date().toISOString()} - GET /debug/events`);
  
  const recentEvents = Array.from(webhookEvents.entries())
    .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp))
    .slice(0, 20)
    .map(([id, event]) => ({
      id,
      timestamp: event.timestamp,
      type: event.body?.type,
      api_mode: event.body?.api_mode,
      external_id: event.body?.data?.external_id,
      org_connection_id: event.body?.data?.org_connection_id,
      processed: event.processed
    }));
  
  res.json({
    recentEvents,
    totalEvents: webhookEvents.size,
    timestamp: new Date().toISOString()
  });
});

// API endpoint for iOS app to get connection status
app.get('/api/connections/:orgConnectionId/status', (req, res) => {
  const { orgConnectionId } = req.params;
  const connection = connectionStatus.get(orgConnectionId);
  
  if (!connection) {
    return res.status(404).json({
      error: 'Connection not found',
      orgConnectionId
    });
  }
  
  // Get export data
  const exportData = connectionExports.get(orgConnectionId);
  const foundryData = getAllFoundryData();
  const connectionRecords = foundryData.filter(r => r.orgConnectionId === orgConnectionId);
  
  // Determine detailed export status
  let exportStatus = 'pending';
  let error = null;
  let recordCount = 0;
  
  if (exportData) {
    if (exportData.downloadLink) {
      recordCount = connectionRecords.length;
      if (recordCount > 0) {
        exportStatus = 'complete';
      } else {
        exportStatus = 'processing';
      }
    } else if (exportData.taskId) {
      exportStatus = 'downloading';
    } else if (exportData.exportStatus === 'error' || exportData.error) {
      exportStatus = 'error';
      error = exportData.error || 'Export failed';
    } else {
      exportStatus = 'requested';
    }
  } else if (connection.exportStatus === 'requested' || connection.pendingTaskId) {
    exportStatus = 'requested';
  }
  
  // Check if export is in flight
  if (inFlightExports && inFlightExports.has && inFlightExports.has(orgConnectionId)) {
    exportStatus = 'in_progress';
  }
  
  res.json({
    orgConnectionId,
    ...connection,
    hasExport: connectionExports.has(orgConnectionId),
    exportStatus,
    dataReady: recordCount > 0,
    recordCount,
    exportData: exportData ? {
      taskId: exportData.taskId,
      downloadLink: exportData.downloadLink,
      totalResources: exportData.totalResources,
      timestamp: exportData.timestamp
    } : null,
    error
  });
});

// API endpoint for iOS app to get export data
app.get('/api/connections/:orgConnectionId/exports', (req, res) => {
  const { orgConnectionId } = req.params;
  const exportData = connectionExports.get(orgConnectionId);
  
  if (!exportData) {
    return res.status(404).json({
      error: 'Export not found',
      orgConnectionId
    });
  }
  
  res.json({
    orgConnectionId,
    ...exportData
  });
});

// API endpoint to list all connections for debugging
app.get('/api/connections', (req, res) => {
  const connections = Array.from(connectionStatus.entries()).map(([id, data]) => ({
    orgConnectionId: id,
    ...data,
    hasExport: connectionExports.has(id)
  }));
  
  res.json({ connections });
});

// API endpoint for iOS app to get all connections for a user (by external_id)
app.get('/api/users/:externalId/connections', (req, res) => {
  const { externalId } = req.params;
  const userOrgIds = userConnections.get(externalId);
  
  if (!userOrgIds || userOrgIds.size === 0) {
    return res.json({
      externalId,
      connections: []
    });
  }
  
  const connections = Array.from(userOrgIds).map(orgId => {
    const connection = connectionStatus.get(orgId);
    return {
      orgConnectionId: orgId,
      ...connection,
      hasExport: connectionExports.has(orgId)
    };
  }).filter(Boolean);
  
  res.json({
    externalId,
    connections
  });
});

// API endpoint for iOS app to get all exports for a user (by external_id)
app.get('/api/users/:externalId/exports', (req, res) => {
  const { externalId } = req.params;
  const userExportMap = userExports.get(externalId);
  
  if (!userExportMap || userExportMap.size === 0) {
    return res.json({
      externalId,
      exports: []
    });
  }
  
  const exports = Array.from(userExportMap.entries()).map(([orgId, exportData]) => ({
    orgConnectionId: orgId,
    ...exportData
  }));
  
  res.json({
    externalId,
    exports
  });
});

// API endpoint to get user summary (connections + exports)
app.get('/api/users/:externalId/summary', (req, res) => {
  const { externalId } = req.params;
  const userOrgIds = userConnections.get(externalId);
  const userExportMap = userExports.get(externalId);
  
  if (!userOrgIds || userOrgIds.size === 0) {
    return res.json({
      externalId,
      totalConnections: 0,
      totalExports: 0,
      connections: [],
      exports: []
    });
  }
  
  const connections = Array.from(userOrgIds).map(orgId => {
    const connection = connectionStatus.get(orgId);
    return {
      orgConnectionId: orgId,
      ...connection,
      hasExport: connectionExports.has(orgId)
    };
  }).filter(Boolean);
  
  const exports = userExportMap ? Array.from(userExportMap.entries()).map(([orgId, exportData]) => ({
    orgConnectionId: orgId,
    ...exportData
  })) : [];
  
  res.json({
    externalId,
    totalConnections: connections.length,
    totalExports: exports.length,
    connections,
    exports
  });
});

// Main webhook endpoint for Fasten Connect
app.post('/webhook/fasten', async (req, res) => {
  const timestamp = new Date().toISOString();
  const eventId = crypto.randomUUID();
  
  console.log(`\n=== Fasten Webhook Event Received (${timestamp}) ===`);
  console.log('Event ID:', eventId);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  // Verify webhook signature if secret is provided
  const secret = process.env.FASTEN_WEBHOOK_SECRET;
  
  if (secret && !verifyWebhookSignature(req.rawBody, req.headers, secret)) {
    console.log('❌ Webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Store the raw event
  const event = {
    id: eventId,
    timestamp,
    headers: req.headers,
    body: req.body,
    processed: false
  };
  
  webhookEvents.set(eventId, event);
  
  // Process different event types
  try {
    await processWebhookEvent(req.body, timestamp);
    event.processed = true;
  } catch (error) {
    console.error('Error processing webhook event:', error);
    event.error = error.message;
  }
  
  console.log('=== End Webhook Event ===\n');
  
  // Respond with 200 OK to acknowledge receipt
  res.status(200).json({ 
    received: true, 
    eventId,
    timestamp,
    message: 'Webhook event processed successfully'
  });
});

// Process webhook events based on type
async function processWebhookEvent(body, timestamp) {
  const { type, data, api_mode, id } = body;
  
  // Check for duplicate events (idempotency protection)
  if (id && processedEventIds.has(id)) {
    console.log(`⚠️ Duplicate event detected: ${id} - skipping processing`);
    return;
  }
  
  // Mark event as processed
  if (id) {
    processedEventIds.add(id);
  }
  
  console.log(`📋 Processing event: ${type} (${api_mode || 'unknown mode'})`);
  
  switch (type) {
    case 'patient.ehi_export_success':
      await handleExportSuccess(data, timestamp);
      break;
      
    case 'patient.ehi_export_failed':
      handleExportFailed(data, timestamp);
      break;
      
    case 'patient.connection_success':
      await handleConnectionSuccess(data, timestamp);
      break;
      
    case 'patient.authorization_revoked':
      handleAuthorizationRevoked(data, timestamp);
      break;
      
    case 'webhook.test':
      handleWebhookTest(data, timestamp);
      break;
      
    default:
      console.log(`⚠️ Unknown event type: ${type}`);
  }
}

async function triggerExportForConnection(orgConnectionId, connectionData) {
  if (pendingExportRequests.has(orgConnectionId)) {
    console.log(`ℹ️  Export request already in-flight for ${orgConnectionId}; skipping duplicate trigger.`);
    return;
  }

  pendingExportRequests.add(orgConnectionId);

  const requestTimestamp = new Date().toISOString();
  console.log(`🚀 Requesting Fasten EHI export for connection ${orgConnectionId} at ${requestTimestamp}`);

  try {
    const response = await requestEHIExport(orgConnectionId);
    const responseData = response?.data || response || {};
    const status = responseData.status || response?.status || 'requested';
    const taskId = responseData.task_id || response?.task_id || null;

    if (connectionData) {
      connectionData.exportStatus = status;
      connectionData.lastExportRequested = requestTimestamp;
      if (taskId) {
        connectionData.pendingTaskId = taskId;
      }
    }

    console.log(`✅ Fasten export requested for ${orgConnectionId} (status: ${status}${taskId ? `, task: ${taskId}` : ''})`);
  } catch (error) {
    const message = error?.message || 'Unknown error';
    console.error(`❌ Failed to request Fasten export for ${orgConnectionId}: ${message}`);
    if (error?.body) {
      console.error(`   ↳ Response body: ${error.body}`);
    }
    if (connectionData) {
      connectionData.exportStatus = 'request_failed';
      connectionData.exportError = message;
      connectionData.lastExportRequested = requestTimestamp;
    }
  } finally {
    pendingExportRequests.delete(orgConnectionId);
  }
}

async function handleExportSuccess(data, timestamp) {
  const { org_connection_id, download_link, stats, task_id, org_id } = data;
  
  console.log(`✅ Export Success for connection: ${org_connection_id}`);
  console.log(`📊 Stats:`, stats);
  console.log(`📥 Download link: ${download_link}`);
  
  const exportData = {
    status: 'success',
    downloadLink: download_link,
    stats: stats || {},
    taskId: task_id,
    orgId: org_id,
    timestamp,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
  };
  
  // Store export data for iOS app to retrieve
  connectionExports.set(org_connection_id, exportData);
  
  // Stop export monitoring (export received successfully)
  diagnostics.stopExportMonitoring(org_connection_id);

  // Update connection status
  if (connectionStatus.has(org_connection_id)) {
    const connection = connectionStatus.get(org_connection_id);
    connection.lastExportSuccess = timestamp;
    connection.exportStatus = 'success';
    
    // Update user-centric export tracking
    if (connection.externalId) {
      if (!userExports.has(connection.externalId)) {
        userExports.set(connection.externalId, new Map());
      }
      userExports.get(connection.externalId).set(org_connection_id, exportData);
      console.log(`📋 Updated exports for user: ${connection.externalId}`);
    }
  }
  
  // Process FHIR data for Foundry ingestion
  try {
    const connection = connectionStatus.get(org_connection_id);
    if (connection && connection.externalId) {
      console.log(`🔄 Processing FHIR data for Foundry ingestion...`);
      await downloadAndProcessFHIR(download_link, org_connection_id, connection.externalId);
      console.log(`✅ FHIR data processed and ready for Foundry ingestion`);
    } else {
      console.log(`⚠️ No external_id found for connection ${org_connection_id}, skipping Foundry processing`);
    }
  } catch (error) {
    console.error('❌ Failed to process FHIR data for Foundry:', error);
  }
}

function handleExportFailed(data, timestamp) {
  const { org_connection_id, failure_reason, task_id, org_id } = data;
  
  console.log(`❌ Export Failed for connection: ${org_connection_id}`);
  console.log(`💥 Failure reason: ${failure_reason}`);
  
  // Stop export monitoring (failure received)
  diagnostics.stopExportMonitoring(org_connection_id);
  
  const exportData = {
    status: 'failed',
    failureReason: failure_reason,
    taskId: task_id,
    orgId: org_id,
    timestamp
  };
  
  // Store failure data
  connectionExports.set(org_connection_id, exportData);
  
  // Update connection status
  if (connectionStatus.has(org_connection_id)) {
    const connection = connectionStatus.get(org_connection_id);
    connection.lastExportFailure = timestamp;
    connection.exportStatus = 'failed';
    connection.failureReason = failure_reason;
    
    // Update user-centric export tracking
    if (connection.externalId) {
      if (!userExports.has(connection.externalId)) {
        userExports.set(connection.externalId, new Map());
      }
      userExports.get(connection.externalId).set(org_connection_id, exportData);
      console.log(`📋 Updated failed export for user: ${connection.externalId}`);
    }
  }
}

async function handleConnectionSuccess(data, timestamp) {
  const { 
    org_connection_id, 
    endpoint_id, 
    brand_id, 
    portal_id, 
    connection_status, 
    platform_type,
    external_id 
  } = data;
  
  console.log(`🔗 Connection Success: ${org_connection_id}`);
  console.log(`🏥 Platform: ${platform_type}`);
  console.log(`👤 External ID: ${external_id || 'none'}`);
  
  // Store connection data
  const connectionData = {
    endpointId: endpoint_id,
    brandId: brand_id,
    portalId: portal_id,
    connectionStatus: connection_status,
    platformType: platform_type,
    externalId: external_id,
    connectedAt: timestamp,
    exportStatus: 'pending'
  };
  
  connectionStatus.set(org_connection_id, connectionData);
  
  // Start export timeout monitoring
  diagnostics.startExportMonitoring(org_connection_id, connectionData);
  
  // Update user-centric connection tracking
  if (external_id) {
    if (!userConnections.has(external_id)) {
      userConnections.set(external_id, new Set());
    }
    userConnections.get(external_id).add(org_connection_id);
    console.log(`👥 Added connection ${org_connection_id} to user: ${external_id}`);
    console.log(`👥 User ${external_id} now has ${userConnections.get(external_id).size} connection(s)`);
  }
  
  if (FASTEN_CONFIGURED) {
    await triggerExportForConnection(org_connection_id, connectionData);
  } else {
    console.warn('⚠️  Fasten credentials missing; skipping automatic export request.');
  }

  console.log(`📝 Connection established for ${org_connection_id}; monitoring for export completion.`);
}

function handleAuthorizationRevoked(data, timestamp) {
  const { org_connection_id, connection_status } = data;
  
  console.log(`🚫 Authorization Revoked: ${org_connection_id}`);
  
  // Update connection status
  if (connectionStatus.has(org_connection_id)) {
    const connection = connectionStatus.get(org_connection_id);
    const externalId = connection.externalId;
    
    connection.connectionStatus = connection_status;
    connection.revokedAt = timestamp;
    
    // Clean up user-centric tracking
    if (externalId) {
      // Remove from user connections
      if (userConnections.has(externalId)) {
        userConnections.get(externalId).delete(org_connection_id);
        if (userConnections.get(externalId).size === 0) {
          userConnections.delete(externalId);
        }
        console.log(`👥 Removed connection ${org_connection_id} from user: ${externalId}`);
      }
      
      // Remove from user exports
      if (userExports.has(externalId)) {
        userExports.get(externalId).delete(org_connection_id);
        if (userExports.get(externalId).size === 0) {
          userExports.delete(externalId);
        }
        console.log(`📋 Removed export data for user: ${externalId}`);
      }
    }
  }
  
  // Remove export data since connection is revoked
  connectionExports.delete(org_connection_id);
}

function handleWebhookTest(data, timestamp) {
  console.log(`🧪 Webhook Test:`, data);
}

// Generic webhook endpoint for testing
app.post('/webhook/test', (req, res) => {
  const timestamp = new Date().toISOString();
  
  console.log(`\n=== Test Webhook Event (${timestamp}) ===`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=== End Test Event ===\n');
  
  res.status(200).json({ 
    received: true, 
    timestamp,
    message: 'Test webhook received successfully'
  });
});

// Foundry Data Connection Endpoints
// This endpoint is called BY Foundry to pull processed FHIR data
app.get('/api/foundry/data', (req, res) => {
  try {
    // Check cache first for faster response
    const cacheKey = 'foundry-data-all';
    let allData = foundryCache.get(cacheKey);
    
    if (!allData) {
      // Cache miss - get fresh data
      allData = getAllFoundryData();
      foundryCache.set(cacheKey, allData);
      console.log(`📤 Foundry data request: returning ${allData.length} records (fresh)`);
    } else {
      console.log(`⚡ Foundry data request: returning ${allData.length} records (cached)`);
    }
    
    res.json({
      data: allData,
      metadata: {
        total_records: allData.length,
        timestamp: new Date().toISOString(),
        source: 'fasten-webhook-service',
        cached: allData === foundryCache.get(cacheKey)
      }
    });
  } catch (error) {
    console.error('❌ Error serving Foundry data:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/api/foundry/dataHistory', (req, res) => {
  try {
    const history = getFoundryDataHistory();
    res.json({
      data: history,
      metadata: {
        batches: history.length,
        timestamp: new Date().toISOString(),
        source: 'fasten-webhook-service'
      }
    });
  } catch (error) {
    console.error('❌ Error serving Foundry data history:', error);
    res.status(500).json({ error: 'Failed to retrieve data history' });
  }
});

// Get data for specific user (for debugging)
app.get('/api/foundry/users/:externalId/data', (req, res) => {
  try {
    const { externalId } = req.params;
    const userData = getFoundryDataForUser(externalId);
    
    res.json({
      external_id: externalId,
      data: userData,
      metadata: {
        total_records: userData.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Error serving user data:', error);
    res.status(500).json({ error: 'Failed to retrieve user data' });
  }
});

// Foundry ingestion statistics
app.get('/api/foundry/stats', (req, res) => {
  try {
    const stats = getIngestionStats();
    res.json(stats);
  } catch (error) {
    console.error('❌ Error getting ingestion stats:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// Get performance metrics
app.get('/api/performance/metrics', (req, res) => {
  try {
    const metrics = perfMonitor.getMetricsSummary();
    const cacheStatus = {
      enabled: OPTIMIZATION_CONFIG.foundry.cacheEnabled,
      ttlMs: OPTIMIZATION_CONFIG.foundry.cacheTTLMs
    };
    
    res.json({
      metrics,
      optimizations: OPTIMIZATION_CONFIG,
      cacheStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error getting performance metrics:', error);
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

// Clear processed data (for testing)
app.post('/api/foundry/clear', (req, res) => {
  try {
    const { external_id } = req.body;
    clearProcessedData(external_id);
    
    res.json({
      message: external_id ? 
        `Cleared data for user: ${external_id}` : 
        'Cleared all processed data',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error clearing data:', error);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

// Webhook Diagnostics Endpoints
app.get('/api/diagnostics/report', (req, res) => {
  try {
    const report = diagnostics.generateDiagnosticReport();
    res.json(report);
  } catch (error) {
    console.error('Error generating diagnostic report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

app.get('/api/diagnostics/stats', (req, res) => {
  try {
    const stats = diagnostics.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting diagnostic stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Enhanced connection status with timeout info
app.get('/api/connections/detailed', (req, res) => {
  try {
    const connections = [];
    const diagnosticStats = diagnostics.getStats();
    
    for (const [orgConnectionId, connection] of connectionStatus.entries()) {
      const enhanced = {
        ...connection,
        orgConnectionId,
        hasExport: connectionExports.has(orgConnectionId)
      };
      
      // Add timeout monitoring info if available
      const timeout = diagnostics.connectionTimeouts?.get(orgConnectionId);
      if (timeout) {
        enhanced.monitoring = {
          status: timeout.status,
          startedAt: timeout.startedAt,
          timedOutAt: timeout.timedOutAt
        };
      }
      
      connections.push(enhanced);
    }
    
    res.json({
      connections,
      diagnostics: diagnosticStats,
      totalConnections: connections.length
    });
  } catch (error) {
    console.error('Error getting detailed connections:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

// Catch-all for other webhook paths
app.post('/webhook/*', (req, res) => {
  const timestamp = new Date().toISOString();
  
  console.log(`\n=== Unknown Webhook Path: ${req.path} (${timestamp}) ===`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=== End Unknown Webhook ===\n');
  
  res.status(200).json({ 
    received: true, 
    timestamp,
    path: req.path,
    message: 'Webhook received at unknown path'
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    path: req.path,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Fasten Webhook Service running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: /webhook/fasten`);
  console.log(`🔍 Health check: /health`);
  console.log(`🧪 Test endpoint: /webhook/test`);
  console.log(`⏰ Started at: ${new Date().toISOString()}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
