const { createClient } = require('@supabase/supabase-js');

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('SUPABASE_JWT does not look like a JWT');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const baseUrl = requireEnv('API_BASE_URL').replace(/\/+$/, '');
  const jwt = requireEnv('SUPABASE_JWT');
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
  const householdIdOverride = process.env.HOUSEHOLD_ID;

  const supabase = createClient(supabaseUrl, supabaseKey);

  const jwtPayload = parseJwt(jwt);
  const userId = jwtPayload.sub || jwtPayload.user_id;
  if (!userId) {
    throw new Error('Unable to determine user id from SUPABASE_JWT payload.');
  }

  let householdId = householdIdOverride;
  if (!householdId) {
    const { data: memberships, error } = await supabase
      .from('household_members')
      .select('household_id')
      .eq('user_id', userId);
    if (error) {
      throw new Error(`household_members lookup failed: ${error.message}`);
    }
    if (!memberships || memberships.length === 0) {
      throw new Error(`No household_members rows found for user ${userId}`);
    }
    householdId = memberships[0].household_id;
  }

  const { data: pods, error: podsError } = await supabase
    .from('pods')
    .select('id, name, household_id, is_active')
    .eq('household_id', householdId)
    .eq('is_active', true);
  if (podsError) {
    throw new Error(`pods lookup failed: ${podsError.message}`);
  }
  if (!pods || pods.length === 0) {
    throw new Error(`No active pods found for household ${householdId}`);
  }

  const targetPod = pods[0];
  const messageText =
    process.env.MESSAGE_TEXT || `${targetPod.name} is short $5`;

  const { data: beforeSettings, error: beforeError } = await supabase
    .from('pod_settings')
    .select('pod_id, budgeted_amount_in_cents')
    .in('pod_id', [targetPod.id]);
  if (beforeError) {
    throw new Error(`pod_settings lookup failed: ${beforeError.message}`);
  }
  const beforeBudget =
    beforeSettings?.find((row) => row.pod_id === targetPod.id)
      ?.budgeted_amount_in_cents ?? 0;

  const chatResponse = await fetchJson(`${baseUrl}/api/chat/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ householdId, messageText }),
  });

  const proposedActions = chatResponse?.proposedActions ?? [];
  if (!Array.isArray(proposedActions) || proposedActions.length === 0) {
    throw new Error(`No proposedActions returned. Response: ${JSON.stringify(chatResponse)}`);
  }
  const actionId = proposedActions[0]?.id;
  if (!actionId) {
    throw new Error(`First proposed action missing id. Response: ${JSON.stringify(chatResponse)}`);
  }

  const applyResponse = await fetchJson(`${baseUrl}/api/actions/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ householdId, actionIds: [actionId] }),
  });

  const { data: afterSettings, error: afterError } = await supabase
    .from('pod_settings')
    .select('pod_id, budgeted_amount_in_cents')
    .in('pod_id', [targetPod.id]);
  if (afterError) {
    throw new Error(`pod_settings lookup failed: ${afterError.message}`);
  }
  const afterBudget =
    afterSettings?.find((row) => row.pod_id === targetPod.id)
      ?.budgeted_amount_in_cents ?? 0;

  if (afterBudget === beforeBudget) {
    throw new Error(
      `Budget did not change for pod ${targetPod.name} (${targetPod.id}). ` +
        `Before=${beforeBudget} After=${afterBudget}`,
    );
  }

  console.log('✅ Smoke test passed');
  console.log(`Household: ${householdId}`);
  console.log(`Pod: ${targetPod.name} (${targetPod.id})`);
  console.log(`Budgeted before: ${beforeBudget}`);
  console.log(`Budgeted after: ${afterBudget}`);
  console.log('Proposed action id:', actionId);
  console.log('Apply response snapshot:', JSON.stringify(applyResponse, null, 2));
}

main().catch((err) => {
  console.error('❌ Smoke test failed');
  console.error(err);
  process.exit(1);
});
