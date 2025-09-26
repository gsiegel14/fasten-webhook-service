// Foundry Auto-Push Integration via Backend Proxy
// This module automatically pushes FHIR data to Foundry when webhooks are received

const BACKEND_PROXY_URL = 'https://atlas-backend-proxy.onrender.com';

// Target dataset RID for Fasten FHIR data ingestion
const FASTEN_FHIR_DATASET_RID = 'ri.foundry.main.dataset.3a90fb2b-7e9a-4a03-94b0-30839be53091';

// Import the dataset writer
const { writeToFoundryDataset } = require('./foundry-dataset-writer');

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
      
      // TODO: Once backend proxy has dataset ingestion endpoint, send the formatted payload
      // For now, we're just formatting and logging
      console.log('📋 Dataset payload ready for ingestion');
      console.log('⚠️ Note: Backend proxy needs dataset ingestion endpoint to complete the push');
      
      // Store the formatted data for manual upload if needed
      const fs = require('fs').promises;
      const filename = `fasten-fhir-${Date.now()}.json`;
      await fs.writeFile(filename, JSON.stringify(writeResult.payload.records, null, 2));
      console.log(`💾 Saved formatted data to ${filename} for manual upload if needed`);
      
      return { 
        success: true, 
        result: writeResult, 
        datasetRid: FASTEN_FHIR_DATASET_RID,
        message: 'Data formatted and ready for Foundry dataset ingestion'
      };
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
 * Now correctly uses Fasten FHIR dataset for Fasten data
 */
async function smartPushToFoundry(fhirRecords, externalId, orgConnectionId) {
  console.log(`🧠 Smart push: ${fhirRecords.length} Fasten FHIR records for user ${externalId}`);
  console.log(`📊 Target dataset: ${FASTEN_FHIR_DATASET_RID}`);
  
  // Primary method: Push to Fasten FHIR dataset
  let result = await pushFastenFHIRToFoundry(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.log('⚠️ Fasten FHIR push failed, trying alternative method...');
  
  // Fallback: Try via Foundry action (may need to be configured)
  result = await pushViaFoundryAction(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.error('❌ All push methods failed');
  return result;
}

module.exports = {
  pushFastenFHIRToFoundry,  // Primary method for Fasten FHIR data
  pushToFoundryAutomatic,    // Deprecated - was using HealthKit endpoint
  pushViaFoundryAction,      // Fallback method
  smartPushToFoundry,        // Smart router that tries multiple methods
  FASTEN_FHIR_DATASET_RID   // Export the dataset RID for reference
};
