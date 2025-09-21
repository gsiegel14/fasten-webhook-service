// Foundry Integration Module for Fasten Webhook Service
// Updated version with proper authentication for Fasten API downloads

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// In-memory storage for processed FHIR data (replace with database in production)
const foundryDataStore = new Map(); // user_id -> Array<FoundryRecord>

/**
 * Download and process FHIR data from Fasten export with proper authentication
 */
async function downloadAndProcessFHIR(downloadLink, orgConnectionId, externalId) {
  try {
    console.log(`📥 Downloading FHIR data from: ${downloadLink}`);
    
    // Check if credentials are configured
    if (!process.env.FASTEN_PUBLIC_KEY || !process.env.FASTEN_PRIVATE_KEY) {
      console.warn('⚠️ FASTEN_PUBLIC_KEY or FASTEN_PRIVATE_KEY not configured');
      console.warn('⚠️ Attempting download without authentication (may fail)');
    }
    
    // Prepare authentication if credentials are available
    const authConfig = {};
    if (process.env.FASTEN_PUBLIC_KEY && process.env.FASTEN_PRIVATE_KEY) {
      authConfig.auth = {
        username: process.env.FASTEN_PUBLIC_KEY,
        password: process.env.FASTEN_PRIVATE_KEY
      };
      console.log('🔐 Using Basic Authentication for download');
    }
    
    // Download with authentication
    const response = await axios.get(downloadLink, {
      ...authConfig,
      responseType: 'text',
      timeout: 60000, // 60 second timeout
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      headers: {
        'Accept': 'application/x-ndjson, application/json'
      }
    });
    
    const jsonlContent = response.data;
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
    
    // Log resource type distribution for monitoring
    const resourceTypes = {};
    fhirResources.forEach(r => {
      resourceTypes[r.resourceType] = (resourceTypes[r.resourceType] || 0) + 1;
    });
    console.log('📊 Resource distribution:', resourceTypes);
    
    // Transform for Foundry ingestion
    const foundryRecords = transformForFoundry(fhirResources, orgConnectionId, externalId);
    
    // Store for Foundry to pull
    await storeForFoundryIngestion(externalId, foundryRecords);
    
    return foundryRecords;
    
  } catch (error) {
    console.error('❌ Error processing FHIR data:', error.message);
    
    // Log specific error types for debugging
    if (error.response) {
      console.error('Response error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers
      });
      
      if (error.response.status === 401) {
        console.error('🔐 Authentication failed - check FASTEN_PUBLIC_KEY and FASTEN_PRIVATE_KEY');
      } else if (error.response.status === 403) {
        console.error('🚫 Access forbidden - credentials may not have permission for this resource');
      } else if (error.response.status === 404) {
        console.error('❓ Download link not found - it may have expired');
      }
    } else if (error.request) {
      console.error('❌ No response received - network or timeout issue');
    }
    
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
}

/**
 * Get all Foundry-ready data (called by Foundry connector)
 */
function getAllFoundryData() {
  const allData = [];
  
  for (const [userId, records] of foundryDataStore.entries()) {
    allData.push(...records);
  }
  
  return allData;
}

/**
 * Get data for specific user
 */
function getFoundryDataForUser(externalId) {
  return foundryDataStore.get(externalId) || [];
}

/**
 * Clear processed data (for testing or cleanup)
 */
function clearProcessedData(externalId = null) {
  if (externalId) {
    foundryDataStore.delete(externalId);
    console.log(`🗑️ Cleared data for user: ${externalId}`);
  } else {
    foundryDataStore.clear();
    console.log(`🗑️ Cleared all processed data`);
  }
}

/**
 * Get ingestion statistics
 */
function getIngestionStats() {
  const stats = {
    total_users: foundryDataStore.size,
    total_records: 0,
    users: {}
  };
  
  for (const [userId, records] of foundryDataStore.entries()) {
    stats.total_records += records.length;
    stats.users[userId] = {
      record_count: records.length,
      resource_types: {}
    };
    
    // Count resource types per user
    records.forEach(record => {
      const resourceType = record.resource_type;
      stats.users[userId].resource_types[resourceType] = 
        (stats.users[userId].resource_types[resourceType] || 0) + 1;
    });
  }
  
  return stats;
}

module.exports = {
  downloadAndProcessFHIR,
  getAllFoundryData,
  getFoundryDataForUser,
  clearProcessedData,
  getIngestionStats
};
