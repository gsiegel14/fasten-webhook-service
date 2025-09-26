// Foundry Auto-Push Integration via Backend Proxy
// This module automatically pushes FHIR data to Foundry when webhooks are received

const BACKEND_PROXY_URL = process.env.BACKEND_PROXY_URL || 'https://atlas-backend-proxy.onrender.com';
const SERVICE_SECRET = process.env.SERVICE_SECRET || 'webhook-service-secret-2024';

// Target dataset RID for Fasten FHIR data ingestion
const FASTEN_FHIR_DATASET_RID = 'ri.foundry.main.dataset.3a90fb2b-7e9a-4a03-94b0-30839be53091';

// Import the dataset writer
const { writeToFoundryDataset } = require('./foundry-dataset-writer');

/**
 * Push Fasten FHIR data via Backend Proxy service
 * This uses the new dedicated ingestion endpoint with service authentication
 */
async function pushViaBackendService(fhirRecords, externalId, orgConnectionId) {
  try {
    console.log(`🚀 Pushing ${fhirRecords.length} FHIR records via backend service...`);
    console.log(`📊 Target dataset: ${FASTEN_FHIR_DATASET_RID}`);
    
    // Prepare the payload for backend proxy
    const payload = {
      records: fhirRecords,
      auth0_user_id: externalId,
      metadata: {
        ingestion_run_id: `fasten-${Date.now()}`,
        org_connection_id: orgConnectionId,
        source: 'fasten-webhook-service',
        timestamp: new Date().toISOString(),
        total_records: fhirRecords.length
      }
    };
    
    // Call the backend proxy ingestion endpoint
    const response = await fetch(`${BACKEND_PROXY_URL}/api/v1/fasten/fhir/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Secret': SERVICE_SECRET,
        'X-Correlation-ID': `fasten-${Date.now()}`
      },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`✅ Successfully pushed ${fhirRecords.length} records to Foundry!`);
      console.log(`📊 Transaction RID: ${result.transaction_rid}`);
      console.log(`📊 Dataset RID: ${result.dataset_rid}`);
      return {
        success: true,
        result: result,
        datasetRid: result.dataset_rid,
        transactionRid: result.transaction_rid,
        recordsIngested: result.records_ingested,
        message: 'Data successfully ingested to Foundry via backend service'
      };
    } else {
      const errorText = await response.text();
      console.error('❌ Backend service ingestion failed:', response.status, errorText);
      return {
        success: false,
        error: `Backend service error: ${response.status} - ${errorText}`
      };
    }
  } catch (error) {
    console.error('❌ Error calling backend service:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Push Fasten FHIR data directly to Foundry dataset
 * This is separate from HealthKit data and goes to a different dataset
 */
async function pushFastenFHIRToFoundry(fhirRecords, externalId, orgConnectionId) {
  try {
    console.log(`🚀 Pushing ${fhirRecords.length} Fasten FHIR records to dataset ${FASTEN_FHIR_DATASET_RID}...`);
    
    // Transform FHIR records for dataset ingestion
    const datasetRecords = fhirRecords.map(record => ({
      // User identification
      auth0_user_id: externalId,
      org_connection_id: orgConnectionId,
      
      // FHIR data
      fhir_resource: record.fhir_resource || record,
      resource_type: record.resource_type || record.fhir_resource?.resourceType,
      resource_id: record.resource_id || record.fhir_resource?.id,
      
      // Metadata
      ingested_at: new Date().toISOString(),
      source: 'fasten-connect',
      
      // Additional fields for analysis
      patient_id: extractPatientId(record),
      encounter_id: extractEncounterId(record),
      provider_org: extractProviderOrg(record)
    }));

    // Use the dataset writer to format records
    const writeResult = await writeToFoundryDataset(datasetRecords, {
      ingestion_run_id: `fasten-fhir-${Date.now()}`,
      user_id: externalId,
      connection_id: orgConnectionId
    });

    if (writeResult.success) {
      console.log(`✅ Successfully formatted ${writeResult.recordCount} Fasten FHIR records for dataset ${FASTEN_FHIR_DATASET_RID}`);
      
      // Push to backend proxy's Fasten dataset upload endpoint (uses Datasets API directly)
      try {
        const response = await fetch(`${BACKEND_PROXY_URL}/api/v1/fasten/datasets/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Note: This endpoint requires Auth0 token with execute:actions scope
          },
          body: JSON.stringify({
            records: writeResult.payload.records,
            metadata: {
              ingestion_run_id: writeResult.payload.metadata?.ingestion_run_id,
              user_id: externalId,
              connection_id: orgConnectionId,
              total_records: writeResult.recordCount,
              timestamp: new Date().toISOString()
            }
          })
        });

        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Successfully pushed ${writeResult.recordCount} records to Foundry dataset!`);
          console.log(`📊 Dataset RID: ${FASTEN_FHIR_DATASET_RID}`);
          return { 
            success: true, 
            result: result, 
            datasetRid: FASTEN_FHIR_DATASET_RID,
            recordsIngested: writeResult.recordCount,
            message: 'Data successfully ingested to Foundry dataset'
          };
        } else {
          const errorText = await response.text();
          console.error('❌ Backend proxy dataset ingestion failed:', response.status, errorText);
          
          // Fallback: Save formatted data for manual upload
          const fs = require('fs').promises;
          const filename = `fasten-fhir-${Date.now()}.json`;
          await fs.writeFile(filename, JSON.stringify(writeResult.payload.records, null, 2));
          console.log(`💾 Saved formatted data to ${filename} for manual upload`);
          
          return { 
            success: false, 
            error: `Backend proxy error: ${errorText}`,
            dataFormatted: true,
            savedFile: filename
          };
        }
      } catch (error) {
        console.error('❌ Error calling backend proxy:', error);
        
        // Fallback: Save formatted data for manual upload
        const fs = require('fs').promises;
        const filename = `fasten-fhir-${Date.now()}.json`;
        await fs.writeFile(filename, JSON.stringify(writeResult.payload.records, null, 2));
        console.log(`💾 Saved formatted data to ${filename} for manual upload`);
        
        return { 
          success: false, 
          error: error.message,
          dataFormatted: true,
          savedFile: filename
        };
      }
    } else {
      console.error('❌ Failed to format data for Foundry dataset:', writeResult.error);
      return { success: false, error: writeResult.error };
    }
  } catch (error) {
    console.error('❌ Error pushing Fasten FHIR to Foundry:', error);
    return { success: false, error: error.message };
  }
}

// Helper functions to extract key fields from FHIR resources
function extractPatientId(record) {
  const resource = record.fhir_resource || record;
  if (resource.subject?.reference) {
    return resource.subject.reference.replace('Patient/', '');
  }
  if (resource.patient?.reference) {
    return resource.patient.reference.replace('Patient/', '');
  }
  if (resource.resourceType === 'Patient') {
    return resource.id;
  }
  return null;
}

function extractEncounterId(record) {
  const resource = record.fhir_resource || record;
  if (resource.encounter?.reference) {
    return resource.encounter.reference.replace('Encounter/', '');
  }
  if (resource.resourceType === 'Encounter') {
    return resource.id;
  }
  return null;
}

function extractProviderOrg(record) {
  const resource = record.fhir_resource || record;
  if (resource.performer?.[0]?.reference) {
    return resource.performer[0].reference;
  }
  if (resource.organization?.reference) {
    return resource.organization.reference;
  }
  if (resource.resourceType === 'Organization') {
    return resource.name || resource.id;
  }
  return null;
}

/**
 * DEPRECATED: This was using HealthKit endpoint incorrectly
 * Use pushFastenFHIRToFoundry instead
 */
async function pushToFoundryAutomatic(fhirRecords, externalId, orgConnectionId) {
  console.log('⚠️ DEPRECATED: pushToFoundryAutomatic uses HealthKit endpoint. Using pushFastenFHIRToFoundry instead.');
  return pushFastenFHIRToFoundry(fhirRecords, externalId, orgConnectionId);
}

/**
 * Alternative: Push via Foundry action directly
 */
async function pushViaFoundryAction(fhirRecords, externalId, orgConnectionId) {
  try {
    console.log(`🎯 Pushing via Foundry action: create-healthkit-raw`);
    
    const actionPayload = {
      auth0id: externalId,
      rawhealthkit: Buffer.from(JSON.stringify(fhirRecords)).toString('base64'),
      timestamp: new Date().toISOString(),
      device: 'fasten-webhook'
    };

    const response = await fetch(`${BACKEND_PROXY_URL}/api/v1/foundry/actions/create-healthkit-raw/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(actionPayload)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('✅ Foundry action completed successfully');
      return { success: true, result };
    } else {
      const errorText = await response.text();
      console.error('❌ Foundry action failed:', response.status, errorText);
      return { success: false, error: `Action failed: ${errorText}` };
    }
  } catch (error) {
    console.error('❌ Error invoking Foundry action:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Smart push - tries multiple methods for reliability
 * Primary method is now the backend service with proper authentication
 */
async function smartPushToFoundry(fhirRecords, externalId, orgConnectionId) {
  console.log(`🧠 Smart push: ${fhirRecords.length} Fasten FHIR records for user ${externalId}`);
  console.log(`📊 Target dataset: ${FASTEN_FHIR_DATASET_RID}`);
  
  // Primary method: Push via backend service with authentication
  let result = await pushViaBackendService(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.log('⚠️ Backend service push failed, trying direct dataset push...');
  
  // Fallback 1: Try direct dataset push (if backend service is down)
  result = await pushFastenFHIRToFoundry(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.log('⚠️ Direct push failed, trying Foundry action...');
  
  // Fallback 2: Try via Foundry action
  result = await pushViaFoundryAction(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.error('❌ All push methods failed');
  return result;
}

module.exports = {
  pushViaBackendService,     // PRIMARY: Backend service with auth
  pushFastenFHIRToFoundry,   // Fallback 1: Direct dataset push
  pushViaFoundryAction,      // Fallback 2: Foundry action
  pushToFoundryAutomatic,    // Deprecated - was using HealthKit endpoint
  smartPushToFoundry,        // Smart router that tries multiple methods
  FASTEN_FHIR_DATASET_RID   // Export the dataset RID for reference
};
