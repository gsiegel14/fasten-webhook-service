// Webhook Diagnostics Module
// Helps diagnose silent webhook failures from Fasten Connect

const axios = require('axios');

class WebhookDiagnostics {
  constructor() {
    this.connectionTimeouts = new Map(); // org_connection_id -> timeout info
    this.healthChecks = new Map(); // connection health tracking
    this.EXPORT_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
  }

  // Start monitoring a connection for export timeout
  startExportMonitoring(orgConnectionId, connectionData) {
    console.log(`🕐 Starting export timeout monitoring for connection: ${orgConnectionId}`);
    
    const timeoutId = setTimeout(() => {
      this.handleExportTimeout(orgConnectionId, connectionData);
    }, this.EXPORT_TIMEOUT);

    this.connectionTimeouts.set(orgConnectionId, {
      timeoutId,
      startedAt: new Date().toISOString(),
      connectionData,
      status: 'monitoring'
    });
  }

  // Stop monitoring (called when export success/failure received)
  stopExportMonitoring(orgConnectionId) {
    const timeout = this.connectionTimeouts.get(orgConnectionId);
    if (timeout) {
      clearTimeout(timeout.timeoutId);
      timeout.status = 'completed';
      console.log(`✅ Export monitoring stopped for connection: ${orgConnectionId}`);
    }
  }

  // Handle export timeout (no webhook received)
  async handleExportTimeout(orgConnectionId, connectionData) {
    console.log(`\n🚨 EXPORT TIMEOUT DETECTED 🚨`);
    console.log(`Connection: ${orgConnectionId}`);
    console.log(`Platform: ${connectionData.platformType}`);
    console.log(`Connected at: ${connectionData.connectedAt}`);
    console.log(`Timeout after: ${this.EXPORT_TIMEOUT / 60000} minutes`);
    
    // Update timeout info
    const timeout = this.connectionTimeouts.get(orgConnectionId);
    if (timeout) {
      timeout.status = 'timed_out';
      timeout.timedOutAt = new Date().toISOString();
    }

    // Log diagnostic information
    await this.logDiagnosticInfo(orgConnectionId, connectionData);
    
    // Attempt to probe the connection status
    await this.probeConnectionHealth(orgConnectionId, connectionData);
  }

  // Log comprehensive diagnostic information
  async logDiagnosticInfo(orgConnectionId, connectionData) {
    console.log(`\n📊 DIAGNOSTIC INFORMATION:`);
    console.log(`- Connection ID: ${orgConnectionId}`);
    console.log(`- Platform: ${connectionData.platformType}`);
    console.log(`- Endpoint ID: ${connectionData.endpointId || 'N/A'}`);
    console.log(`- Brand ID: ${connectionData.brandId || 'N/A'}`);
    console.log(`- Portal ID: ${connectionData.portalId || 'N/A'}`);
    console.log(`- External ID: ${connectionData.externalId || 'MISSING'}`);
    console.log(`- Connected at: ${connectionData.connectedAt}`);
    
    // Check if this is a known problematic provider
    const knownIssues = this.getKnownProviderIssues(connectionData);
    if (knownIssues.length > 0) {
      console.log(`\n⚠️ KNOWN ISSUES WITH THIS PROVIDER:`);
      knownIssues.forEach(issue => console.log(`- ${issue}`));
    }
  }

  // Probe connection health by checking if connection still exists
  async probeConnectionHealth(orgConnectionId, connectionData) {
    console.log(`\n🔍 PROBING CONNECTION HEALTH...`);
    
    try {
      // This would ideally call Fasten API to check connection status
      // For now, we'll log what we would check
      console.log(`- Would check Fasten API for connection status`);
      console.log(`- Would verify if authorization is still valid`);
      console.log(`- Would check if export task exists in Fasten system`);
      
      // Store health check result
      this.healthChecks.set(orgConnectionId, {
        checkedAt: new Date().toISOString(),
        status: 'timeout_detected',
        connectionData
      });
      
    } catch (error) {
      console.error(`❌ Failed to probe connection health:`, error.message);
    }
  }

  // Get known issues for specific providers
  getKnownProviderIssues(connectionData) {
    const issues = [];
    
    // Epic-specific issues
    if (connectionData.platformType === 'epic') {
      issues.push('Epic systems can be slow, especially large health systems');
      issues.push('Some Epic instances have export delays of 30+ minutes');
      issues.push('Epic may silently fail if patient has no records');
    }
    
    // Check for specific problematic portals/brands
    const problematicPortals = {
      '20cad42b-0e5d-44a6-ba0b-fc20a6a24fef': 'Denver Health - Known for slow/unreliable exports'
    };
    
    if (connectionData.portalId && problematicPortals[connectionData.portalId]) {
      issues.push(problematicPortals[connectionData.portalId]);
    }
    
    return issues;
  }

  // Generate diagnostic report
  generateDiagnosticReport() {
    const report = {
      timestamp: new Date().toISOString(),
      activeMonitoring: [],
      timedOutConnections: [],
      completedConnections: [],
      totalConnections: this.connectionTimeouts.size
    };

    for (const [connectionId, timeout] of this.connectionTimeouts) {
      const entry = {
        connectionId,
        status: timeout.status,
        startedAt: timeout.startedAt,
        connectionData: timeout.connectionData
      };

      if (timeout.timedOutAt) {
        entry.timedOutAt = timeout.timedOutAt;
      }

      switch (timeout.status) {
        case 'monitoring':
          report.activeMonitoring.push(entry);
          break;
        case 'timed_out':
          report.timedOutConnections.push(entry);
          break;
        case 'completed':
          report.completedConnections.push(entry);
          break;
      }
    }

    return report;
  }

  // Get diagnostic stats
  getStats() {
    const stats = {
      totalConnections: this.connectionTimeouts.size,
      activeMonitoring: 0,
      timedOut: 0,
      completed: 0,
      healthChecks: this.healthChecks.size
    };

    for (const timeout of this.connectionTimeouts.values()) {
      switch (timeout.status) {
        case 'monitoring':
          stats.activeMonitoring++;
          break;
        case 'timed_out':
          stats.timedOut++;
          break;
        case 'completed':
          stats.completed++;
          break;
      }
    }

    return stats;
  }
}

module.exports = WebhookDiagnostics;
