import { getSupabaseServerClient } from '../supabase/serverClient';
import type { PodSettingsRow, Uuid } from '../types/supabase';

export async function getPodSettingsByPodId(
  podId: Uuid,
): Promise<PodSettingsRow | null> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('pod_settings')
    .select('*')
    .eq('pod_id', podId)
    .maybeSingle();

  if (error) {
    throw new Error(`pod_settings lookup failed: ${error.message}`);
  }

  return (data as PodSettingsRow | null) ?? null;
}

export async function listPodSettingsByPodIds(
  podIds: Uuid[],
): Promise<PodSettingsRow[]> {
  if (podIds.length === 0) return [];

  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('pod_settings')
    .select('*')
    .in('pod_id', podIds);

  if (error) {
    throw new Error(`pod_settings lookup failed: ${error.message}`);
  }

  return (data as PodSettingsRow[]) ?? [];
}

export async function upsertPodBudgetedAmountInCents(opts: {
  podId: Uuid;
  budgetedAmountInCents: number | null;
}): Promise<PodSettingsRow> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('pod_settings')
    .upsert(
      {
        pod_id: opts.podId,
        budgeted_amount_in_cents: opts.budgetedAmountInCents,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'pod_id' },
    )
    .select('*')
    .single();

  if (error) {
    throw new Error(`pod_settings upsert failed: ${error.message}`);
  }

  return data as PodSettingsRow;
}

export async function upsertPodBudgetedAmountsInCents(
  updates: Array<{ podId: Uuid; budgetedAmountInCents: number | null }>,
): Promise<PodSettingsRow[]> {
  if (updates.length === 0) return [];

  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();
  const rows = updates.map((u) => ({
    pod_id: u.podId,
    budgeted_amount_in_cents: u.budgetedAmountInCents,
    updated_at: now,
  }));

  const { data, error } = await supabase
    .from('pod_settings')
    .upsert(rows, { onConflict: 'pod_id' })
    .select('*');

  if (error) {
    throw new Error(`pod_settings bulk upsert failed: ${error.message}`);
  }

  return (data as PodSettingsRow[]) ?? [];
}

