# swg-rule-override

Cloudflare Worker that intercepts Gateway block pages, collects a business justification from the user, and temporarily exempts them from the rule by updating the identity filter.

## Requirements

### Cloudflare Resources
- **Worker**: deployed via Wrangler as `swg-rule-override`
- **D1 Database**: `swg-rule-override-db` — stores justification logs, tracked rule IDs, pending overrides, config, and event log
- **R2 Bucket**: `swg-rule-override-assets` — serves static assets (logo, warning image) via public custom domain
- **Custom Domain**: `override.davideslab.eu` mapped to the Worker

### API Token
A Cloudflare API Token is required with the following permissions:

- **Account → Zero Trust → Edit** — to GET and PUT Gateway firewall rules (updating the `identity` field to exempt a user's email)
- **Account → Workers Scripts → Edit** — to update cron trigger schedules dynamically via the admin settings UI

Set it as a Worker secret:
```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put ACCOUNT_ID
```

### Environment Secrets
| Secret | Description |
|---|---|
| `API_TOKEN` | Cloudflare API Token with Zero Trust Edit + Workers Scripts Edit permissions |
| `ACCOUNT_ID` | Cloudflare Account ID |

## Deployment

```bash
npm run deploy
```

## D1 Database Schema

### `justifications`
Stores submitted business justifications.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `timestamp` | TEXT | ISO 8601 timestamp |
| `user_email` | TEXT | User's email address |
| `rule_id` | TEXT | Gateway rule ID |
| `rule_name` | TEXT | Gateway rule name |
| `site_uri` | TEXT | Requested URL that triggered the block |
| `justification` | TEXT | User-provided justification text |

### `rule_ids`
Tracks Gateway rule IDs that have been overridden — used by the daily 1am cron to reset them.

| Column | Type | Description |
|---|---|---|
| `rule_id` | TEXT (PK) | Gateway rule ID |
| `first_tracked_at` | TEXT | ISO 8601 timestamp of first override |
| `first_user_email` | TEXT | Email of first user to override |

### `pending_overrides`
Tracks overrides where the user clicked "I understand" but has not yet submitted a justification. Used by the revert cron to clean up abandoned sessions.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `rule_id` | TEXT | Gateway rule ID |
| `user_email` | TEXT | User's email address |
| `triggered_at` | TEXT | ISO 8601 timestamp of "I understand" click |
| `status` | TEXT | `pending` or `completed` |

### `config`
Stores runtime-configurable parameters.

| Key | Default | Description |
|---|---|---|
| `revert_after_mins` | `5` | Minutes after which a pending override is reverted by the cron |
| `cron_interval_mins` | `5` | Cron interval in minutes — updating this via admin UI also updates the live Worker schedule |

### `event_log`
Audit log of all system events with timestamps.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `timestamp` | TEXT | ISO 8601 timestamp |
| `event_type` | TEXT | Event label (see below) |
| `user_email` | TEXT | Associated user email (nullable) |
| `rule_id` | TEXT | Associated rule ID (nullable) |
| `details` | TEXT | JSON string with additional context (nullable) |

#### Event Types

| Event | Trigger |
|---|---|
| `PAGE_SERVED` | Override page rendered for a user (GET request) |
| `I_UNDERSTAND` | User clicked "I understand and want to proceed" |
| `JUSTIFICATION_SUBMIT` | User submitted the justification form |
| `GATEWAY_PUT_SUCCESS` | Gateway rule PUT succeeded |
| `GATEWAY_PUT_FAILURE` | Gateway rule PUT failed |
| `PENDING_REVERT_SUCCESS` | Cron successfully reverted a stale pending override |
| `PENDING_REVERT_FAILURE` | Cron failed to revert a stale pending override |
| `CRON_START` | A cron job started |
| `CRON_COMPLETE` | A cron job completed |
| `CRON_SCHEDULE_UPDATE` | Admin updated the cron interval — live schedule was updated |
| `PURGE_RULES` | Admin triggered "Purge Tracked Rules" |
| `CLEAR_LOGS` | Admin triggered "Clear All Logs" |
| `SETTINGS_UPDATE` | Admin saved settings |

## Cron Jobs

| Schedule | Purpose |
|---|---|
| `0 1 * * *` | Daily reset — empties the `identity` field on all tracked Gateway rules |
| `*/N * * * *` | Pending revert — reverts Gateway rules for abandoned overrides older than `revert_after_mins` |

The pending revert cron interval (`N`) defaults to 5 minutes and can be changed at runtime via the admin Settings modal without redeploying.

## Admin Dashboard

Available at `https://override.davideslab.eu/admin`

- View all justification submissions with search and sort
- Live auto-refresh every 30 seconds
- **Settings modal**:
  - *Revert after (minutes)* — how long before an abandoned pending override is reverted
  - *Cron interval (minutes)* — how often the revert cron runs (updates live schedule immediately)
  - *Purge Tracked Rules* — resets Gateway rule identity for all tracked rules and clears the `rule_ids` table
  - *Clear All Logs* — deletes all records from the `justifications` table
