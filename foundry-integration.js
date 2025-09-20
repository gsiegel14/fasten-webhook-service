// Foundry Integration Module for Fasten Webhook Service
const fs = require('fs').promises;
const path = require('path');

// In-memory storage for processed FHIR data (replace with database in production)
const foundryDataStore = new Map(); // user_id -> Array<FoundryRecord>

// Simplified: No complex mappings needed - just pass through raw FHIR

/**
 * Download and process FHIR data from Fasten export
 */
async function downloadAndProcessFHIR(downloadLink, orgConnectionId, externalId) {
  try {
    console.log(`📥 Downloading FHIR data from: ${downloadLink}`);
    
    const response = await fetch(downloadLink);
    if (!response.ok) {
      throw new Error(`Failed to download FHIR data: ${response.statusText}`);
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
    await storeForFoundryIngestion(externalId, foundryRecords);
    
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
async function storeForFoundryIngestion(externalId, foundryRecords) {
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

/**
 * Clear processed data after successful Foundry ingestion
 */
function clearProcessedData(externalId = null) {
  if (externalId) {
    foundryDataStore.delete(externalId);
    console.log(`🧹 Cleared data for user: ${externalId}`);
  } else {
    foundryDataStore.clear();
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
    lastUpdated: new Date().toISOString()
  };
}

module.exports = {
  downloadAndProcessFHIR,
  transformForFoundry,
  storeForFoundryIngestion,
  getAllFoundryData,
  getFoundryDataForUser,
  clearProcessedData,
  getIngestionStats
};
