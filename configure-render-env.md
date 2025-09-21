# Configure Render Environment Variables

## Quick Setup Guide

To properly configure the Fasten webhook service on Render, you need to add the following environment variables:

### Step 1: Get Your Credentials

1. **Fasten Developer Portal**
   - Log in to [Fasten Developer Portal](https://connect.fastenhealth.com/developer)
   - Note your Public ID (starts with `public_live_` or `public_test_`)
   - Note your Private Key (starts with `private_live_` or `private_test_`)
   - Find your webhook's Signing Secret (shown when editing the webhook)

### Step 2: Add to Render

1. Go to your [Render Dashboard](https://dashboard.render.com/web/srv-d364tjje5dus73dsgrg0)
2. Click on "Environment" in the left sidebar
3. Add the following environment variables:

```bash
# Required - Webhook Security
FASTEN_WEBHOOK_SECRET=<your_webhook_signing_secret>

# Required - API Authentication  
FASTEN_PUBLIC_KEY=<your_public_key>
FASTEN_PRIVATE_KEY=<your_private_key>

# Optional but Recommended
EXPORT_TIMEOUT_MS=3600000
LOG_LEVEL=info
```

### Step 3: Deploy Changes

After adding the environment variables, the service will automatically redeploy with the new configuration.

## Verification

To verify the configuration is working:

1. Check the service logs for successful webhook signature verification
2. Monitor for successful export downloads
3. Use the `/health` endpoint to verify service status

## Current Missing Variables

As of September 21, 2025, the following critical variables are NOT configured:
- ❌ `FASTEN_WEBHOOK_SECRET` - Webhook signatures not being verified
- ❌ `FASTEN_PUBLIC_KEY` - Cannot authenticate API calls
- ❌ `FASTEN_PRIVATE_KEY` - Cannot download export files

## Support

If you need the actual credentials:
1. Check with the team lead for production credentials
2. For test credentials, create a test account at [Fasten Connect](https://connect.fastenhealth.com)
3. Store credentials securely and never commit them to the repository
