// Performance Optimizations for Fasten-to-Foundry Pipeline

const OPTIMIZATION_CONFIG = {
  // Export Triggering Optimizations
  export: {
    triggerDelayMs: 0,           // Immediate trigger after connection (no delay)
    maxRetries: 3,               // Retry failed exports automatically
    retryDelayMs: 1000,          // Quick retry on failure
    parallelExports: true,       // Allow multiple exports to process simultaneously
    timeoutMs: 60000             // 1 minute timeout for export requests
  },

  // Data Processing Optimizations  
  processing: {
    batchSize: 100,              // Process FHIR resources in batches
    parallelProcessing: true,    // Process batches in parallel
    compressionEnabled: true,    // Compress data in memory
    streamProcessing: true       // Stream large files instead of loading all at once
  },

  // Foundry Integration Optimizations
  foundry: {
    cacheEnabled: true,          // Cache processed data for faster retrieval
    cacheTTLMs: 300000,          // 5 minute cache TTL
    batchIngestion: true,        // Send data to Foundry in batches
    compressionEnabled: true,    // Compress data sent to Foundry
    dedupEnabled: true           // Deduplicate records before sending
  },

  // Performance Monitoring
  monitoring: {
    metricsEnabled: true,        // Track performance metrics
    alertThresholdMs: 30000,     // Alert if processing takes > 30 seconds
    logLevel: 'info',            // Detailed logging for optimization
    trackMemoryUsage: true       // Monitor memory consumption
  }
};

// Performance monitoring class
class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.startTimes = new Map();
  }

  startTimer(operationId) {
    this.startTimes.set(operationId, Date.now());
  }

  endTimer(operationId, metadata = {}) {
    const startTime = this.startTimes.get(operationId);
    if (!startTime) return;

    const duration = Date.now() - startTime;
    this.startTimes.delete(operationId);

    const metric = {
      operationId,
      duration,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    // Store metrics
    if (!this.metrics.has(operationId)) {
      this.metrics.set(operationId, []);
    }
    this.metrics.get(operationId).push(metric);

    // Log if exceeds threshold
    if (duration > OPTIMIZATION_CONFIG.monitoring.alertThresholdMs) {
      console.warn(`⚠️ Performance Alert: ${operationId} took ${duration}ms (threshold: ${OPTIMIZATION_CONFIG.monitoring.alertThresholdMs}ms)`);
    }

    return metric;
  }

  getAverageTime(operationId) {
    const metrics = this.metrics.get(operationId) || [];
    if (metrics.length === 0) return 0;
    
    const sum = metrics.reduce((acc, m) => acc + m.duration, 0);
    return sum / metrics.length;
  }

  getMetricsSummary() {
    const summary = {};
    for (const [operationId, metrics] of this.metrics.entries()) {
      const durations = metrics.map(m => m.duration);
      summary[operationId] = {
        count: metrics.length,
        avgMs: Math.round(this.getAverageTime(operationId)),
        minMs: Math.min(...durations),
        maxMs: Math.max(...durations),
        lastRun: metrics[metrics.length - 1]?.timestamp
      };
    }
    return summary;
  }

  reset() {
    this.metrics.clear();
    this.startTimes.clear();
  }
}

// Optimized export trigger with immediate processing
async function optimizedTriggerExport(orgConnectionId, connectionData, perfMonitor) {
  const opId = `export-trigger-${orgConnectionId}`;
  perfMonitor.startTimer(opId);

  try {
    // No delay - trigger immediately
    const response = await requestEHIExportWithRetry(orgConnectionId, {
      maxRetries: OPTIMIZATION_CONFIG.export.maxRetries,
      retryDelayMs: OPTIMIZATION_CONFIG.export.retryDelayMs,
      timeoutMs: OPTIMIZATION_CONFIG.export.timeoutMs
    });

    const metric = perfMonitor.endTimer(opId, {
      connectionId: orgConnectionId,
      status: response.status,
      taskId: response.task_id
    });

    console.log(`⚡ Export triggered in ${metric.duration}ms for ${orgConnectionId}`);
    return response;
  } catch (error) {
    perfMonitor.endTimer(opId, { error: error.message });
    throw error;
  }
}

// Retry wrapper for export requests
async function requestEHIExportWithRetry(orgConnectionId, options) {
  const { maxRetries, retryDelayMs, timeoutMs } = options;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      
      const response = await requestEHIExport(orgConnectionId, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      return response;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      console.log(`⚡ Retry ${attempt}/${maxRetries} for export ${orgConnectionId}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

// Optimized FHIR data processing with streaming
async function optimizedProcessFHIR(downloadLink, orgConnectionId, externalId, perfMonitor) {
  const opId = `process-fhir-${orgConnectionId}`;
  perfMonitor.startTimer(opId);

  try {
    // Stream processing for large files
    if (OPTIMIZATION_CONFIG.processing.streamProcessing) {
      const processedData = await streamProcessFHIR(downloadLink, orgConnectionId, externalId);
      
      const metric = perfMonitor.endTimer(opId, {
        recordCount: processedData.length,
        connectionId: orgConnectionId
      });

      console.log(`⚡ Processed ${processedData.length} records in ${metric.duration}ms`);
      return processedData;
    } else {
      // Fallback to standard processing
      return await downloadAndProcessFHIR(downloadLink, orgConnectionId, externalId);
    }
  } catch (error) {
    perfMonitor.endTimer(opId, { error: error.message });
    throw error;
  }
}

// Stream processing for large FHIR exports
async function streamProcessFHIR(downloadLink, orgConnectionId, externalId) {
  const auth = Buffer.from(`${FASTEN_PUBLIC_KEY}:${FASTEN_PRIVATE_KEY}`).toString('base64');
  
  const response = await fetch(downloadLink, {
    method: 'GET',
    headers: { 
      'Accept': 'application/jsonl',
      'Authorization': `Basic ${auth}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const processedRecords = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    // Process complete lines in batches
    const batch = [];
    for (const line of lines) {
      if (line.trim()) {
        try {
          const resource = JSON.parse(line);
          batch.push(transformForFoundry([resource], orgConnectionId, externalId)[0]);
          
          if (batch.length >= OPTIMIZATION_CONFIG.processing.batchSize) {
            processedRecords.push(...batch);
            batch.length = 0;
          }
        } catch (error) {
          console.error(`Failed to parse FHIR resource: ${error.message}`);
        }
      }
    }
    
    if (batch.length > 0) {
      processedRecords.push(...batch);
    }
  }

  // Process any remaining data in buffer
  if (buffer.trim()) {
    try {
      const resource = JSON.parse(buffer);
      processedRecords.push(transformForFoundry([resource], orgConnectionId, externalId)[0]);
    } catch (error) {
      console.error(`Failed to parse final FHIR resource: ${error.message}`);
    }
  }

  return processedRecords;
}

// Cache implementation for Foundry data
class FoundryCache {
  constructor(ttlMs = OPTIMIZATION_CONFIG.foundry.cacheTTLMs) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  set(key, value) {
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  clear() {
    this.cache.clear();
  }
}

// Export optimized components
module.exports = {
  OPTIMIZATION_CONFIG,
  PerformanceMonitor,
  optimizedTriggerExport,
  optimizedProcessFHIR,
  streamProcessFHIR,
  FoundryCache
};
