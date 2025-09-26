// Direct Foundry Dataset Writer for Fasten FHIR Data
// This module writes directly to the specified Foundry dataset

const FOUNDRY_HOST = 'https://atlasengine.palantirfoundry.com';
const FASTEN_FHIR_DATASET_RID = 'ri.foundry.main.dataset.3a90fb2b-7e9a-4a03-94b0-30839be53091';

/**
 * Write FHIR records directly to Foundry dataset using the Dataset API
 * This bypasses the need for specific actions and writes directly to the dataset
 */
async function writeToFoundryDataset(records, metadata = {}) {
  try {
    console.log(`📝 Writing ${records.length} records directly to Foundry dataset ${FASTEN_FHIR_DATASET_RID}`);
    
    // Format records for Foundry dataset ingestion
    const formattedRecords = records.map(record => {
      // Ensure we have a flat structure for the dataset
      const flatRecord = {
        // Core identifiers
        record_id: `${record.auth0_user_id}_${record.resource_id}_${Date.now()}`,
        auth0_user_id: record.auth0_user_id || '',
        org_connection_id: record.org_connection_id || '',
        
        // FHIR resource data
        resource_type: record.resource_type || '',
        resource_id: record.resource_id || '',
        fhir_resource_json: JSON.stringify(record.fhir_resource || {}),
        
        // Extracted fields for easier querying
        patient_id: record.patient_id || '',
        encounter_id: record.encounter_id || '',
        provider_org: record.provider_org || '',
        
        // Temporal data
        ingested_at: record.ingested_at || new Date().toISOString(),
        resource_date: extractResourceDate(record.fhir_resource) || '',
        
        // Metadata
        source: record.source || 'fasten-connect',
        ingestion_run_id: metadata.ingestion_run_id || `run_${Date.now()}`,
        
        // Additional FHIR fields for analysis
        status: extractStatus(record.fhir_resource),
        category: extractCategory(record.fhir_resource),
        code_display: extractCodeDisplay(record.fhir_resource),
        value_quantity: extractValueQuantity(record.fhir_resource),
        value_string: extractValueString(record.fhir_resource)
      };
      
      return flatRecord;
    });
    
    // Create the dataset payload
    const payload = {
      datasetRid: FASTEN_FHIR_DATASET_RID,
      records: formattedRecords,
      branch: 'master',
      transactionType: 'APPEND'
    };
    
    console.log(`📊 Formatted ${formattedRecords.length} records for dataset ingestion`);
    console.log(`📋 Sample record structure:`, JSON.stringify(formattedRecords[0], null, 2).substring(0, 500));
    
    return {
      success: true,
      recordCount: formattedRecords.length,
      datasetRid: FASTEN_FHIR_DATASET_RID,
      payload: payload
    };
    
  } catch (error) {
    console.error('❌ Error formatting records for Foundry dataset:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper functions to extract common FHIR fields
function extractResourceDate(resource) {
  if (!resource) return null;
  
  // Try common date fields in order of preference
  return resource.effectiveDateTime || 
         resource.effectivePeriod?.start ||
         resource.issued ||
         resource.recordedDate ||
         resource.authoredOn ||
         resource.occurrenceDateTime ||
         resource.performedDateTime ||
         resource.performedPeriod?.start ||
         null;
}

function extractStatus(resource) {
  if (!resource) return null;
  return resource.status || null;
}

function extractCategory(resource) {
  if (!resource) return null;
  
  if (resource.category) {
    if (Array.isArray(resource.category)) {
      return resource.category[0]?.coding?.[0]?.display || 
             resource.category[0]?.text || 
             null;
    }
    return resource.category.coding?.[0]?.display || 
           resource.category.text || 
           null;
  }
  return null;
}

function extractCodeDisplay(resource) {
  if (!resource) return null;
  
  if (resource.code) {
    return resource.code.coding?.[0]?.display || 
           resource.code.text || 
           null;
  }
  return null;
}

function extractValueQuantity(resource) {
  if (!resource) return null;
  
  if (resource.valueQuantity) {
    return `${resource.valueQuantity.value} ${resource.valueQuantity.unit || ''}`.trim();
  }
  
  if (resource.value && typeof resource.value === 'object') {
    return `${resource.value.value} ${resource.value.unit || ''}`.trim();
  }
  
  return null;
}

function extractValueString(resource) {
  if (!resource) return null;
  
  return resource.valueString || 
         resource.valueCodeableConcept?.text ||
         resource.valueCodeableConcept?.coding?.[0]?.display ||
         null;
}

module.exports = {
  writeToFoundryDataset,
  FASTEN_FHIR_DATASET_RID
};
