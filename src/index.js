// This is the main Worker script that handles both HTTP requests and scheduled events.

export default {
  /**
   * The `fetch` handler is triggered when the Worker's hostname is called (HTTP request).
   * It processes incoming HTTP requests and sends back responses.
   *
   * @param {Request} request The incoming HTTP request.
   * @param {Env} env Environment variables and bindings (e.g., API_KEY, ACCOUNT_ID, GATEWAY_RULE_IDS_KV).
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   * @returns {Response} The HTTP response.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- /admin dashboard route ---
    if (url.pathname === '/admin') {
      return await handleAdminDashboard(env);
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
    const ruleName = isPost ? formData.get('cf_rule_name') : null; // Rule name carried forward from GET via hidden field
    const pageLoadTime = isPost ? (formData.get('page_load_time') || '') : ''; // Original page load timestamp carried forward from GET

    const rawUser = cfUserEmail ? cfUserEmail.split('@')[0] : 'there';
    const user = rawUser.charAt(0).toUpperCase() + rawUser.charAt(1).toLowerCase() + rawUser.slice(2); // Capitalize first letter, lowercase rest

    let gatewayRuleUpdateStatus = 'No Gateway rule update attempted.';
    let kvStoreStatus = 'No KV store update attempted.';
    let fetchedRuleName = ruleName || ''; // Will be populated from API on GET, or from hidden field on POST
    let justificationSubmitted = false;
    let justificationError = '';

    // --- Handle POST: store business justification in KV ---
    if (isPost) {
        if (!justificationText) {
            justificationError = 'Please provide a business justification before proceeding.';
        } else if (cfUserEmail && cfRuleId && env.GATEWAY_RULE_IDS_KV) {
            try {
                const justificationKey = `justification:${crypto.randomUUID()}`;
                const justificationEntry = {
                    timestamp: new Date().toISOString(),
                    userEmail: cfUserEmail,
                    ruleId: cfRuleId,
                    ruleName: fetchedRuleName,
                    justification: justificationText,
                };
                ctx.waitUntil(env.GATEWAY_RULE_IDS_KV.put(justificationKey, JSON.stringify(justificationEntry)));
                console.log(`KV: Stored justification with key ${justificationKey}`);
                justificationSubmitted = true;
            } catch (kvError) {
                console.error('Error storing justification in KV:', kvError);
                justificationError = `Failed to store justification: ${kvError.message || kvError}`;
            }
        } else {
            justificationError = 'Missing required parameters to store justification.';
        }
    }

    // --- Logic to update Cloudflare Gateway rule (only on GET) ---
    // This logic should always run if necessary parameters are present.
    if (!isPost && cfUserEmail && cfRuleId && env.API_KEY && env.USER_EMAIL && env.ACCOUNT_ID) {
        try {
            console.log(`Attempting to update Gateway Rule ${cfRuleId} with identity ${cfUserEmail}`);

            // First, get the existing rule to determine its current configuration
            const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
            const getRuleResponse = await fetch(getRuleUrl, {
                method: 'GET',
                headers: {
					'X-Auth-Email': env.USER_EMAIL,
                    'X-Auth-Key': env.API_KEY,
                    'Content-Type': 'application/json',
                },
            });

            if (!getRuleResponse.ok) {
                const errorText = await getRuleResponse.text();
                console.error(`Failed to get Gateway Rule: ${getRuleResponse.status} - ${errorText}`);
                gatewayRuleUpdateStatus = `Error getting Gateway Rule: ${getRuleResponse.status}`;
            } else {
                const existingRuleData = await getRuleResponse.json();
                const existingRule = existingRuleData.result;

                if (!existingRule) {
                    console.error('Existing rule not found in GET response.');
                    gatewayRuleUpdateStatus = 'Error: Existing rule not found.';
                } else {
                    console.log('Existing rule details:', existingRule);

                    // Extract rule name from the API response
                    fetchedRuleName = existingRule.name || '';
                    console.log(`Fetched rule name: ${fetchedRuleName}`);

                    const updatedRulePayload = { ...existingRule };
                    let ruleIdentityActuallyModified = false;

                    // --- Logic to update the 'identity' field ---
                    const currentIdentityExpression = updatedRulePayload.identity;
                    const newEmailToAdd = `"${cfUserEmail}"`;

                    if (currentIdentityExpression === "") {
                        // Scenario 1: Identity field is empty
                        updatedRulePayload.identity = `not(identity.email in {${newEmailToAdd}})`;
                        console.log(`Initialized identity expression: ${updatedRulePayload.identity}`);
                        ruleIdentityActuallyModified = true;
                    } else if (currentIdentityExpression && currentIdentityExpression.includes('identity.email in {')) {
                        // Scenario 2: Identity field has existing expression
                        const regex = /\{"([^"]+(?:"\s*"[^"]+)*)"\}/;
                        const match = currentIdentityExpression.match(regex);

                        if (match && match[1]) {
                            const existingEmailsString = match[1];
                            const existingEmails = existingEmailsString.split('" "').filter(Boolean).map(e => `"${e}"`);

                            if (!existingEmails.includes(newEmailToAdd)) {
                                existingEmails.push(newEmailToAdd);
                                const updatedEmailsString = existingEmails.map(e => e.slice(1, -1)).join('" "');
                                updatedRulePayload.identity = currentIdentityExpression.replace(regex, `{"${updatedEmailsString}"}`);
                                console.log(`Updated identity expression: ${updatedRulePayload.identity}`);
                                ruleIdentityActuallyModified = true;
                            } else {
                                console.log(`Identity ${cfUserEmail} already present in the rule. No change to rule's identity field needed.`);
                                ruleIdentityActuallyModified = false;
                            }
                        } else {
                            console.warn('Could not parse existing identity expression:', currentIdentityExpression);
                            gatewayRuleUpdateStatus = 'Warning: Could not parse rule identity expression.';
                        }
                    } else {
                        // Scenario 3: Identity field exists but is not in expected format
                        console.warn('Identity field not in expected format. Cannot automatically add email:', currentIdentityExpression);
                        gatewayRuleUpdateStatus = 'Warning: Rule identity field not in expected format.';
                    }

                    // --- Proceed with the PUT request to update the rule (always if parameters are met) ---
                    const updateRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const updateRuleResponse = await fetch(updateRuleUrl, {
                        method: 'PUT',
                        headers: {
							'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatedRulePayload),
                    });

                    if (!updateRuleResponse.ok) {
                        const errorText = await updateRuleResponse.text();
                        console.error(`Failed to update Gateway Rule: ${updateRuleResponse.status} - ${errorText}`);
                        gatewayRuleUpdateStatus = `Error updating Gateway Rule: ${updateRuleResponse.status} - ${errorText}`;
                    } else {
                        const updatedRuleResult = await updateRuleResponse.json();
                        console.log(`Successfully updated Gateway Rule ${cfRuleId}.`, updatedRuleResult);
                        gatewayRuleUpdateStatus = `Successfully updated Gateway Rule ${cfRuleId}.`;
                    }
                }
            }
        } catch (apiError) {
            console.error('Error during Cloudflare API call (GET or PUT):', apiError);
            gatewayRuleUpdateStatus = `API Error: ${apiError.message || apiError}`;
        }

        // --- Logic to update Cloudflare KV store (only if cf_rule_id is new to KV) ---
        // This runs independently after the Gateway rule update attempt.
        if (env.GATEWAY_RULE_IDS_KV) {
            try {
                const existingKvEntry = await env.GATEWAY_RULE_IDS_KV.get(cfRuleId);

                if (existingKvEntry) {
                    console.log(`KV: Rule ID ${cfRuleId} already exists in KV. Skipping KV store update.`);
                    kvStoreStatus = `Rule ID ${cfRuleId} already tracked in KV.`;
                } else {
                    // Store cf_rule_id in KV only if it's new
                    // Use ctx.waitUntil to ensure KV write completes even if HTTP response is sent early
                    ctx.waitUntil(env.GATEWAY_RULE_IDS_KV.put(cfRuleId, JSON.stringify({
                        firstTrackedAt: new Date().toISOString(),
                        firstUserEmail: cfUserEmail
                    })));
                    console.log(`KV: Stored new Rule ID ${cfRuleId} in KV.`);
                    kvStoreStatus = `Rule ID ${cfRuleId} stored in KV.`;
                }
            } catch (kvError) {
                console.error('Error during Cloudflare KV call:', kvError);
                kvStoreStatus = `KV Error: ${kvError.message || kvError}`;
            }
        } else {
            console.warn('KV Namespace binding GATEWAY_RULE_IDS_KV is not configured. Cannot track rule IDs in KV.');
            kvStoreStatus = 'KV store not configured for tracking rule IDs.';
        }

    } else if (!isPost) {
        console.log('Skipping Gateway Rule update: Missing cfUserEmail, cfRuleId, API Token, or Account ID.');
        gatewayRuleUpdateStatus = 'Skipped: Missing parameters or config.';
        kvStoreStatus = 'Skipped: Missing parameters or config.';
    }

    // Determine whether to show the proceed link
    const showProceedLink = justificationSubmitted && cfSiteUri;

    // Build the current page URL with query params for the form action
    const formActionUrl = url.origin + url.pathname;

    // Server timestamp: on GET this is the initial page load time; on POST it is carried forward from the form
    const serverTimestamp = pageLoadTime || new Date().toISOString();

    // Calculate elapsed seconds on the server to avoid client/server clock skew
    const elapsedSeconds = pageLoadTime ? Math.floor((new Date().getTime() - new Date(pageLoadTime).getTime()) / 1000) : 0;

    // --- HTML generation ---
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Coaching page</title>
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

            header {
                text-align: center;
                margin-bottom: 2rem;
            }

            header img {
                width: 100px; /* Adjusted image size */
                height: auto;
                margin-bottom: 1rem;
            }

            .title {
                font-size: 2rem;
                font-weight: 600;
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
        <div id="container">
            <header>
                <img src="https://pub-468cf04c27cf401e8a928bd7ea22e060.r2.dev/warning.jpg" alt="Warning Icon">
                <h1 class="title">Hello ${user},</h1>
                <p class="subtitle">
                    Your attempt to access the requested resource has been flagged by your organization's web filtering policy.
                    This page serves as a reminder that all access to this category of resource is monitored and logged in accordance with company security policies.
                </p>
                <p class="subtitle" style="margin-top: 0.75rem;">
                    If you have a valid business need to access this resource, please provide a justification below.
                    By proceeding, you acknowledge that your access will be recorded and may be subject to review.
                    Misuse of this exception may result in disciplinary action in accordance with the organization's acceptable use policy.
                </p>
            </header>
            <main>
                ${justificationSubmitted ? `
                <p class="success-message" style="text-align:center;">Justification submitted successfully. You may now proceed.</p>
                ` : `
                <form class="justification-form" method="POST" action="${formActionUrl}">
                    <input type="hidden" name="cf_user_email" value="${cfUserEmail || ''}">
                    <input type="hidden" name="cf_site_uri" value="${cfSiteUri || ''}">
                    <input type="hidden" name="cf_rule_id" value="${cfRuleId || ''}">
                    <input type="hidden" name="cf_rule_name" value="${fetchedRuleName}">
                    <input type="hidden" name="page_load_time" value="${serverTimestamp}">
                    <label for="justification">Business Justification <span style="color:#dc3545;">*</span></label>
                    <textarea id="justification" name="justification" placeholder="Please explain why you need access to this resource..." required>${justificationText}</textarea>
                    ${justificationError ? `<p class="error-message">${justificationError}</p>` : ''}
                    <div class="button-row">
                        <button type="submit">Submit Justification</button>
                        <span id="proceed-btn" class="proceed-btn disabled" data-href="${cfSiteUri || ''}" data-justified="${justificationSubmitted ? 'true' : 'false'}" data-elapsed="${elapsedSeconds}">Loading...</span>
                    </div>
                </form>
                `}
                ${justificationSubmitted ? `
                <p style="text-align:center; margin-top: 1rem;">
                    <span id="proceed-btn" class="proceed-btn disabled" data-href="${cfSiteUri || ''}" data-justified="true" data-elapsed="${elapsedSeconds}">Loading...</span>
                </p>
                ` : ''}
            </main>
            <footer>
                <p>&copy; 2024 Generated by Cloudflare Worker</p>
                <details>
                    <summary>Debug Information</summary>
                    <p><strong>Request URL:</strong> ${request.url}</p>
                    ${[...url.searchParams.entries()].map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`).join('')}
                    ${cfRuleId ? `<p><strong>Rule Name:</strong> ${fetchedRuleName}</p>` : ''}
                    ${cfRuleId ? `<p><strong>Gateway Rule Update Status:</strong> ${gatewayRuleUpdateStatus}</p>` : ''}
                    ${cfRuleId ? `<p><strong>KV Store Status:</strong> ${kvStoreStatus}</p>` : ''}
                </details>
            </footer>
        </div>
        <script>
            (function() {
                const btn = document.getElementById('proceed-btn');
                const href = btn.dataset.href;
                const justified = btn.dataset.justified === 'true';
                const totalSeconds = 45;
                const serverElapsed = parseInt(btn.dataset.elapsed, 10) || 0;
                let remaining = Math.max(0, totalSeconds - serverElapsed);

                function updateButton() {
                    if (justified && remaining <= 0 && href) {
                        // Both conditions met: activate the button
                        btn.className = 'proceed-btn active';
                        btn.textContent = 'Proceed to site';
                        btn.style.cursor = 'pointer';
                        btn.onclick = function() { window.location.href = href; };
                    } else if (justified && remaining > 0) {
                        // Justified but waiting on timer
                        btn.className = 'proceed-btn disabled';
                        btn.textContent = 'Proceed to site (' + remaining + 's)';
                    } else {
                        // Not justified yet
                        btn.className = 'proceed-btn disabled';
                        btn.textContent = remaining > 0
                            ? 'Submit justification to proceed (' + remaining + 's)'
                            : 'Submit justification to proceed';
                    }
                }

                updateButton();

                if (remaining > 0) {
                    var interval = setInterval(function() {
                        remaining--;
                        updateButton();
                        if (remaining <= 0) {
                            clearInterval(interval);
                        }
                    }, 1000);
                }
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
   * This function will iterate through all KV keys (cf_rule_ids) and update each
   * corresponding Gateway rule to empty its identity field.
   *
   * @param {ScheduledController} controller The scheduled event controller.
   * @param {Env} env Environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   */
  async scheduled(controller, env, ctx) {
    console.log(`Cron trigger for pattern: ${controller.cron}`);

    // Ensure necessary bindings are available for API calls
    if (!env.GATEWAY_RULE_IDS_KV) {
        console.error('KV Namespace binding GATEWAY_RULE_IDS_KV is not configured for scheduled task.');
        return; // Exit if KV is not available
    }
    if (!env.API_KEY || !env.ACCOUNT_ID || !env.USER_EMAIL) {
        console.error('Cloudflare API Key, User Email, or Account ID not configured for scheduled task.');
        return; // Exit if API credentials are not available
    }

    const ruleUpdateTasks = []; // Array to hold promises of individual rule updates
    const kvKeysToDelete = []; // Array to store keys for deletion later

    try {
      let cursor = null;
      let isTruncated = true;

      // 1. Iterate through all keys in the KV namespace (handle pagination)
      while (isTruncated) {
        const listResult = await env.GATEWAY_RULE_IDS_KV.list({ cursor: cursor });
        const keys = listResult.keys;
        cursor = listResult.cursor;
        isTruncated = listResult.list_complete === false;

        for (const key of keys) {
            const cfRuleId = key.name;

            // Skip justification entries — they must be preserved
            if (cfRuleId.startsWith('justification:')) {
                console.log(`Skipping justification entry: ${cfRuleId}`);
                continue;
            }

            console.log(`Processing rule ID from KV: ${cfRuleId}`);
            kvKeysToDelete.push(cfRuleId); // Add key to list for deletion

            // Add each rule update task to the ruleUpdateTasks array as a promise
            ruleUpdateTasks.push((async () => {
                try {
                    // 1. Get the existing rule
                    const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const getRuleResponse = await fetch(getRuleUrl, {
                        method: 'GET',
                        headers: {
                            'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
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
                            'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatedRulePayload),
                    });

                    if (!updateRuleResponse.ok) {
                        const errorText = await updateRuleResponse.text();
                        console.error(`Scheduled Task: Failed to update Gateway Rule ${cfRuleId}: ${updateRuleResponse.status} - ${errorText}`);
                    } else {
                        console.log(`Scheduled Task: Successfully emptied identity for Gateway Rule ${cfRuleId}.`);
                    }
                } catch (ruleError) {
                    console.error(`Scheduled Task: Error processing Gateway Rule ${cfRuleId}:`, ruleError);
                }
            })()); // Immediately invoke the async function
        }
      }
    } catch (listError) {
      console.error('Scheduled Task: Error listing KV keys:', listError);
    }

    // 2. Wait for all rule updates to complete
    await Promise.allSettled(ruleUpdateTasks);
    console.log('Scheduled task completed all rule identity resetting operations.');

    // 3. Delete all processed KV keys
    if (kvKeysToDelete.length > 0) {
        console.log(`Scheduled Task: Deleting ${kvKeysToDelete.length} keys from KV.`);
        const deleteTasks = kvKeysToDelete.map(key => env.GATEWAY_RULE_IDS_KV.delete(key));
        try {
            await Promise.allSettled(deleteTasks);
            console.log('Scheduled Task: All KV keys successfully deleted.');
        } catch (deleteError) {
            console.error('Scheduled Task: Error deleting KV keys:', deleteError);
        }
    } else {
        console.log('Scheduled Task: No KV keys found to delete.');
    }

    console.log('Scheduled task finished.');
  },
};

/**
 * Handles the /admin dashboard route.
 * Fetches all justification entries from KV and renders an HTML dashboard table
 * with client-side sorting and search.
 *
 * @param {Env} env Environment variables and bindings.
 * @returns {Response} HTML response with the admin dashboard.
 */
async function handleAdminDashboard(env) {
  const justifications = [];

  if (env.GATEWAY_RULE_IDS_KV) {
    try {
      let cursor = null;
      let isTruncated = true;

      while (isTruncated) {
        const listResult = await env.GATEWAY_RULE_IDS_KV.list({ cursor, prefix: 'justification:' });
        cursor = listResult.cursor;
        isTruncated = listResult.list_complete === false;

        const valueFetches = listResult.keys.map(async (key) => {
          try {
            const value = await env.GATEWAY_RULE_IDS_KV.get(key.name);
            if (value) {
              return JSON.parse(value);
            }
          } catch (e) {
            console.error(`Failed to fetch/parse KV key ${key.name}:`, e);
          }
          return null;
        });

        const results = await Promise.all(valueFetches);
        justifications.push(...results.filter(Boolean));
      }
    } catch (e) {
      console.error('Error listing justification keys from KV:', e);
    }
  }

  // Sort by timestamp descending (most recent first) as default
  justifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Escape HTML to prevent XSS from stored values
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const tableRows = justifications.map((j) => `
    <tr>
      <td>${esc(j.ruleName)}</td>
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
    <title>Coaching Page — Admin Dashboard</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        line-height: 1.6;
        background-color: #f8f9fa;
        color: #333;
        padding: 2rem;
      }

      .dashboard {
        max-width: 1200px;
        margin: 0 auto;
      }

      h1 {
        font-size: 1.6rem;
        font-weight: 600;
        color: #2c3e50;
        margin-bottom: 0.25rem;
      }

      .subtitle {
        color: #777;
        font-size: 0.95rem;
        margin-bottom: 1.5rem;
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
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.95rem;
        font-family: inherit;
      }

      .controls input[type="text"]:focus {
        outline: none;
        border-color: #007bff;
        box-shadow: 0 0 0 2px rgba(0,123,255,0.15);
      }

      .record-count {
        font-size: 0.85rem;
        color: #888;
        white-space: nowrap;
      }

      .table-wrap {
        overflow-x: auto;
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.06);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }

      thead th {
        background: #f1f3f5;
        text-align: left;
        padding: 0.65rem 0.75rem;
        font-weight: 600;
        color: #2c3e50;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        border-bottom: 2px solid #dee2e6;
      }

      thead th:hover { background: #e2e6ea; }

      thead th .sort-arrow {
        display: inline-block;
        width: 1em;
        text-align: center;
        color: #aaa;
        font-size: 0.75rem;
      }

      thead th.sorted-asc .sort-arrow::after { content: '\\25B2'; color: #2c3e50; }
      thead th.sorted-desc .sort-arrow::after { content: '\\25BC'; color: #2c3e50; }
      thead th:not(.sorted-asc):not(.sorted-desc) .sort-arrow::after { content: '\\25B4\\25BE'; }

      tbody tr { border-bottom: 1px solid #eee; }
      tbody tr:last-child { border-bottom: none; }
      tbody tr:hover { background: #f8f9fa; }

      td {
        padding: 0.6rem 0.75rem;
        vertical-align: top;
      }

      td:nth-child(5) {
        max-width: 350px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .empty-state {
        text-align: center;
        padding: 3rem 1rem;
        color: #999;
        font-size: 1rem;
      }

      footer {
        text-align: center;
        font-size: 0.75rem;
        color: #bbb;
        margin-top: 2rem;
      }
    </style>
  </head>
  <body>
    <div class="dashboard">
      <h1>Coaching Page — Admin Dashboard</h1>
      <p class="subtitle">Business justification records from coaching page interactions.</p>

      <div class="controls">
        <input type="text" id="search" placeholder="Search by rule name, email, justification...">
        <span class="record-count" id="record-count">${justifications.length} record${justifications.length !== 1 ? 's' : ''}</span>
      </div>

      <div class="table-wrap">
        ${justifications.length === 0 ? `
        <div class="empty-state">No justification records found.</div>
        ` : `
        <table id="dashboard-table">
          <thead>
            <tr>
              <th data-col="0" class="sorted-desc">Rule Name <span class="sort-arrow"></span></th>
              <th data-col="1">Rule ID <span class="sort-arrow"></span></th>
              <th data-col="2">User Email <span class="sort-arrow"></span></th>
              <th data-col="3" class="sorted-desc">Timestamp <span class="sort-arrow"></span></th>
              <th data-col="4">Justification <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
        `}
      </div>

      <footer>
        <p>&copy; 2024 Generated by Cloudflare Worker</p>
      </footer>
    </div>

    <script>
    (function() {
      var table = document.getElementById('dashboard-table');
      if (!table) return;

      var thead = table.querySelector('thead');
      var tbody = table.querySelector('tbody');
      var searchInput = document.getElementById('search');
      var countEl = document.getElementById('record-count');
      var allRows = Array.from(tbody.querySelectorAll('tr'));
      var currentSortCol = 3;  // default sort by timestamp
      var currentSortAsc = false; // default descending

      // --- Sorting ---
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

        // Update header classes
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
          if (currentSortCol === 3) {
            // Sort by raw timestamp
            aVal = a.cells[3].getAttribute('data-ts') || '';
            bVal = b.cells[3].getAttribute('data-ts') || '';
          } else {
            aVal = (a.cells[currentSortCol].textContent || '').toLowerCase();
            bVal = (b.cells[currentSortCol].textContent || '').toLowerCase();
          }
          if (aVal < bVal) return currentSortAsc ? -1 : 1;
          if (aVal > bVal) return currentSortAsc ? 1 : -1;
          return 0;
        });
      }

      // --- Search / Filter ---
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
        // Re-append rows in sorted order
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