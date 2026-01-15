import { getSupabaseServerClient } from '../supabase/serverClient';
import type { BudgetEventRow, Uuid } from '../types/supabase';

export interface BudgetEventInsert {
  household_id: Uuid;
  actor_user_id: Uuid | null;
  type: string;
  payload: unknown;
}

export async function hasRecentObservedTransfer(opts: {
  householdId: Uuid;
  fromPodId: Uuid;
  toPodId: Uuid;
  amountInCents: number;
}): Promise<boolean> {
  const supabase = getSupabaseServerClient();
  const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('budget_events')
    .select('id')
    .eq('household_id', opts.householdId)
    .eq('type', 'observed_transfer')
    .eq('payload->>from_pod_id', opts.fromPodId)
    .eq('payload->>to_pod_id', opts.toPodId)
    .eq('payload->>amount_in_cents', String(opts.amountInCents))
    .gte('created_at', sinceIso)
    .limit(1);

  if (error) {
    throw new Error(`budget_events observed_transfer dedup query failed: ${error.message}`);
  }

  return (data?.length ?? 0) > 0;
}

export async function insertBudgetEvents(
  events: BudgetEventInsert[],
): Promise<BudgetEventRow[]> {
  if (events.length === 0) return [];

  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('budget_events')
    .insert(
      events.map((e) => ({
        household_id: e.household_id,
        actor_user_id: e.actor_user_id,
        type: e.type,
        payload: e.payload,
      })),
    )
    .select('*');

  if (error) {
    throw new Error(`budget_events insert failed: ${error.message}`);
  }

  return (data as BudgetEventRow[]) ?? [];
}

