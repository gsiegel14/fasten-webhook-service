# How to Get Your Fasten Webhook Secret

## The Missing Piece: `FASTEN_WEBHOOK_SECRET`

You mentioned you have the Fasten API credentials (`FASTEN_PUBLIC_KEY` and `FASTEN_PRIVATE_KEY`) configured in your backend service, but you're missing the `FASTEN_WEBHOOK_SECRET`. 

This is a **separate secret** specifically for webhook signature verification.

## Where to Find Your Webhook Secret

### 1. Log into Fasten Developer Portal
Go to: https://connect.fastenhealth.com/developer

### 2. Navigate to Webhooks Section
- Click on "Webhooks" in the left sidebar
- You should see your configured webhook endpoint(s)

### 3. Get the Signing Secret
- Click on your webhook endpoint (the one pointing to `https://fasten-webhook-service.onrender.com/webhook/fasten`)
- Look for "Signing Secret" or "Webhook Secret"
- It will look something like: `whsec_xxxxxxxxxxxxxxxxxxxxx`

### 4. Important Notes
- **This secret is unique per webhook endpoint** - each webhook you create has its own signing secret
- **It's different from your API keys** - don't confuse it with your public/private API keys
- **It may be hidden by default** - you might need to click "Show" or "Reveal" to see it

## Current Status

From the logs, I can see:
- ✅ Fasten IS sending webhook signatures (header: `webhook-signature`)
- ✅ Your service IS receiving the webhooks
- ⚠️ BUT signature verification is being skipped because `FASTEN_WEBHOOK_SECRET` is not set

Example from your logs:
```
"webhook-signature": "v1,EtSObtaa/VhbL2TO0sLkkBEVMSqL97oEw/Y82zwOy4k="
"webhook-timestamp": "1758487698"
```

## Add to Render Service

Once you have the secret from the Fasten portal:

1. Go to your [Render Dashboard](https://dashboard.render.com/web/srv-d364tjje5dus73dsgrg0)
2. Click "Environment" → "Add Environment Variable"
3. Add:
   ```
   Key: FASTEN_WEBHOOK_SECRET
   Value: whsec_xxxxxxxxxxxxxxxxxxxxx (your actual secret)
   ```
4. Save and the service will auto-deploy

## Security Impact

Without webhook signature verification:
- ⚠️ **Security Risk**: Anyone could send fake webhook events to your endpoint
- ⚠️ **Data Integrity**: You can't guarantee the webhooks are actually from Fasten
- ✅ **Still Working**: The service functions but without security validation

## Testing After Configuration

After adding the secret, check the logs for:
- "🔐 Webhook signature verification passed" (if you add this log)
- No more "Webhook signature verification failed" errors
- Continued successful processing of events

## If You Can't Find the Secret

If the webhook secret isn't visible in the Fasten Developer Portal:
1. **Create a new webhook** - the secret is shown when you first create it
2. **Contact Fasten Support** - they can help you retrieve or reset the secret
3. **Check your email** - sometimes the secret is emailed when the webhook is created

## Alternative: Temporarily Disable Verification (NOT Recommended)

If you need to continue development without the secret, you could modify the code to skip verification, but this should ONLY be done in development:

```javascript
// In server.js, line 267-272
const secret = process.env.FASTEN_WEBHOOK_SECRET;

if (secret && !verifyWebhookSignature(req.rawBody, req.headers, secret)) {
  console.log('❌ Webhook signature verification failed');
  // For development only - comment out the return to skip verification
  // return res.status(401).json({ error: 'Invalid signature' });
  console.warn('⚠️ DEVELOPMENT MODE: Skipping signature verification');
}
```

**But the proper solution is to get and configure the webhook secret!**
