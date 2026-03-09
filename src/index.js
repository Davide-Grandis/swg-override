// This is the main Worker script that handles both HTTP requests and scheduled events.

/**
 * Logs an event to the event_log D1 table. Fire-and-forget (no await needed at call site).
 */
async function logEvent(env, eventType, { userEmail = null, ruleId = null, details = null } = {}) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      'INSERT INTO event_log (id, timestamp, event_type, user_email, rule_id, details) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), new Date().toISOString(), eventType, userEmail, ruleId, details ? JSON.stringify(details) : null).run();
  } catch (e) {
    console.error('logEvent failed:', e.message);
  }
}

export default {
  /**
   * The `fetch` handler is triggered when the Worker's hostname is called (HTTP request).
   * It processes incoming HTTP requests and sends back responses.
   *
   * @param {Request} request The incoming HTTP request.
   * @param {Env} env Environment variables and bindings (e.g., API_TOKEN, ACCOUNT_ID, DB).
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   * @returns {Response} The HTTP response.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- /admin dashboard route ---
    if (url.pathname === '/admin') {
      return await handleAdminDashboard(env);
    }

    // --- /admin/purge-rules: reset Gateway rule identities and delete rule_ids from D1 (POST) ---
    if (url.pathname === '/admin/purge-rules' && request.method === 'POST') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      if (!env.API_TOKEN || !env.ACCOUNT_ID) return new Response(JSON.stringify({ error: 'API_TOKEN or ACCOUNT_ID not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      try {
        const { results: ruleRows } = await env.DB.prepare('SELECT rule_id FROM rule_ids').all();
        const errors = [];
        await Promise.all(ruleRows.map(async (row) => {
          const cfRuleId = row.rule_id;
          try {
            const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
            const getRuleResponse = await fetch(getRuleUrl, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
            });
            if (!getRuleResponse.ok) {
              errors.push(`GET ${cfRuleId}: ${getRuleResponse.status}`);
              return;
            }
            const existingRule = (await getRuleResponse.json()).result;
            if (!existingRule) { errors.push(`Rule ${cfRuleId} not found`); return; }
            const updatedPayload = { ...existingRule, identity: '' };
            const putResponse = await fetch(getRuleUrl, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(updatedPayload),
            });
            if (!putResponse.ok) {
              const errText = await putResponse.text();
              errors.push(`PUT ${cfRuleId}: ${putResponse.status} - ${errText}`);
            }
          } catch (e) {
            errors.push(`${cfRuleId}: ${e.message}`);
          }
        }));
        await env.DB.prepare('DELETE FROM rule_ids').run();
        await logEvent(env, 'PURGE_RULES', { details: { purged: ruleRows.length, errors } });
        if (errors.length > 0) {
          return new Response(JSON.stringify({ ok: false, errors }), { status: 207, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, purged: ruleRows.length }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // --- /trigger-override: fire Gateway PUT immediately when user clicks "I understand" ---
    if (url.pathname === '/trigger-override' && request.method === 'POST') {
      if (!env.API_TOKEN || !env.ACCOUNT_ID) return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      try {
        let body;
        try { body = await request.json(); } catch(e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'content-type': 'application/json' } }); }
        const { cf_rule_id, cf_user_email, cf_rule_payload } = body;
        if (!cf_rule_id || !cf_user_email) return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400, headers: { 'content-type': 'application/json' } });
        const ruleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cf_rule_id}`;
        const authHeaders = { 'Authorization': `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };
        let existingRule = null;
        if (cf_rule_payload) {
          existingRule = JSON.parse(cf_rule_payload);
        } else {
          const getRuleResponse = await fetch(ruleUrl, { method: 'GET', headers: authHeaders });
          if (!getRuleResponse.ok) {
            const errText = await getRuleResponse.text();
            return new Response(JSON.stringify({ error: `GET failed: ${getRuleResponse.status} - ${errText}` }), { status: 502, headers: { 'content-type': 'application/json' } });
          }
          existingRule = (await getRuleResponse.json()).result;
        }
        if (!existingRule) return new Response(JSON.stringify({ error: 'Rule not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        const updatedPayload = { ...existingRule };
        const newEmailToAdd = `"${cf_user_email}"`;
        const currentIdentity = updatedPayload.identity;
        if (!currentIdentity) {
          updatedPayload.identity = `not(identity.email in {${newEmailToAdd}})`;
        } else if (currentIdentity.includes('identity.email in {')) {
          const regex = /\{"([^"]+(?:"\s*"[^"]+)*)"\}/;
          const match = currentIdentity.match(regex);
          if (match && match[1]) {
            const existingEmails = match[1].split('" "').filter(Boolean).map(e => `"${e}"`);
            if (!existingEmails.includes(newEmailToAdd)) {
              existingEmails.push(newEmailToAdd);
              const updatedEmailsString = existingEmails.map(e => e.slice(1, -1)).join('" "');
              updatedPayload.identity = currentIdentity.replace(regex, `{"${updatedEmailsString}"}`);
            }
          }
        }
        const putResponse = await fetch(ruleUrl, { method: 'PUT', headers: authHeaders, body: JSON.stringify(updatedPayload) });
        if (!putResponse.ok) {
          const errText = await putResponse.text();
          await logEvent(env, 'GATEWAY_PUT_FAILURE', { userEmail: cf_user_email, ruleId: cf_rule_id, details: { status: putResponse.status, error: errText, trigger: 'I_UNDERSTAND' } });
          return new Response(JSON.stringify({ error: `PUT failed: ${putResponse.status} - ${errText}` }), { status: 502, headers: { 'content-type': 'application/json' } });
        }
        // Write pending record to D1 so the revert cron can clean up if user abandons
        let pendingId = null;
        if (env.DB) {
          pendingId = crypto.randomUUID();
          const triggeredAt = new Date().toISOString();
          await env.DB.prepare(
            'INSERT INTO pending_overrides (id, rule_id, user_email, triggered_at, status) VALUES (?, ?, ?, ?, ?)'
          ).bind(pendingId, cf_rule_id, cf_user_email, triggeredAt, 'pending').run();
        }
        await logEvent(env, 'I_UNDERSTAND', { userEmail: cf_user_email, ruleId: cf_rule_id, details: { pending_id: pendingId } });
        await logEvent(env, 'GATEWAY_PUT_SUCCESS', { userEmail: cf_user_email, ruleId: cf_rule_id, details: { trigger: 'I_UNDERSTAND' } });
        return new Response(JSON.stringify({ ok: true, pending_id: pendingId }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        await logEvent(env, 'GATEWAY_PUT_FAILURE', { details: { error: e.message, trigger: 'I_UNDERSTAND' } });
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // --- /admin/clear-logs: delete all justification records from D1 (POST) ---
    if (url.pathname === '/admin/clear-logs' && request.method === 'POST') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      try {
        await env.DB.prepare('DELETE FROM justifications').run();
        await logEvent(env, 'CLEAR_LOGS', {});
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // --- /admin/settings GET: return current config values ---
    if (url.pathname === '/admin/settings' && request.method === 'GET') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      try {
        const { results } = await env.DB.prepare('SELECT key, value FROM config').all();
        const cfg = Object.fromEntries(results.map(r => [r.key, r.value]));
        return new Response(JSON.stringify({ ok: true, config: cfg }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // --- /admin/settings POST: update config values ---
    if (url.pathname === '/admin/settings' && request.method === 'POST') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
      try {
        const body = await request.json();
        const allowed = ['revert_after_mins', 'cron_interval_mins'];
        const updates = allowed.filter(k => body[k] !== undefined && !isNaN(parseInt(body[k], 10)));
        if (updates.length === 0) return new Response(JSON.stringify({ error: 'No valid config keys provided' }), { status: 400, headers: { 'content-type': 'application/json' } });
        await Promise.all(updates.map(k =>
          env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(k, String(parseInt(body[k], 10))).run()
        ));
        await logEvent(env, 'SETTINGS_UPDATE', { details: Object.fromEntries(updates.map(k => [k, body[k]])) });

        // If cron_interval_mins changed, update the Worker's cron schedules via Cloudflare API
        if (updates.includes('cron_interval_mins') && env.API_TOKEN && env.ACCOUNT_ID) {
          const cronMins = parseInt(body['cron_interval_mins'], 10);
          const newCronExpr = cronMins === 1 ? '* * * * *' : `*/${cronMins} * * * *`;
          const schedulesUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/workers/scripts/swg-rule-override/schedules`;
          const scheduleResp = await fetch(schedulesUrl, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ cron: '0 1 * * *' }, { cron: newCronExpr }]),
          });
          if (!scheduleResp.ok) {
            const errText = await scheduleResp.text();
            return new Response(JSON.stringify({ ok: false, error: `Settings saved but cron update failed: ${scheduleResp.status} - ${errText}` }), { status: 207, headers: { 'content-type': 'application/json' } });
          }
          await logEvent(env, 'CRON_SCHEDULE_UPDATE', { details: { cron_expr: newCronExpr, cron_interval_mins: cronMins } });
        }

        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // --- Redirect to /admin if gateway context query params are missing ---
    const hasGatewayContext = url.searchParams.has('cf_user_email') &&
                              url.searchParams.has('cf_site_uri') &&
                              url.searchParams.has('cf_rule_id');
    if (!hasGatewayContext && request.method === 'GET') {
      return Response.redirect(new URL('/admin', url.origin).toString(), 302);
    }

    const isPost = request.method === 'POST';

    // For POST requests, read form data to extract parameters and justification
    let formData = null;
    if (isPost) {
        try {
            formData = await request.formData();
        } catch (e) {
            console.error('Failed to parse form data:', e);
            return new Response('Bad Request', { status: 400 });
        }
    }

    // Extract parameters from query string (GET) or form hidden fields (POST)
    const cfUserEmail = isPost ? formData.get('cf_user_email') : url.searchParams.get('cf_user_email');
    const cfSiteUri = isPost ? formData.get('cf_site_uri') : url.searchParams.get('cf_site_uri');
    const cfRuleId = isPost ? formData.get('cf_rule_id') : url.searchParams.get('cf_rule_id');
    const justificationText = isPost ? (formData.get('justification') || '').trim() : '';
    const ruleName = isPost ? formData.get('cf_rule_name') : url.searchParams.get('cf_rule_name'); // Rule name carried forward from GET via hidden field or query param
    const cachedRulePayload = isPost ? (formData.get('cf_rule_payload') || '') : ''; // Full rule payload cached on GET, used for instant PUT on POST
    const pageLoadTime = isPost ? (formData.get('page_load_time') || '') : ''; // Original page load timestamp carried forward from GET
    const pendingId = isPost ? (formData.get('pending_id') || '') : ''; // Pending override record ID written by /trigger-override

    const rawUser = cfUserEmail ? cfUserEmail.split('@')[0] : 'there';
    const user = rawUser.charAt(0).toUpperCase() + rawUser.charAt(1).toLowerCase() + rawUser.slice(2); // Capitalize first letter, lowercase rest

    let gatewayRuleUpdateStatus = 'No Gateway rule update attempted.';
    let dbStoreStatus = 'No DB store update attempted.';
    let fetchedRuleName = ruleName || ''; // Will be populated from API on GET, or from hidden field on POST
    let justificationSubmitted = false;
    let justificationError = '';

    // --- Handle POST: defer D1 writes (Gateway PUT already fired via /trigger-override) ---
    if (isPost) {
        if (!justificationText) {
            justificationError = 'Please provide a business justification before proceeding.';
        } else if (cfUserEmail && cfRuleId) {
            gatewayRuleUpdateStatus = 'Fired via /trigger-override on I understand click.';
            // Defer D1 writes via waitUntil (non-blocking)
            if (env.DB) {
                const justificationId = crypto.randomUUID();
                const timestamp = new Date().toISOString();
                const dbTasks = [
                    env.DB.prepare(
                        'INSERT INTO justifications (id, timestamp, user_email, rule_id, rule_name, site_uri, justification) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).bind(justificationId, timestamp, cfUserEmail, cfRuleId, fetchedRuleName, cfSiteUri || '', justificationText).run(),
                    env.DB.prepare(
                        'INSERT OR IGNORE INTO rule_ids (rule_id, first_tracked_at, first_user_email) VALUES (?, ?, ?)'
                    ).bind(cfRuleId, timestamp, cfUserEmail).run(),
                ];
                if (pendingId) {
                    dbTasks.push(
                        env.DB.prepare('UPDATE pending_overrides SET status = ? WHERE id = ?').bind('completed', pendingId).run()
                    );
                }
                ctx.waitUntil(Promise.all(dbTasks));
                console.log(`POST: Deferred D1 writes for justification ${justificationId} and rule ${cfRuleId}.`);
                dbStoreStatus = `Justification and rule ID queued for storage.`;
            }

            justificationSubmitted = true;
            ctx.waitUntil(logEvent(env, 'JUSTIFICATION_SUBMIT', { userEmail: cfUserEmail, ruleId: cfRuleId, details: { site_uri: cfSiteUri, pending_id: pendingId } }));
        } else {
            justificationError = 'Missing required parameters to store justification.';
        }
    }

    // Carry forward cached payload on POST so it stays available in the form (not used for PUT anymore but kept for debug)
    let cachedRulePayloadForForm_post = isPost ? (cachedRulePayload || '') : '';

    // --- On GET: fetch rule from API to cache payload in form and extract rule name ---
    let cachedRulePayloadForForm = '';
    if (!isPost && cfUserEmail && cfRuleId && env.API_TOKEN && env.ACCOUNT_ID) {
        try {
            console.log(`GET: Fetching Gateway Rule ${cfRuleId} to cache payload.`);
            const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
            const getRuleResponse = await fetch(getRuleUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${env.API_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!getRuleResponse.ok) {
                const errorText = await getRuleResponse.text();
                console.error(`GET: Failed to fetch Gateway Rule: ${getRuleResponse.status} - ${errorText}`);
                gatewayRuleUpdateStatus = `Error fetching Gateway Rule: ${getRuleResponse.status}`;
            } else {
                const existingRuleData = await getRuleResponse.json();
                const existingRule = existingRuleData.result;
                if (existingRule) {
                    fetchedRuleName = existingRule.name || '';
                    cachedRulePayloadForForm = JSON.stringify(existingRule);
                    console.log(`GET: Cached rule payload for ${cfRuleId}, name: ${fetchedRuleName}`);
                    gatewayRuleUpdateStatus = 'Rule fetched and cached.';
                } else {
                    console.error('GET: Rule not found in API response.');
                    gatewayRuleUpdateStatus = 'Error: Rule not found.';
                }
            }
        } catch (apiError) {
            console.error('GET: Error fetching Gateway Rule:', apiError);
            gatewayRuleUpdateStatus = `API Error: ${apiError.message || apiError}`;
        }
    } else if (!isPost) {
        gatewayRuleUpdateStatus = 'Skipped: Missing parameters or config.';
        dbStoreStatus = 'Skipped: Missing parameters or config.';
    }

    // Log page served event (non-blocking)
    if (!isPost) {
        ctx.waitUntil(logEvent(env, 'PAGE_SERVED', { userEmail: cfUserEmail, ruleId: cfRuleId, details: { site_uri: cfSiteUri, rule_name: fetchedRuleName } }));
    }

    // Determine whether to show the proceed link
    const showProceedLink = justificationSubmitted && cfSiteUri;

    // Build the current page URL with query params for the form action
    const formActionUrl = url.origin + url.pathname;

    // Server timestamp: on GET this is the initial page load time; on POST it is carried forward from the form
    const serverTimestamp = pageLoadTime || new Date().toISOString();

    // elapsedSeconds: seconds since the user clicked "I understand" (page_load_time is set at that moment client-side)
    // Used on POST re-render so the proceed button shows remaining time correctly.
    const elapsedSeconds = pageLoadTime ? Math.floor((Date.now() - new Date(pageLoadTime).getTime()) / 1000) : 0;

    // --- HTML generation ---
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Coaching page</title>
        <link rel="icon" href="https://www.sennder.com/favicon.ico" type="image/x-icon">
        <style>
            /* Modern Reset */
            *, *::before, *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; /* Modern font */
                line-height: 1.6;
                background-color: #f8f9fa; /* Light background */
                color: #333;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                padding: 20px;
            }

            #container {
                background-color: #fff;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.05);
                padding: 2rem;
                width: 100%;
                max-width: 800px; /* Limit width for better readability */
            }

            .top-bar-logo {
                position: fixed;
                top: 1rem;
                left: 1.25rem;
            }

            .top-bar-logo img {
                height: 36px;
                width: auto;
            }

            header {
                text-align: center;
                margin-bottom: 2rem;
            }

            .warning-icon {
                height: 160px;
                width: auto;
                margin-bottom: 0.75rem;
                display: block;
                margin-left: auto;
                margin-right: auto;
            }

            .title {
                font-size: 2rem;
                font-weight: 400;
                color: #2c3e50; /* Darker heading */
                margin-bottom: 1rem;
            }

            .subtitle {
                font-size: 1.1rem;
                color: #555;
            }

            .subtitle a {
                color: #007bff; /* Link color */
                text-decoration: none;
                font-weight: 500;
            }

            .subtitle a:hover {
                text-decoration: underline;
            }

            .proceed-btn {
                display: inline-block;
                padding: 0.6rem 1.5rem;
                border-radius: 4px;
                font-family: inherit;
                font-weight: 500;
                font-size: 1rem;
                text-decoration: none;
                transition: background-color 0.3s, color 0.3s;
            }

            .proceed-btn.active {
                background-color: #28a745;
                color: #fff;
                cursor: pointer;
            }

            .proceed-btn.active:hover {
                background-color: #218838;
            }

            .proceed-btn.disabled {
                background-color: #ccc;
                color: #888;
                cursor: not-allowed;
                pointer-events: none;
            }

            .justification-form {
                margin-top: 1.5rem;
                text-align: left;
            }

            .justification-form label {
                display: block;
                font-weight: 600;
                margin-bottom: 0.5rem;
                color: #2c3e50;
            }

            .justification-form textarea {
                width: 100%;
                min-height: 80px;
                padding: 0.6rem;
                border: 1px solid #ccc;
                border-radius: 4px;
                font-family: inherit;
                font-size: 1rem;
                resize: vertical;
            }

            .justification-form textarea:focus {
                outline: none;
                border-color: #007bff;
                box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.15);
            }

            .justification-form button {
                padding: 0.6rem 1.5rem;
                background-color: #28a745;
                color: #fff;
                border: none;
                border-radius: 4px;
                font-family: inherit;
                font-size: 1rem;
                font-weight: 500;
                cursor: pointer;
            }

            .justification-form button:hover {
                background-color: #218838;
            }

            .button-row {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 1rem;
                margin-top: 0.75rem;
            }

            .error-message {
                color: #dc3545;
                font-size: 0.95rem;
                margin-top: 0.5rem;
            }

            .success-message {
                color: #28a745;
                font-size: 0.95rem;
                margin-top: 0.5rem;
                font-weight: 500;
            }

            main {
                margin-bottom: 2rem;
            }

            footer {
                text-align: center;
                font-size: 0.75rem;
                color: #bbb;
                margin-top: 1.5rem;
            }

            footer details {
                margin-top: 0.5rem;
                padding: 0.5rem;
                text-align: left;
            }

            footer details summary {
                cursor: pointer;
                color: #bbb;
                font-size: 0.7rem;
            }

            footer details p {
                margin-top: 0.3rem;
                font-size: 0.7rem;
                color: #bbb;
            }

            /* Responsive Design */
            @media (max-width: 480px) {
                .title {
                    font-size: 1.5rem;
                }
                .subtitle {
                    font-size: 1.1rem; /* Adjust if needed */
                }
            }
        </style>
    </head>
    <body>
        <div class="top-bar-logo">
            <img src="https://swg-rule-override-assets.davideslab.eu/logo.svg" alt="Logo">
        </div>
        <div id="container">
            <header>
                <img class="warning-icon" src="https://swg-rule-override-assets.davideslab.eu/warning.jpg" alt="Warning">
                <h1 class="title">Hello ${user},</h1>
                <p class="subtitle">
                    Your access to this resource has been flagged by your organization's web filtering policy. All access to this category is monitored and logged.
                </p>
                <p class="subtitle" style="margin-top: 0.75rem;">
                    If you have a valid business need, provide a justification below. By proceeding, you confirm your access will be recorded and reviewed. Misuse may result in disciplinary action.
                </p>
            </header>
            <main>
                ${justificationSubmitted ? `
                <!-- Stage 3: justification submitted, show proceed button with countdown -->
                <p class="success-message" style="text-align:center;">Justification submitted. <span id="propagation-notice">Please wait while the policy change propagates.</span></p>
                <p style="text-align:center; margin-top: 1rem;">
                    <span id="proceed-btn" class="proceed-btn disabled" data-href="${cfSiteUri || ''}" data-justified="true" data-elapsed="${elapsedSeconds}">Loading...</span>
                </p>
                ` : `
                <!-- Stage 1: I understand button (hidden after click), Stage 2: justification form (shown after click) -->
                <div id="stage-understand" style="text-align:center;">
                    <button id="understand-btn" class="proceed-btn active" style="font-size:1rem; padding:0.75rem 2rem;">
                        I understand and want to proceed
                    </button>
                </div>
                <div id="stage-justification" style="display:none;">
                    <form class="justification-form" method="POST" action="${formActionUrl}" id="justification-form">
                        <input type="hidden" name="cf_user_email" value="${cfUserEmail || ''}">
                        <input type="hidden" name="cf_site_uri" value="${cfSiteUri || ''}">
                        <input type="hidden" name="cf_rule_id" value="${cfRuleId || ''}">
                        <input type="hidden" name="cf_rule_name" value="${fetchedRuleName}">
                        <input type="hidden" name="cf_rule_payload" value="${cachedRulePayloadForForm.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
                        <input type="hidden" name="page_load_time" id="page_load_time" value="">
                        <input type="hidden" name="pending_id" id="pending_id" value="">
                        <label for="justification">Business Justification <span style="color:#dc3545;">*</span></label>
                        <textarea id="justification" name="justification" placeholder="Please explain why you need access to this resource..." required>${justificationText}</textarea>
                        ${justificationError ? `<p class="error-message">${justificationError}</p>` : ''}
                        <div class="button-row">
                            <button type="submit">Submit Justification</button>
                        </div>
                    </form>
                </div>
                `}
            </main>
            <footer>
                <p>&copy; 2026 Generated by Cloudflare Worker</p>
                <details>
                    <summary>Debug Information</summary>
                    <p><strong>Request URL:</strong> ${request.url}</p>
                    ${[...url.searchParams.entries()].map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`).join('')}
                    ${cfRuleId ? `<p><strong>Rule Name:</strong> ${fetchedRuleName}</p>` : ''}
                    ${cfRuleId ? `<p><strong>Gateway Rule Update Status:</strong> ${gatewayRuleUpdateStatus}</p>` : ''}
                    ${cfRuleId ? `<p><strong>DB Store Status:</strong> ${dbStoreStatus}</p>` : ''}
                </details>
            </footer>
        </div>
        <script>
            (function() {
                var totalSeconds = 45;

                // --- Stage 3: POST re-render, justification already submitted ---
                var proceedBtn = document.getElementById('proceed-btn');
                if (proceedBtn) {
                    var href = proceedBtn.dataset.href;
                    var serverElapsed = parseInt(proceedBtn.dataset.elapsed, 10) || 0;
                    var remaining = Math.max(0, totalSeconds - serverElapsed);

                    var propagationNotice = document.getElementById('propagation-notice');

                    function updateProceedBtn() {
                        if (remaining <= 0 && href) {
                            proceedBtn.className = 'proceed-btn active';
                            proceedBtn.textContent = 'Proceed to site';
                            proceedBtn.style.cursor = 'pointer';
                            proceedBtn.onclick = function() { window.location.href = href; };
                            if (propagationNotice) propagationNotice.style.display = 'none';
                        } else {
                            proceedBtn.className = 'proceed-btn disabled';
                            proceedBtn.textContent = 'Proceed to site (' + remaining + 's)';
                        }
                    }

                    updateProceedBtn();
                    if (remaining > 0) {
                        var t = setInterval(function() {
                            remaining--;
                            updateProceedBtn();
                            if (remaining <= 0) clearInterval(t);
                        }, 1000);
                    }
                    return;
                }

                // --- Stage 1 & 2: GET render ---
                var understandBtn = document.getElementById('understand-btn');
                var stageUnderstand = document.getElementById('stage-understand');
                var stageJustification = document.getElementById('stage-justification');
                if (!understandBtn) return;

                understandBtn.addEventListener('click', function() {
                    var triggerTime = new Date().toISOString();

                    // Set page_load_time so server can compute elapsed on POST
                    document.getElementById('page_load_time').value = triggerTime;

                    // Fire Gateway PUT immediately (non-blocking), capture pending_id on response
                    var ruleId = document.querySelector('[name=cf_rule_id]').value;
                    var userEmail = document.querySelector('[name=cf_user_email]').value;
                    var rulePayloadRaw = document.querySelector('[name=cf_rule_payload]').value;
                    fetch('/trigger-override', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            cf_rule_id: ruleId,
                            cf_user_email: userEmail,
                            cf_rule_payload: rulePayloadRaw || null
                        })
                    }).then(function(r) { return r.json(); })
                      .then(function(d) {
                          if (d.pending_id) {
                              document.getElementById('pending_id').value = d.pending_id;
                          }
                      })
                      .catch(function(e) { console.error('trigger-override failed:', e); });

                    // Show justification form, hide I understand button
                    stageUnderstand.style.display = 'none';
                    stageJustification.style.display = '';
                });
            })();
        </script>
    </body>
    </html>
    `;

    return new Response(html, {
        headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },

  /**
   * The `scheduled` handler is triggered by cron expressions defined in `wrangler.toml`.
   * This function will iterate through all rule_ids in D1 and update each
   * corresponding Gateway rule to empty its identity field.
   *
   * @param {ScheduledController} controller The scheduled event controller.
   * @param {Env} env Environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   */
  async scheduled(controller, env, ctx) {
    console.log(`Cron trigger for pattern: ${controller.cron}`);

    if (!env.DB) { console.error('D1 binding DB is not configured.'); return; }
    if (!env.API_TOKEN || !env.ACCOUNT_ID) { console.error('API_TOKEN or ACCOUNT_ID not configured.'); return; }

    // --- Pending revert cron: any schedule that is NOT the daily 1am reset ---
    if (controller.cron !== '0 1 * * *') {
      await logEvent(env, 'CRON_START', { details: { cron: controller.cron } });
      await handlePendingRevert(env);
      await logEvent(env, 'CRON_COMPLETE', { details: { cron: controller.cron } });
      return;
    }

    // --- 1am daily cron: reset all tracked rule_ids ---
    await logEvent(env, 'CRON_START', { details: { cron: controller.cron } });

    const ruleUpdateTasks = []; // Array to hold promises of individual rule updates
    const ruleIdsToDelete = []; // Array to store rule IDs for deletion later

    try {
      // 1. Fetch all tracked rule IDs from D1
      const { results: ruleRows } = await env.DB.prepare('SELECT rule_id FROM rule_ids').all();

      for (const row of ruleRows) {
            const cfRuleId = row.rule_id;
            console.log(`Processing rule ID from DB: ${cfRuleId}`);
            ruleIdsToDelete.push(cfRuleId);

            // Add each rule update task to the ruleUpdateTasks array as a promise
            ruleUpdateTasks.push((async () => {
                try {
                    // 1. Get the existing rule
                    const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const getRuleResponse = await fetch(getRuleUrl, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${env.API_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                    });

                    if (!getRuleResponse.ok) {
                        const errorText = await getRuleResponse.text();
                        console.error(`Scheduled Task: Failed to get Gateway Rule ${cfRuleId}: ${getRuleResponse.status} - ${errorText}`);
                        return; // Skip to next rule if GET fails
                    }
                    const existingRuleData = await getRuleResponse.json();
                    const existingRule = existingRuleData.result;

                    if (!existingRule) {
                        console.warn(`Scheduled Task: Rule ${cfRuleId} not found in Gateway API, potentially deleted or invalid.`);
                        return; // Skip if rule not found
                    }

                    // 2. Prepare payload to empty the identity field
                    const updatedRulePayload = { ...existingRule };
                    updatedRulePayload.identity = "";

                    console.log(`Scheduled Task: Updating rule ${cfRuleId} to empty identity.`);

                    // 3. Send PUT request to update the rule
                    const updateRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const updateRuleResponse = await fetch(updateRuleUrl, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${env.API_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatedRulePayload),
                    });

                    if (!updateRuleResponse.ok) {
                        const errorText = await updateRuleResponse.text();
                        console.error(`Scheduled Task: Failed to update Gateway Rule ${cfRuleId}: ${updateRuleResponse.status} - ${errorText}`);
                        await logEvent(env, 'GATEWAY_PUT_FAILURE', { ruleId: cfRuleId, details: { status: updateRuleResponse.status, error: errorText, trigger: 'DAILY_CRON' } });
                    } else {
                        console.log(`Scheduled Task: Successfully emptied identity for Gateway Rule ${cfRuleId}.`);
                        await logEvent(env, 'GATEWAY_PUT_SUCCESS', { ruleId: cfRuleId, details: { trigger: 'DAILY_CRON' } });
                    }
                } catch (ruleError) {
                    console.error(`Scheduled Task: Error processing Gateway Rule ${cfRuleId}:`, ruleError);
                    await logEvent(env, 'GATEWAY_PUT_FAILURE', { ruleId: cfRuleId, details: { error: ruleError.message, trigger: 'DAILY_CRON' } });
                }
            })()); // Immediately invoke the async function
      }
    } catch (listError) {
      console.error('Scheduled Task: Error fetching rule IDs from DB:', listError);
    }

    // 2. Wait for all rule updates to complete
    await Promise.allSettled(ruleUpdateTasks);
    console.log('Scheduled task completed all rule identity resetting operations.');

    // 3. Delete all processed rule IDs from D1
    if (ruleIdsToDelete.length > 0) {
        console.log(`Scheduled Task: Deleting ${ruleIdsToDelete.length} rule IDs from DB.`);
        try {
            const deleteTasks = ruleIdsToDelete.map(id =>
                env.DB.prepare('DELETE FROM rule_ids WHERE rule_id = ?').bind(id).run()
            );
            await Promise.allSettled(deleteTasks);
            console.log('Scheduled Task: All rule IDs successfully deleted from DB.');
        } catch (deleteError) {
            console.error('Scheduled Task: Error deleting rule IDs from DB:', deleteError);
        }
    } else {
        console.log('Scheduled Task: No rule IDs found to delete.');
    }

    console.log('Scheduled task finished.');
    await logEvent(env, 'CRON_COMPLETE', { details: { cron: controller.cron, rules_processed: ruleIdsToDelete.length } });
  },
};

/**
 * Reverts Gateway rule identity for pending overrides older than revert_after_mins
 * and deletes them from D1. Called by the every-5-min cron.
 */
async function handlePendingRevert(env) {
  try {
    const { results: cfgRows } = await env.DB.prepare('SELECT key, value FROM config WHERE key = ?').bind('revert_after_mins').all();
    const revertAfterMins = cfgRows.length > 0 ? parseInt(cfgRows[0].value, 10) : 5;
    const cutoff = new Date(Date.now() - revertAfterMins * 60 * 1000).toISOString();

    const { results: stale } = await env.DB.prepare(
      "SELECT id, rule_id, user_email FROM pending_overrides WHERE status = 'pending' AND triggered_at < ?"
    ).bind(cutoff).all();

    if (stale.length === 0) {
      console.log('PendingRevert: No stale pending overrides found.');
      return;
    }

    console.log(`PendingRevert: Found ${stale.length} stale pending override(s) to revert.`);
    const authHeaders = { 'Authorization': `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' };

    await Promise.all(stale.map(async (row) => {
      const ruleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${row.rule_id}`;
      try {
        const getResp = await fetch(ruleUrl, { method: 'GET', headers: authHeaders });
        if (!getResp.ok) { console.error(`PendingRevert: GET ${row.rule_id} failed: ${getResp.status}`); return; }
        const existingRule = (await getResp.json()).result;
        if (!existingRule) { console.warn(`PendingRevert: Rule ${row.rule_id} not found.`); return; }

        // Remove only this user's email from the identity expression
        let identity = existingRule.identity || '';
        const emailToken = `"${row.user_email}"`;
        if (identity.includes('identity.email in {')) {
          const regex = /\{"([^"]+(?:"\s*"[^"]+)*)"\}/;
          const match = identity.match(regex);
          if (match && match[1]) {
            const emails = match[1].split('" "').filter(Boolean).filter(e => e !== row.user_email);
            identity = emails.length > 0
              ? identity.replace(regex, `{"${emails.join('" "')}"}`)
              : '';
          }
        } else if (identity === `not(identity.email in {${emailToken}})`) {
          identity = '';
        }

        const putResp = await fetch(ruleUrl, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ ...existingRule, identity }),
        });
        if (!putResp.ok) {
          console.error(`PendingRevert: PUT ${row.rule_id} failed: ${putResp.status}`);
          await logEvent(env, 'PENDING_REVERT_FAILURE', { userEmail: row.user_email, ruleId: row.rule_id, details: { status: putResp.status } });
        } else {
          console.log(`PendingRevert: Reverted rule ${row.rule_id} for ${row.user_email}.`);
          await logEvent(env, 'PENDING_REVERT_SUCCESS', { userEmail: row.user_email, ruleId: row.rule_id });
        }
      } catch (e) {
        console.error(`PendingRevert: Error processing ${row.rule_id}: ${e.message}`);
        await logEvent(env, 'PENDING_REVERT_FAILURE', { userEmail: row.user_email, ruleId: row.rule_id, details: { error: e.message } });
      }

      // Delete the pending record regardless of revert success to avoid retry loops
      await env.DB.prepare('DELETE FROM pending_overrides WHERE id = ?').bind(row.id).run();
    }));

    console.log('PendingRevert: Done.');
  } catch (e) {
    console.error('PendingRevert: Fatal error:', e.message);
  }
}

/**
 * Handles the /admin dashboard route.
 * Fetches all justification entries from KV and renders an HTML dashboard table
 * with client-side sorting and search.
 *
 * @param {Env} env Environment variables and bindings.
 * @returns {Response} HTML response with the admin dashboard.
 */
async function handleAdminDashboard(env) {
  let justifications = [];

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT id, timestamp, user_email, rule_id, rule_name, site_uri, justification FROM justifications ORDER BY timestamp DESC'
      ).all();
      justifications = results.map(row => ({
        timestamp: row.timestamp,
        userEmail: row.user_email,
        ruleId: row.rule_id,
        ruleName: row.rule_name,
        siteUri: row.site_uri || '',
        justification: row.justification,
      }));
    } catch (e) {
      console.error('Error fetching justifications from DB:', e);
    }
  }

  // Escape HTML to prevent XSS from stored values
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const tableRows = justifications.map((j) => `
    <tr>
      <td>${esc(j.ruleName)}</td>
      <td>${j.siteUri ? `<a href="${esc(j.siteUri)}" target="_blank" rel="noopener noreferrer">${esc(j.siteUri)}</a>` : ''}</td>
      <td>${esc(j.ruleId)}</td>
      <td>${esc(j.userEmail)}</td>
      <td data-ts="${esc(j.timestamp)}">${esc(j.timestamp ? new Date(j.timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '')}</td>
      <td>${esc(j.justification)}</td>
    </tr>
  `).join('');

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>App Access Control - Admin Dashboard</title>
    <link rel="icon" href="https://www.sennder.com/favicon.ico" type="image/x-icon">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        line-height: 1.6;
        background-color: #0f1117;
        color: #e2e8f0;
        padding: 2rem;
      }

      .dashboard {
        max-width: 1400px;
        margin: 0 auto;
      }

      .top-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.5rem;
        gap: 1rem;
        flex-wrap: wrap;
      }

      .top-bar-left {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.4rem;
      }

      .top-bar-left img {
        height: 36px;
        width: auto;
      }

      .top-bar-left h1 {
        font-size: 1.4rem;
        font-weight: 300;
        color: #f1f5f9;
      }

      .top-bar-right {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.45rem 1rem;
        border-radius: 6px;
        border: none;
        font-family: inherit;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s, color 0.2s;
      }

      .btn-settings {
        background: #1e2533;
        color: #94a3b8;
        border: 1px solid #2d3748;
      }
      .btn-settings:hover { background: #2d3748; color: #e2e8f0; }

      .btn-live {
        background: #065f46;
        color: #6ee7b7;
        border: 1px solid #047857;
        min-width: 200px;
        justify-content: center;
      }
      .btn-live:hover { background: #047857; }
      .btn-live.paused {
        background: #1e2533;
        color: #64748b;
        border: 1px solid #2d3748;
      }

      .subtitle {
        color: #94a3b8;
        font-size: 1rem;
        font-weight: 300;
        margin-bottom: 1.25rem;
      }

      .controls {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }

      .controls input[type="text"] {
        flex: 1;
        min-width: 200px;
        padding: 0.5rem 0.75rem;
        border: 1px solid #2d3748;
        border-radius: 6px;
        font-size: 0.9rem;
        font-family: inherit;
        font-weight: 300;
        background: #1e2533;
        color: #94a3b8;
      }

      .controls input[type="text"]::placeholder { color: #4a5568; }

      .controls input[type="text"]:focus {
        outline: none;
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59,130,246,0.2);
      }

      .record-count {
        font-size: 0.82rem;
        color: #64748b;
        white-space: nowrap;
      }

      .table-wrap {
        overflow-x: auto;
        background: #1a1f2e;
        border-radius: 8px;
        border: 1px solid #2d3748;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }

      thead th {
        background: #1e2533;
        text-align: left;
        padding: 0.65rem 0.85rem;
        font-weight: 600;
        color: #94a3b8;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        border-bottom: 1px solid #2d3748;
        letter-spacing: 0.02em;
        font-size: 0.78rem;
        text-transform: uppercase;
      }

      thead th:hover { background: #252d3d; color: #e2e8f0; }

      thead th .sort-arrow {
        display: inline-block;
        width: 1em;
        text-align: center;
        color: #4a5568;
        font-size: 0.7rem;
      }

      thead th.sorted-asc .sort-arrow::after { content: '\\25B2'; color: #3b82f6; }
      thead th.sorted-desc .sort-arrow::after { content: '\\25BC'; color: #3b82f6; }
      thead th:not(.sorted-asc):not(.sorted-desc) .sort-arrow::after { content: '\\25B4\\25BE'; }

      tbody tr { border-bottom: 1px solid #1e2533; }
      tbody tr:last-child { border-bottom: none; }
      tbody tr:hover { background: #1e2533; }

      td {
        padding: 0.6rem 0.85rem;
        vertical-align: top;
        color: #94a3b8;
        font-weight: 300;
      }

      td a {
        color: #60a5fa;
        text-decoration: none;
        word-break: break-all;
      }
      td a:hover { text-decoration: underline; }

      td:nth-child(6) {
        max-width: 320px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .empty-state {
        text-align: center;
        padding: 3rem 1rem;
        color: #4a5568;
        font-size: 1rem;
      }

      footer {
        text-align: center;
        font-size: 0.82rem;
        color: #64748b;
        margin-top: 2rem;
      }

      /* --- Settings Modal --- */
      .modal-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.7);
        z-index: 100;
        align-items: center;
        justify-content: center;
      }
      .modal-overlay.open { display: flex; }

      .modal {
        background: #1a1f2e;
        border: 1px solid #2d3748;
        border-radius: 10px;
        padding: 1.75rem;
        width: 100%;
        max-width: 440px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      }

      .modal h2 {
        font-size: 1.1rem;
        font-weight: 600;
        color: #f1f5f9;
        margin-bottom: 1.25rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .modal-close {
        background: none;
        border: none;
        color: #64748b;
        font-size: 1.25rem;
        cursor: pointer;
        line-height: 1;
        padding: 0;
      }
      .modal-close:hover { color: #e2e8f0; }

      .modal-section {
        margin-bottom: 1.25rem;
      }

      .modal-section-title {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        margin-bottom: 0.75rem;
      }

      .modal-actions {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }

      .btn-danger {
        background: #7f1d1d;
        color: #fca5a5;
        border: 1px solid #991b1b;
        width: 100%;
        justify-content: center;
        padding: 0.6rem 1rem;
        font-size: 0.9rem;
      }
      .btn-danger:hover { background: #991b1b; }

      .btn-warning {
        background: #78350f;
        color: #fcd34d;
        border: 1px solid #92400e;
        width: 100%;
        justify-content: center;
        padding: 0.6rem 1rem;
        font-size: 0.9rem;
      }
      .btn-warning:hover { background: #92400e; }

      .toast {
        position: fixed;
        bottom: 1.5rem;
        right: 1.5rem;
        background: #1e2533;
        border: 1px solid #2d3748;
        color: #e2e8f0;
        padding: 0.75rem 1.25rem;
        border-radius: 8px;
        font-size: 0.875rem;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.2s, transform 0.2s;
        pointer-events: none;
        z-index: 200;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      .toast.success { border-color: #065f46; color: #6ee7b7; }
      .toast.error { border-color: #991b1b; color: #fca5a5; }
    </style>
  </head>
  <body>
    <div class="dashboard">
      <div class="top-bar">
        <div class="top-bar-left">
          <img src="https://swg-rule-override-assets.davideslab.eu/logo.svg" alt="Logo">
          <h1>App Access Control — Admin Dashboard</h1>
        </div>
        <div class="top-bar-right">
          <button class="btn btn-settings" id="settings-btn">⚙ Settings</button>
          <button class="btn btn-live" id="live-btn">● Live</button>
        </div>
      </div>

      <p class="subtitle">Business justification records from rule override interactions</p>

      <div class="controls">
        <input type="text" id="search" placeholder="Search by rule name, URL, email, justification...">
        <span class="record-count" id="record-count">${justifications.length} record${justifications.length !== 1 ? 's' : ''}</span>
      </div>

      <div class="table-wrap">
        ${justifications.length === 0 ? `
        <div class="empty-state">No justification records found.</div>
        ` : `
        <table id="dashboard-table">
          <thead>
            <tr>
              <th data-col="0">Rule Name <span class="sort-arrow"></span></th>
              <th data-col="1">Requested URL <span class="sort-arrow"></span></th>
              <th data-col="2">Rule ID <span class="sort-arrow"></span></th>
              <th data-col="3">User Email <span class="sort-arrow"></span></th>
              <th data-col="4" class="sorted-desc">Timestamp <span class="sort-arrow"></span></th>
              <th data-col="5">Justification <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
        `}
      </div>

      <footer>
        <p>&copy; 2026 App Access Control dashboard | run on Cloudflare</p>
      </footer>
    </div>

    <!-- Settings Modal -->
    <div class="modal-overlay" id="settings-modal">
      <div class="modal">
        <h2>
          Settings
          <button class="modal-close" id="modal-close">✕</button>
        </h2>
        <div class="modal-section">
          <div class="modal-section-title">Pending Override Settings</div>
          <div style="display:flex; flex-direction:column; gap:0.75rem; margin-bottom:0.75rem;">
            <label style="font-size:0.85rem; color:#94a3b8;">
              Revert after (minutes)
              <input type="number" id="cfg-revert-after" min="1" max="1440" style="display:block; margin-top:0.3rem; width:100%; padding:0.4rem 0.6rem; background:#1e2533; border:1px solid #2d3748; border-radius:4px; color:#f1f5f9; font-size:0.9rem;">
            </label>
            <label style="font-size:0.85rem; color:#94a3b8;">
              Cron interval (minutes) <span style="font-size:0.75rem; color:#475569;">— reference only, requires redeploy to change</span>
              <input type="number" id="cfg-cron-interval" min="1" max="60" style="display:block; margin-top:0.3rem; width:100%; padding:0.4rem 0.6rem; background:#1e2533; border:1px solid #2d3748; border-radius:4px; color:#f1f5f9; font-size:0.9rem;">
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn" id="save-settings-btn" style="background:#0ea5e9; color:#fff;">Save Settings</button>
          </div>
        </div>
        <div class="modal-section">
          <div class="modal-section-title">Rule Override Tracking</div>
          <div class="modal-actions">
            <button class="btn btn-warning" id="purge-rules-btn">🔄 Purge Tracked Rules Now</button>
          </div>
        </div>
        <div class="modal-section">
          <div class="modal-section-title">Justification Logs</div>
          <div class="modal-actions">
            <button class="btn btn-danger" id="clear-logs-btn">🗑 Clear All Logs</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast notification -->
    <div class="toast" id="toast"></div>

    <script>
    (function() {
      // --- Toast ---
      function showToast(msg, type) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.className = 'toast show ' + (type || '');
        setTimeout(function() { t.className = 'toast'; }, 3000);
      }

      // --- Settings Modal ---
      document.getElementById('settings-btn').addEventListener('click', function() {
        document.getElementById('settings-modal').classList.add('open');
        // Load current config values
        fetch('/admin/settings')
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.ok && d.config) {
              document.getElementById('cfg-revert-after').value = d.config.revert_after_mins || 5;
              document.getElementById('cfg-cron-interval').value = d.config.cron_interval_mins || 5;
            }
          }).catch(function() {});
      });
      document.getElementById('modal-close').addEventListener('click', function() {
        document.getElementById('settings-modal').classList.remove('open');
      });
      document.getElementById('settings-modal').addEventListener('click', function(e) {
        if (e.target === this) this.classList.remove('open');
      });

      // --- Save Settings ---
      document.getElementById('save-settings-btn').addEventListener('click', function() {
        var revertAfter = parseInt(document.getElementById('cfg-revert-after').value, 10);
        var cronInterval = parseInt(document.getElementById('cfg-cron-interval').value, 10);
        if (isNaN(revertAfter) || revertAfter < 1) { showToast('Invalid revert after value.', 'error'); return; }
        if (isNaN(cronInterval) || cronInterval < 1) { showToast('Invalid cron interval value.', 'error'); return; }
        fetch('/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revert_after_mins: revertAfter, cron_interval_mins: cronInterval })
        }).then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.ok) { showToast('Settings saved and cron updated.', 'success'); }
            else { showToast('Error: ' + (d.error || 'Unknown'), 'error'); }
          }).catch(function() { showToast('Request failed.', 'error'); });
      });

      // --- Purge Rules ---
      document.getElementById('purge-rules-btn').addEventListener('click', function() {
        if (!confirm('Purge all tracked rule IDs? The cron job will no longer reset these rules until they are tracked again.')) return;
        fetch('/admin/purge-rules', { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.ok) { showToast('Purged ' + d.purged + ' rule(s) successfully.', 'success'); document.getElementById('settings-modal').classList.remove('open'); }
            else if (d.errors) { showToast('Partial errors: ' + d.errors.join('; '), 'error'); }
            else { showToast('Error: ' + (d.error || 'Unknown error'), 'error'); }
          }).catch(function() { showToast('Request failed.', 'error'); });
      });

      // --- Clear Logs ---
      document.getElementById('clear-logs-btn').addEventListener('click', function() {
        if (!confirm('Delete all justification log entries? This cannot be undone.')) return;
        fetch('/admin/clear-logs', { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.ok) { showToast('Logs cleared. Reloading...', 'success'); setTimeout(function() { location.reload(); }, 1200); }
            else { showToast('Error: ' + d.error, 'error'); }
          }).catch(function() { showToast('Request failed.', 'error'); });
      });

      // --- Live Refresh ---
      var liveBtn = document.getElementById('live-btn');
      var liveOn = true;
      var liveSeconds = 30;
      var liveInterval = null;

      function updateLiveBtn() {
        if (liveOn) {
          liveBtn.className = 'btn btn-live';
          liveBtn.textContent = '● Live · Refreshing in ' + liveSeconds + 's...';
        } else {
          liveBtn.className = 'btn btn-live paused';
          liveBtn.textContent = '○ Live (paused)';
        }
      }

      function startLive() {
        liveOn = true;
        liveSeconds = 30;
        updateLiveBtn();
        liveInterval = setInterval(function() {
          liveSeconds--;
          updateLiveBtn();
          if (liveSeconds <= 0) {
            clearInterval(liveInterval);
            location.reload();
          }
        }, 1000);
      }

      function stopLive() {
        liveOn = false;
        clearInterval(liveInterval);
        updateLiveBtn();
      }

      liveBtn.addEventListener('click', function() {
        if (liveOn) { stopLive(); } else { startLive(); }
      });

      startLive();

      // --- Table sorting & search ---
      var table = document.getElementById('dashboard-table');
      if (!table) return;

      var thead = table.querySelector('thead');
      var tbody = table.querySelector('tbody');
      var searchInput = document.getElementById('search');
      var countEl = document.getElementById('record-count');
      var allRows = Array.from(tbody.querySelectorAll('tr'));
      var currentSortCol = 4;
      var currentSortAsc = false;

      thead.addEventListener('click', function(e) {
        var th = e.target.closest('th');
        if (!th) return;
        var col = parseInt(th.dataset.col, 10);
        if (col === currentSortCol) {
          currentSortAsc = !currentSortAsc;
        } else {
          currentSortCol = col;
          currentSortAsc = true;
        }
        Array.from(thead.querySelectorAll('th')).forEach(function(h) {
          h.classList.remove('sorted-asc', 'sorted-desc');
        });
        th.classList.add(currentSortAsc ? 'sorted-asc' : 'sorted-desc');
        sortRows();
        applySearch();
      });

      function sortRows() {
        allRows.sort(function(a, b) {
          var aVal, bVal;
          if (currentSortCol === 4) {
            aVal = a.cells[4].getAttribute('data-ts') || '';
            bVal = b.cells[4].getAttribute('data-ts') || '';
          } else {
            aVal = (a.cells[currentSortCol].textContent || '').toLowerCase();
            bVal = (b.cells[currentSortCol].textContent || '').toLowerCase();
          }
          if (aVal < bVal) return currentSortAsc ? -1 : 1;
          if (aVal > bVal) return currentSortAsc ? 1 : -1;
          return 0;
        });
      }

      searchInput.addEventListener('input', applySearch);

      function applySearch() {
        var term = searchInput.value.toLowerCase().trim();
        var visible = 0;
        allRows.forEach(function(row) {
          var text = row.textContent.toLowerCase();
          var show = !term || text.indexOf(term) !== -1;
          row.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        allRows.forEach(function(row) { tbody.appendChild(row); });
        countEl.textContent = visible + ' record' + (visible !== 1 ? 's' : '');
      }
    })();
    </script>
  </body>
  </html>
  `;

  return new Response(html, {
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });
}