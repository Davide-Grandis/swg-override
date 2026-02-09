# Product Requirements Document: Coaching Page Worker

## 1. Overview

**Project Name:** coaching-page
**Type:** Cloudflare Worker (JavaScript)
**Custom Domain:** `coaching.jdores.xyz`
**Version:** 0.0.0

The Coaching Page Worker is a Cloudflare Workers application that serves as a user-coaching interstitial page for Cloudflare Gateway HTTP policies. When a user attempts to access a resource matched by a Gateway HTTP policy configured with the REDIRECT action, they are redirected to this Worker. The Worker displays a warning/coaching page informing the user that their access is being monitored, and provides a "Proceed to site" link. In the background, it creates a per-user identity exception on the originating Gateway rule so the user is not shown the coaching page again on subsequent visits — until a scheduled cron job resets all exceptions.

## 2. Problem Statement

Organizations using Cloudflare Gateway need a mechanism to coach users before they access certain web resources (e.g., risky categories, sensitive sites). The built-in Gateway block page does not support a "warn and allow" workflow where the user is informed but can still proceed. This Worker fills that gap by acting as a redirect target that:

1. Warns the user that access is logged.
2. Allows the user to proceed to the original resource.
3. Automatically creates a Gateway rule exception so the coaching page is shown only once per reset cycle.

## 3. Architecture

### 3.1 High-Level Flow

```
User Request ──► Gateway HTTP Policy (REDIRECT) ──► coaching-page Worker
                                                          │
                                          ┌───────────────┼───────────────┐
                                          ▼               ▼               ▼
                                   Render HTML     Update Gateway     Store rule ID
                                   coaching page   rule identity      in KV namespace
                                          │          exception
                                          ▼
                                   User clicks
                                   "Proceed to site"
                                          │
                                          ▼
                                   Original resource
                                   (no redirect on
                                    next visit)
```

### 3.2 Cron Reset Flow

```
Cron Trigger (daily at 01:00 UTC)
        │
        ▼
  List all rule IDs from KV
        │
        ▼
  For each rule ID:
    GET rule ──► Empty identity field ──► PUT rule
        │
        ▼
  Delete all processed KV keys
```

### 3.3 Technology Stack

| Component              | Technology                                      |
|------------------------|-------------------------------------------------|
| Runtime                | Cloudflare Workers                              |
| Language               | JavaScript (ES Modules)                         |
| Configuration          | Wrangler v4 (`wrangler.jsonc`)                  |
| State Storage          | Cloudflare Workers KV (`GATEWAY_RULE_IDS_KV`)   |
| External API           | Cloudflare API v4 (Gateway Rules)               |
| Authentication         | Cloudflare API Key + Email (`X-Auth-Key` / `X-Auth-Email`) |
| Testing                | Vitest with `@cloudflare/vitest-pool-workers`   |
| Access Control         | Cloudflare Access (WARP authentication identity)|
| Observability          | Enabled via `wrangler.jsonc`                    |

### 3.4 Project Structure

```
coaching-page/
├── src/
│   └── index.js            # Main Worker script (fetch + scheduled handlers)
├── test/
│   └── index.spec.js       # Vitest test file
├── design/
│   └── prd.md              # This document
├── wrangler.jsonc           # Wrangler configuration
├── package.json             # Dependencies and scripts
├── vitest.config.js         # Vitest configuration
└── README.md                # Installation instructions
```

## 4. Functional Requirements

### 4.1 HTTP Fetch Handler (`fetch`)

**Trigger:** Incoming HTTP request to `coaching.jdores.xyz`.

**Input Query Parameters (provided by Gateway policy context):**

| Parameter        | Description                                    | Required |
|------------------|------------------------------------------------|----------|
| `cf_user_email`  | Email of the user being redirected             | Yes      |
| `cf_site_uri`    | Original URI the user was trying to access     | Yes      |
| `cf_rule_id`     | ID of the Gateway HTTP rule that triggered the redirect | Yes |

**Behavior:**

1. **Parse request URL** and extract `cf_user_email`, `cf_site_uri`, and `cf_rule_id` from query parameters.
2. **Derive display name** from the email prefix (capitalize first letter).
3. **Update Gateway Rule identity exception:**
   - **GET** the current rule configuration via Cloudflare API.
   - Parse the existing `identity` field expression.
   - If the identity field is empty, initialize it with `not(identity.email in {"<email>"})`.
   - If the identity field already contains an `identity.email in {...}` expression, append the new email if not already present.
   - **PUT** the updated rule back via Cloudflare API.
4. **Track the rule ID in KV:**
   - Check if `cf_rule_id` already exists in `GATEWAY_RULE_IDS_KV`.
   - If not, store it with metadata (`firstTrackedAt` timestamp and `firstUserEmail`).
   - Uses `ctx.waitUntil()` for non-blocking KV writes.
5. **Render and return an HTML coaching page** containing:
   - A warning icon image (hosted on R2).
   - Personalized greeting using the user's email prefix.
   - A message informing the user that access is logged and monitored.
   - A "Proceed to site" hyperlink pointing to `cf_site_uri`.
   - A collapsible "Debug Information" section showing request URL, all query parameters, Gateway rule update status, and KV store status.

**Response:** HTML page with `content-type: text/html;charset=UTF-8`.

### 4.2 Scheduled Handler (`scheduled`)

**Trigger:** Cron expression `0 1 * * *` (daily at 01:00 UTC).

**Behavior:**

1. **Validate environment:** Ensure `GATEWAY_RULE_IDS_KV`, `API_KEY`, `ACCOUNT_ID`, and `USER_EMAIL` bindings are present. Exit early if any are missing.
2. **Iterate all KV keys** (with pagination support via cursor):
   - For each key (a `cf_rule_id`):
     - **GET** the rule from the Cloudflare Gateway API.
     - Set the rule's `identity` field to an empty string `""`.
     - **PUT** the updated rule back.
   - Collect all processed keys for deletion.
3. **Wait for all rule updates** to settle via `Promise.allSettled()`.
4. **Delete all processed KV keys** to reset tracking state.

**Effect:** All users who were previously excepted will see the coaching page again on their next visit.

## 5. Environment Variables and Bindings

### 5.1 Secrets (set via `wrangler secret put`)

| Variable       | Description                                         |
|----------------|-----------------------------------------------------|
| `ACCOUNT_ID`   | Cloudflare account ID                               |
| `USER_EMAIL`   | Email associated with the Cloudflare API key        |
| `API_KEY`      | Global API key for the Cloudflare account           |

### 5.2 KV Namespace Binding

| Binding Name          | KV Namespace ID                          | Purpose                          |
|-----------------------|------------------------------------------|----------------------------------|
| `GATEWAY_RULE_IDS_KV` | `5b5488c441f04338b483ad6ab5232504`       | Tracks Gateway rule IDs that have active identity exceptions |

**KV Entry Schema:**

- **Key:** Gateway rule ID (string)
- **Value:** JSON object:
  ```json
  {
    "firstTrackedAt": "2025-01-15T01:00:00.000Z",
    "firstUserEmail": "user@example.com"
  }
  ```

## 6. External API Interactions

### 6.1 Cloudflare Gateway Rules API

**Base URL:** `https://api.cloudflare.com/client/v4/accounts/{account_id}/gateway/rules/{rule_id}`

**Authentication Headers:**
- `X-Auth-Email`: Value of `USER_EMAIL` secret
- `X-Auth-Key`: Value of `API_KEY` secret

**Operations:**

| Operation   | Method | When                           | Purpose                                     |
|-------------|--------|--------------------------------|---------------------------------------------|
| Get Rule    | `GET`  | On each fetch and cron cycle   | Retrieve current rule configuration         |
| Update Rule | `PUT`  | On each fetch (add exception) and cron (reset) | Modify the rule's `identity` field |

### 6.2 Gateway Rule Identity Expression Format

The `identity` field uses Cloudflare's wire filter expression syntax:

- **Empty (no exceptions):** `""`
- **Single user exception:** `not(identity.email in {"user@example.com"})`
- **Multiple user exceptions:** `not(identity.email in {"user1@example.com" "user2@example.com"})`

Emails within the braces are space-separated and individually double-quoted.

## 7. UI Specification

The coaching page is a single-page, self-contained HTML document rendered inline by the Worker (no external framework dependencies).

### 7.1 Layout

- **Centered card** (max-width 600px) with white background, rounded corners, and subtle box shadow.
- **Header:** Warning icon image, personalized greeting (`Hello <Name>,`), coaching message, and "Proceed to site" link.
- **Main:** Collapsible `<details>` element with debug information.
- **Footer:** Copyright notice.

### 7.2 Responsive Design

- Viewport-aware via `<meta name="viewport">`.
- CSS media query at 480px breakpoint adjusts font sizes.

### 7.3 Static Assets

| Asset         | Location                                                              |
|---------------|-----------------------------------------------------------------------|
| Warning icon  | `https://pub-468cf04c27cf401e8a928bd7ea22e060.r2.dev/warning.jpg` (Cloudflare R2 public bucket) |

## 8. Deployment Configuration

| Setting              | Value                  | Notes                                     |
|----------------------|------------------------|-------------------------------------------|
| `name`               | `coaching-page`        | Worker name                               |
| `main`               | `src/index.js`         | Entry point                               |
| `compatibility_date` | `2025-05-28`           | Workers runtime compatibility date        |
| `workers_dev`        | `false`                | Disabled — not accessible via `*.workers.dev` |
| `preview_urls`       | `false`                | Disabled — no preview URLs                |
| `observability`      | `enabled: true`        | Workers observability/logging enabled     |
| Custom domain        | `coaching.jdores.xyz`  | Via routes configuration                  |
| Cron schedule        | `0 1 * * *`            | Daily at 01:00 UTC                        |

## 9. Security Considerations

- **Access Control:** The Worker's custom domain must be protected by a Cloudflare Access policy restricting access to internal users via WARP authentication identity. This prevents unauthorized external access to the coaching page.
- **API Credentials:** `API_KEY`, `USER_EMAIL`, and `ACCOUNT_ID` are stored as Worker secrets (encrypted at rest), never hardcoded.
- **Authentication method:** Uses Global API Key (`X-Auth-Key` + `X-Auth-Email`). Consider migrating to scoped API Tokens for least-privilege access.
- **Input trust:** The `cf_site_uri` parameter is rendered as an `<a href>` in the HTML response. Since the page is Access-protected and only reachable via Gateway redirect with policy context, the risk of arbitrary URL injection is mitigated but not eliminated.

## 10. Testing

- **Framework:** Vitest with `@cloudflare/vitest-pool-workers` pool.
- **Config:** `vitest.config.js` references `wrangler.jsonc` for Worker bindings.
- **Current state:** The test file (`test/index.spec.js`) contains placeholder tests from the Worker scaffold template and does not yet test the actual coaching page logic.

### 10.1 Recommended Test Coverage

| Area                          | Test Type    | Description                                              |
|-------------------------------|-------------|----------------------------------------------------------|
| HTML response rendering       | Unit        | Verify coaching page HTML is returned with correct user name and proceed link |
| Missing query parameters      | Unit        | Verify graceful handling when `cf_user_email`, `cf_site_uri`, or `cf_rule_id` are absent |
| Gateway rule identity parsing | Unit        | Test all three identity expression scenarios (empty, existing, malformed) |
| KV deduplication              | Unit        | Verify rule ID is only written to KV if not already present |
| Scheduled handler reset       | Integration | Verify cron empties identity fields and deletes KV keys  |

## 11. NPM Scripts

| Script   | Command          | Description                       |
|----------|------------------|-----------------------------------|
| `dev`    | `wrangler dev`   | Start local development server    |
| `start`  | `wrangler dev`   | Alias for `dev`                   |
| `deploy` | `wrangler deploy`| Deploy to Cloudflare              |
| `test`   | `vitest`         | Run test suite                    |

## 12. Known Limitations and Future Considerations

- **Single-tenant credentials:** The Worker uses a single global API key for all Gateway rule modifications. This limits multi-account or multi-tenant usage.
- **No rate limiting:** There is no protection against a user repeatedly triggering the coaching page in rapid succession, which could result in excessive API calls to the Gateway Rules endpoint.
- **No audit logging:** While the coaching page mentions access is "logged," the Worker itself does not persist an audit trail of who was coached and when (only the KV tracks rule IDs, not individual user events). Observability logs serve this purpose partially.
- **Stale test file:** The existing tests are scaffolding from the Worker template and need to be updated to cover the actual implementation.
- **Identity expression fragility:** The regex-based parsing of the identity expression (`/\{"([^"]+(?:"\s*"[^"]+)*)"\}/`) may break if the expression format changes or contains unexpected characters.
- **Concurrency:** Simultaneous requests for the same rule could cause race conditions in the identity field update (read-modify-write without locking).
