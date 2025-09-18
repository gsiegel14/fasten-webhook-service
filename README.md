# Fasten Connect Webhook Service

A lightweight webhook endpoint service for receiving Fasten Connect events in your Atlas iOS app integration.

## Overview

This service provides an HTTPS webhook endpoint that Fasten Connect can call when health record events occur. Since iOS apps cannot directly receive webhook callbacks, this service acts as an intermediary that can:

- Receive and log webhook events from Fasten
- Validate webhook signatures (when implemented)
- Store events for later processing
- Forward events to your main backend
- Trigger notifications or other business logic

## Endpoints

- `POST /webhook/fasten` - Main webhook endpoint for Fasten Connect
- `POST /webhook/test` - Test endpoint for debugging
- `GET /health` - Health check endpoint
- `POST /webhook/*` - Catch-all for other webhook paths

## Environment Variables

- `PORT` - Port to run the service on (default: 8080)

## Local Development

```bash
npm install
npm start
```

The service will be available at `http://localhost:8080`

## Deployment

This service is designed to be deployed on Render.com or similar platforms.

## Webhook Configuration

1. Deploy this service to get an HTTPS URL
2. Register the webhook URL in the Fasten developer portal:
   - Webhook URL: `https://your-service.onrender.com/webhook/fasten`
3. The iOS app will trigger Fasten Connect flows, and events will be sent to this endpoint

## Event Handling

Currently, the service logs all incoming webhook events. In production, you should:

1. Validate webhook signatures for security
2. Store events in a database
3. Implement business logic for different event types
4. Forward events to your main backend if needed
5. Handle errors and retries appropriately

## Security Considerations

- Add webhook signature validation
- Implement rate limiting
- Add authentication if forwarding to other services
- Validate and sanitize incoming data
- Use HTTPS in production (handled automatically by Render)

## Integration with Atlas iOS

The iOS app doesn't need any changes - it will continue to use the existing Fasten Connect flow. This webhook service operates independently and receives events when users complete actions in Fasten.
