import { getSupabaseServerClient } from '../supabase/serverClient';
import type { BudgetEventRow, Uuid } from '../types/supabase';

export interface BudgetEventInsert {
  household_id: Uuid;
  actor_user_id: Uuid | null;
  type: string;
  payload: unknown;
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

