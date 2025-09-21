// Foundry Integration Module for Fasten Webhook Service
const fs = require('fs').promises;
const path = require('path');
const {
  authorizedFastenFetch,
  FASTEN_CONFIGURED
} = require('./fasten-api');

// Access environment variables for direct authentication
const FASTEN_PUBLIC_KEY = process.env.FASTEN_PUBLIC_KEY;
const FASTEN_PRIVATE_KEY = process.env.FASTEN_PRIVATE_KEY;

// In-memory storage for processed FHIR data (replace with database in production)
const foundryDataStore = new Map(); // user_id -> Array<FoundryRecord>
const ingestionHistory = []; // chronological list of ingested batches
const HISTORY_LIMIT = 100;

// Simplified: No complex mappings needed - just pass through raw FHIR

/**
 * Download and process FHIR data from Fasten export
 */
async function downloadAndProcessFHIR(downloadLink, orgConnectionId, externalId) {
  try {
    if (!FASTEN_CONFIGURED) {
      throw new Error('Fasten credentials are not configured; cannot download FHIR data.');
    }

    console.log(`📥 Downloading FHIR data from: ${downloadLink}`);
    
    // Use direct fetch for download URLs since they're already complete URLs
    // and may have different authentication requirements
    const auth = Buffer.from(`${FASTEN_PUBLIC_KEY}:${FASTEN_PRIVATE_KEY}`).toString('base64');
    
    const response = await fetch(downloadLink, {
      method: 'GET',
      headers: { 
        'Accept': 'application/jsonl',
        'Authorization': `Basic ${auth}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`❌ Download failed with status ${response.status}: ${errorText}`);
      throw new Error(`Failed to download FHIR data: ${response.status} ${response.statusText}`);
    }

    const jsonlContent = await response.text();
    console.log(`📄 Downloaded ${jsonlContent.length} characters of FHIR data`);
    
    // Parse JSONL (each line is a FHIR resource)
    const fhirResources = jsonlContent
      .split('\n')
      .filter(line => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          console.error(`❌ Failed to parse FHIR resource at line ${index + 1}:`, error);
          return null;
        }
      })
      .filter(resource => resource !== null);
    
    console.log(`🔍 Parsed ${fhirResources.length} FHIR resources`);
    
    // Transform for Foundry ingestion
    const foundryRecords = transformForFoundry(fhirResources, orgConnectionId, externalId);
    
    // Store for Foundry to pull
    await storeForFoundryIngestion(externalId, orgConnectionId, foundryRecords, jsonlContent);

    return foundryRecords;

  } catch (error) {
    console.error('❌ Error processing FHIR data:', error);
    throw error;
  }
}

/**
 * Transform FHIR resources for Foundry - SIMPLIFIED: Raw FHIR + Auth0 ID
 */
function transformForFoundry(fhirResources, orgConnectionId, externalId) {
  const timestamp = new Date().toISOString();
  
  return fhirResources.map(resource => {
    // Keep the original FHIR resource intact, just add our metadata
    return {
      // Auth0 user identifier
      auth0_user_id: externalId,
      
      // Fasten connection info
      org_connection_id: orgConnectionId,
      
      // Timestamps
      ingested_at: timestamp,
      
      // Raw FHIR resource (unchanged)
      fhir_resource: resource,
      
      // Basic identifiers for indexing
      resource_type: resource.resourceType,
      resource_id: resource.id,
      
      // Source tracking
      source: 'fasten-connect'
    };
  });
}

// extractPatientId removed - not needed for raw FHIR pass-through

/**
 * Store processed data for Foundry ingestion
 */
async function storeForFoundryIngestion(externalId, orgConnectionId, foundryRecords, rawPayload = null) {
  if (!foundryDataStore.has(externalId)) {
    foundryDataStore.set(externalId, []);
  }
  
  const userRecords = foundryDataStore.get(externalId);
  userRecords.push(...foundryRecords);

  console.log(`💾 Stored ${foundryRecords.length} records for user ${externalId}`);
  console.log(`📊 Total records for user: ${userRecords.length}`);

  // Log resource type breakdown
  const resourceTypes = {};
  foundryRecords.forEach(record => {
    resourceTypes[record.resource_type] = (resourceTypes[record.resource_type] || 0) + 1;
  });
  console.log(`📋 Resource types processed:`, resourceTypes);

  const batchSnapshot = {
    external_id: externalId,
    org_connection_id: orgConnectionId,
    ingested_at: new Date().toISOString(),
    record_count: foundryRecords.length,
    resource_types: resourceTypes,
    raw_payload_preview: rawPayload ? rawPayload.slice(0, 2048) : null
  };

  ingestionHistory.push(batchSnapshot);
  if (ingestionHistory.length > HISTORY_LIMIT) {
    ingestionHistory.splice(0, ingestionHistory.length - HISTORY_LIMIT);
  }
}

/**
 * Get all Foundry data for ingestion (called by Foundry)
 */
function getAllFoundryData() {
  const allRecords = [];
  
  for (const [userId, records] of foundryDataStore.entries()) {
    allRecords.push(...records);
  }
  
  return allRecords;
}

/**
 * Get Foundry data for specific user
 */
function getFoundryDataForUser(externalId) {
  return foundryDataStore.get(externalId) || [];
}

function getFoundryDataHistory() {
  return [...ingestionHistory];
}

/**
 * Clear processed data after successful Foundry ingestion
 */
function clearProcessedData(externalId = null) {
  if (externalId) {
    foundryDataStore.delete(externalId);
    for (let index = ingestionHistory.length - 1; index >= 0; index -= 1) {
      if (ingestionHistory[index].external_id === externalId) {
        ingestionHistory.splice(index, 1);
      }
    }
    console.log(`🧹 Cleared data for user: ${externalId}`);
  } else {
    foundryDataStore.clear();
    ingestionHistory.length = 0;
    console.log(`🧹 Cleared all processed data`);
  }
}

/**
 * Get ingestion statistics
 */
function getIngestionStats() {
  let totalRecords = 0;
  let totalUsers = foundryDataStore.size;
  const resourceTypeCounts = {};
  
  for (const records of foundryDataStore.values()) {
    totalRecords += records.length;
    
    records.forEach(record => {
      resourceTypeCounts[record.resource_type] = 
        (resourceTypeCounts[record.resource_type] || 0) + 1;
    });
  }
  
  return {
    totalUsers,
    totalRecords,
    resourceTypeCounts,
    historyBatches: ingestionHistory.length,
    lastUpdated: new Date().toISOString()
  };
}

module.exports = {
  downloadAndProcessFHIR,
  transformForFoundry,
  storeForFoundryIngestion,
  getAllFoundryData,
  getFoundryDataForUser,
  getFoundryDataHistory,
  clearProcessedData,
  getIngestionStats
};
