import { verifyUser } from '../auth/verifyUser';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import { getSupabaseServerClient } from '../supabase/serverClient';
import type { OverviewResponseBody, AttentionQueueItem } from '../types/overview';
import type { PodWithSettings, Uuid } from '../types/supabase';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

// curl -s "$API_URL/api/overview?householdId=..." -H "Authorization: Bearer $JWT"

function toStringParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function sumBudgetedAmount(pods: PodWithSettings[], filter: (p: PodWithSettings) => boolean): number {
  let total = 0;
  for (const pod of pods) {
    if (!filter(pod)) continue;
    total += pod.settings?.budgeted_amount_in_cents ?? 0;
  }
  return total;
}

function maxIsoTimestamp(values: Array<string | null>): string | null {
  let maxTime = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) continue;
    if (parsed > maxTime) maxTime = parsed;
  }
  if (!Number.isFinite(maxTime)) return null;
  return new Date(maxTime).toISOString();
}

function buildAttentionQueue(opts: {
  leftToBudgetCents: number;
  balanceErrorPods: PodWithSettings[];
  latestBalanceUpdatedAt: string | null;
}): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];

  if (opts.leftToBudgetCents < 0) {
    const amount = Math.abs(opts.leftToBudgetCents);
    items.push({
      id: 'over_budget',
      type: 'over_budget',
      severity: 'high',
      title: 'Over budget',
      subtitle: `Budget exceeds income by ${amount} cents.`,
      cta: { label: 'Review budget', action: 'review_budget' },
      data: { amountCents: amount },
    });
  }

  if (opts.leftToBudgetCents > 0) {
    items.push({
      id: 'unassigned',
      type: 'unassigned',
      severity: 'medium',
      title: 'Unassigned income',
      subtitle: `You have ${opts.leftToBudgetCents} cents left to budget.`,
      cta: { label: 'Assign budget', action: 'assign_budget' },
      data: { amountCents: opts.leftToBudgetCents },
    });
  }

  if (opts.balanceErrorPods.length > 0) {
    const sampleNames = opts.balanceErrorPods.slice(0, 3).map((p) => p.pod.name);
    const extraCount = Math.max(0, opts.balanceErrorPods.length - sampleNames.length);
    const sampleSuffix = extraCount > 0 ? ` +${extraCount} more` : '';
    const sampleLabel =
      sampleNames.length > 0
        ? `Balance errors in ${sampleNames.join(', ')}${sampleSuffix}.`
        : 'Balance errors in multiple pods.';
    items.push({
      id: 'balance_error',
      type: 'balance_error',
      severity: 'high',
      title: 'Balance errors',
      subtitle: sampleLabel,
      cta: { label: 'Review balances', action: 'review_balance_errors' },
      data: { count: opts.balanceErrorPods.length, podNames: sampleNames },
    });
  }

  const now = Date.now();
  const latest = opts.latestBalanceUpdatedAt ? Date.parse(opts.latestBalanceUpdatedAt) : null;
  const staleMinutes = latest ? Math.floor((now - latest) / (60 * 1000)) : null;
  const isStale = latest === null || now - latest > 15 * 60 * 1000;
  if (isStale) {
    items.push({
      id: 'balances_stale',
      type: 'balances_stale',
      severity: 'low',
      title: 'Balances are stale',
      subtitle:
        staleMinutes === null
          ? 'Balances have not been updated yet.'
          : `Last updated ${staleMinutes} minutes ago.`,
      cta: { label: 'Refresh balances', action: 'refresh_balances' },
      data: { minutesStale: staleMinutes },
    });
  }

  return items;
}

async function fetchTotalIncomeFromSources(householdId: Uuid): Promise<number | null> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('income_sources')
    .select('budgeted_amount_in_cents')
    .eq('household_id', householdId)
    .eq('is_active', true);

  if (error) {
    console.log('income_sources lookup failed', { message: error.message });
    return null;
  }

  let total = 0;
  for (const row of data ?? []) {
    total +=
      (row as { budgeted_amount_in_cents?: number | null }).budgeted_amount_in_cents ?? 0;
  }
  return total;
}

export async function handleOverview(opts: {
  method: string;
  headers: Record<string, any>;
  query: Record<string, any>;
}): Promise<HandlerResult> {
  if (opts.method !== 'GET') {
    return { status: 405, json: { error: 'Method not allowed' } };
  }

  try {
    const authorization = getHeader(opts.headers, 'authorization');
    const { userId } = await verifyUser(authorization);

    const householdId = toStringParam(opts.query?.householdId) as Uuid | undefined;
    if (!householdId) {
      return { status: 400, json: { error: 'Missing householdId' } };
    }

    await assertUserInHousehold(userId as Uuid, householdId);

    const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
      activeOnly: true,
    });

    const incomeFromSources = await fetchTotalIncomeFromSources(householdId);
    const totalIncomeCents =
      incomeFromSources ?? sumBudgetedAmount(podsWithSettings, (p) => p.settings?.category === 'Income');

    const totalBudgetedExpensesCents = sumBudgetedAmount(
      podsWithSettings,
      (p) => p.settings?.category !== 'Income',
    );

    const leftToBudgetCents = totalIncomeCents - totalBudgetedExpensesCents;
    const leftToBudgetPct =
      totalIncomeCents > 0 ? leftToBudgetCents / totalIncomeCents : null;

    const latestBalanceUpdatedAt = maxIsoTimestamp(
      podsWithSettings.map((p) => p.pod.balance_updated_at),
    );
    const balanceErrorPods = podsWithSettings.filter((p) => p.pod.balance_error != null);
    const attentionQueue = buildAttentionQueue({
      leftToBudgetCents,
      balanceErrorPods,
      latestBalanceUpdatedAt,
    });

    console.log('overview computed', {
      householdId,
      totalIncomeCents,
      totalBudgetedExpensesCents,
      leftToBudgetCents,
      podCount: podsWithSettings.length,
      attentionQueueCount: attentionQueue.length,
    });

    const response: OverviewResponseBody = {
      budget: {
        totalIncomeCents,
        totalBudgetedExpensesCents,
        leftToBudgetCents,
        leftToBudgetPct,
      },
      balances: {
        latestBalanceUpdatedAt,
        hasBalanceErrors: balanceErrorPods.length > 0,
        balanceErrorCount: balanceErrorPods.length,
      },
      attentionQueue,
    };

    return { status: 200, json: response };
  } catch (err) {
    const msg = asErrorMessage(err);
    console.log('overview handler error', { message: msg });
    const status =
      msg.includes('Missing Authorization header') ||
      msg.includes('Invalid Authorization') ||
      msg.includes('Invalid token') ||
      msg.includes('auth.getUser')
        ? 401
        : msg.includes('User is not a member of this household')
          ? 403
          : 500;

    return { status, json: { error: msg } };
  }
}
