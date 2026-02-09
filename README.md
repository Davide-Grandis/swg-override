# coaching-page

A Cloudflare Worker that serves as a user-coaching interstitial for Cloudflare Gateway HTTP redirect policies. When a Gateway HTTP policy triggers a redirect, this Worker displays a warning page, collects a mandatory business justification, creates a per-user identity exception on the originating rule, and provides an admin dashboard for reviewing justification records.

## Architecture

```
User Request ──► Gateway HTTP Policy (REDIRECT + policy context)
                        │
                        ▼
                 coaching-page Worker
                        │
          ┌─────────────┼─────────────────┐
          ▼             ▼                 ▼
    Render coaching   Update Gateway    Store rule ID
    page with form    rule identity     + justification
          │           exception (API)   in KV
          ▼
    User submits
    justification
          │
          ▼
    45s countdown
    expires → Proceed
          │
          ▼
    Original resource
    (no redirect on
     next visit)

Cron (daily 01:00 UTC)
    │
    ▼
  Reset all identity
  exceptions via API
    │
    ▼
  Delete rule-tracking
  KV keys (preserve
  justification records)
```

## Features

- **Coaching interstitial** — Professional warning page with personalized greeting, corporate policy language, and a mandatory business justification textarea.
- **45-second countdown timer** — Proceed button activates only after both the justification is submitted and the timer expires. Timer persists across form submission via server-side elapsed calculation.
- **Gateway rule exception** — On page load, the Worker adds the user's email to the rule's `identity` expression via the Cloudflare API so subsequent requests bypass the redirect.
- **KV tracking** — Rule IDs are stored in KV for the cron handler. Justification records are stored permanently with a `justification:<uuid>` key prefix.
- **Cron reset** — A daily scheduled handler iterates all rule-tracking KV keys, empties the identity field on each Gateway rule, and deletes the processed keys. Justification entries are preserved.
- **Admin dashboard** (`/admin`) — Displays all justification records in a sortable, searchable table. Requests without Gateway context query parameters are automatically redirected here.

## Routes

| Path | Method | Behavior |
|------|--------|----------|
| `/?cf_user_email=...&cf_site_uri=...&cf_rule_id=...` | GET | Renders coaching page, updates Gateway rule, stores rule ID in KV |
| `/` | POST | Processes justification form submission, stores justification in KV |
| `/admin` | GET | Renders admin dashboard with all justification records |
| `/*` (no query params) | GET | 302 redirect to `/admin` |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers (ES Modules) |
| Configuration | Wrangler v4 (`wrangler.jsonc`) |
| State storage | Cloudflare Workers KV |
| External API | Cloudflare API v4 (Gateway Rules) |
| Auth (API) | Global API Key (`X-Auth-Key` / `X-Auth-Email`) |
| Auth (access) | Cloudflare Access (WARP authentication identity) |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` |

## Project Structure

```
coaching-page/
├── src/
│   └── index.js              # Worker script (fetch + scheduled handlers + admin dashboard)
├── test/
│   └── index.spec.js         # Vitest test file
├── design/
│   ├── prd.md                # Product requirements document
│   ├── changerequests.md     # Pending change requests
│   ├── workhistory.md        # Completed change log
│   └── issues/               # Historical bug screenshots
├── wrangler.jsonc            # Wrangler configuration
├── vitest.config.js          # Vitest configuration
├── package.json              # Dependencies and scripts
└── README.md
```

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+
- A Cloudflare account with Gateway and Workers KV enabled

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Create a KV namespace

```sh
wrangler kv namespace create GATEWAY_RULE_IDS_KV
```

Update `wrangler.jsonc` with the returned namespace ID.

### 3. Configure secrets

```sh
wrangler secret put ACCOUNT_ID
wrangler secret put USER_EMAIL
wrangler secret put API_KEY
```

| Secret | Description |
|--------|-------------|
| `ACCOUNT_ID` | Cloudflare account ID |
| `USER_EMAIL` | Email associated with the Cloudflare API key |
| `API_KEY` | Global API key for the account |

### 4. Configure `wrangler.jsonc`

Set the custom domain, cron schedule, and KV namespace binding. The current defaults:

```jsonc
{
  "name": "coaching-page",
  "main": "src/index.js",
  "compatibility_date": "2025-05-28",
  "routes": [{ "pattern": "coaching.jdores.xyz", "custom_domain": true }],
  "triggers": { "crons": ["0 1 * * *"] },
  "kv_namespaces": [{ "binding": "GATEWAY_RULE_IDS_KV", "id": "<your-namespace-id>" }]
}
```

### 5. Create Gateway HTTP policy

In the Cloudflare Zero Trust dashboard:

1. Create an HTTP policy matching the resource categories you want to coach on.
2. Set the action to **Redirect**.
3. Set the redirect URL to the Worker's custom domain.
4. Enable **Send policy context** (provides `cf_user_email`, `cf_site_uri`, `cf_rule_id` as query parameters).

### 6. Create Cloudflare Access policies

Create two Access policies on the Worker's custom domain:

- **Coaching page** — Allow internal users via WARP authentication identity so access is seamless.
- **Admin dashboard** (`/admin`) — Restrict to authorized administrators.

## Development

```sh
npm run dev        # Start local dev server (wrangler dev)
npm test           # Run test suite (vitest)
```

## Deployment

```sh
npm run deploy     # Deploy to Cloudflare (wrangler deploy)
```

## KV Schema

**Rule tracking entries** (cleaned up by cron):

- Key: `<gateway-rule-id>`
- Value: `{ "firstTrackedAt": "<ISO 8601>", "firstUserEmail": "<email>" }`

**Justification entries** (preserved permanently):

- Key: `justification:<uuid>`
- Value: `{ "timestamp": "<ISO 8601>", "userEmail": "<email>", "ruleId": "<id>", "ruleName": "<name>", "justification": "<text>" }`

## Security Considerations

- The Worker's custom domain must be protected by Cloudflare Access to prevent unauthorized external access.
- API credentials are stored as Worker secrets (encrypted at rest), never hardcoded.
- The admin dashboard should have a separate, more restrictive Access policy.
- The `cf_site_uri` parameter is rendered as an `href` in the coaching page HTML. Access protection mitigates URL injection risk but does not eliminate it.
- Uses Global API Key authentication. Consider migrating to scoped API Tokens for least-privilege access.
- Concurrent requests for the same Gateway rule may cause race conditions in the identity field update (read-modify-write without locking).

## License

Private — internal use only.
