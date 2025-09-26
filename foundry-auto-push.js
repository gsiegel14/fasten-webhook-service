// Foundry Auto-Push Integration via Backend Proxy
// This module automatically pushes FHIR data to Foundry when webhooks are received

const BACKEND_PROXY_URL = 'https://atlas-backend-proxy.onrender.com';

/**
 * Automatically push FHIR data to Foundry via backend proxy
 */
async function pushToFoundryAutomatic(fhirRecords, externalId, orgConnectionId) {
  try {
    console.log(`🚀 Auto-pushing ${fhirRecords.length} FHIR records to Foundry...`);
    
    // Transform data for HealthKit action format
    const payload = {
      auth0id: externalId,
      rawhealthkit: Buffer.from(JSON.stringify(fhirRecords)).toString('base64'),
      timestamp: new Date().toISOString(),
      device: 'fasten-webhook-auto',
      recordCount: fhirRecords.length,
      manifest: {
        ingestionRunId: `fasten-auto-${Date.now()}`,
        anchorTimestamp: new Date().toISOString(),
        source: 'fasten-connect-auto',
        orgConnectionId: orgConnectionId,
        externalId: externalId
      }
    };

    // Push to backend proxy's HealthKit endpoint
    const response = await fetch(`${BACKEND_PROXY_URL}/api/v1/healthkit/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Note: Backend proxy will need to accept service-to-service calls
        // or we need to add authentication here
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('✅ Successfully auto-pushed to Foundry via backend proxy');
      console.log('📊 Foundry response:', result);
      return { success: true, result };
    } else {
      const errorText = await response.text();
      console.error('❌ Backend proxy push failed:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
  } catch (error) {
    console.error('❌ Error auto-pushing to backend proxy:', error);
    return { success: false, error: error.message };
  }
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
 */
async function smartPushToFoundry(fhirRecords, externalId, orgConnectionId) {
  console.log(`🧠 Smart push: ${fhirRecords.length} records for user ${externalId}`);
  
  // Try method 1: HealthKit export endpoint
  let result = await pushToFoundryAutomatic(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.log('⚠️ Method 1 failed, trying Foundry action...');
  
  // Try method 2: Direct Foundry action
  result = await pushViaFoundryAction(fhirRecords, externalId, orgConnectionId);
  if (result.success) {
    return result;
  }
  
  console.error('❌ All push methods failed');
  return result;
}

module.exports = {
  pushToFoundryAutomatic,
  pushViaFoundryAction,
  smartPushToFoundry
};
