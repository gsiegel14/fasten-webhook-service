const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'fasten-webhook-service'
  });
});

// Main webhook endpoint for Fasten Connect
app.post('/webhook/fasten', (req, res) => {
  const timestamp = new Date().toISOString();
  
  console.log(`\n=== Fasten Webhook Event Received (${timestamp}) ===`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=== End Webhook Event ===\n');
  
  // Extract useful information from the webhook
  const { event_type, patient_id, resource_type, resource_id } = req.body;
  
  // Log structured event data
  if (event_type) {
    console.log(`Event Type: ${event_type}`);
    if (patient_id) console.log(`Patient ID: ${patient_id}`);
    if (resource_type) console.log(`Resource Type: ${resource_type}`);
    if (resource_id) console.log(`Resource ID: ${resource_id}`);
  }
  
  // TODO: In production, you would:
  // 1. Validate the webhook signature (if Fasten provides one)
  // 2. Store the event in a database
  // 3. Trigger any business logic (notifications, sync, etc.)
  // 4. Forward to your main backend if needed
  
  // Respond with 200 OK to acknowledge receipt
  res.status(200).json({ 
    received: true, 
    timestamp,
    message: 'Webhook event processed successfully'
  });
});

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
