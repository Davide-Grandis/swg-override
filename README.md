# swg-rule-override

Cloudflare Worker that intercepts Gateway block pages, collects a business justification from the user, and temporarily exempts them from the rule by updating the identity filter.

## Requirements

### Cloudflare Resources
- **Worker**: deployed via Wrangler as `swg-rule-override`
- **D1 Database**: `swg-rule-override-db` — stores justification logs and tracked rule IDs
- **R2 Bucket**: `swg-rule-override-assets` — serves static assets (logo, etc.) via public domain
- **Custom Domain**: `override.davideslab.eu` mapped to the Worker

### API Token
A Cloudflare API Token is required with the following permission:

- **Account → Zero Trust → Edit**

This allows the Worker to GET and PUT Gateway firewall rules to update the `identity` field (exempting a user's email from the block rule).

Set it as a Worker secret:
```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put ACCOUNT_ID
```

### Environment Secrets
| Secret | Description |
|---|---|
| `API_TOKEN` | Cloudflare API Token with Zero Trust Edit permission |
| `ACCOUNT_ID` | Cloudflare Account ID |

## Deployment

```bash
npm run deploy
```

## Admin Dashboard

Available at `https://override.davideslab.eu/admin`

- View all justification submissions
- Live auto-refresh every 30 seconds
- Search and sort records
- Settings: purge tracked rules (resets Gateway rule identity), clear logs
