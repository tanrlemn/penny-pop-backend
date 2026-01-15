import { getSupabaseServerClient } from '../supabase/serverClient';
import type { PodRow, PodWithSettings, Uuid } from '../types/supabase';
import { listHouseholdIdsForUser } from './householdsRepo';
import { listPodSettingsByPodIds } from './podSettingsRepo';

export async function listPodsForHousehold(
  householdId: Uuid,
  opts?: { activeOnly?: boolean },
): Promise<PodRow[]> {
  const activeOnly = opts?.activeOnly ?? true;
  const supabase = getSupabaseServerClient();

  let query = supabase.from('pods').select('*').eq('household_id', householdId);
  if (activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query;

  if (error) {
    throw new Error(`pods lookup failed: ${error.message}`);
  }

  return (data as PodRow[]) ?? [];
}

export async function listPodsWithSettingsForHousehold(
  householdId: Uuid,
  opts?: { activeOnly?: boolean },
): Promise<PodWithSettings[]> {
  const pods = await listPodsForHousehold(householdId, opts);
  if (pods.length === 0) return [];

  const settings = await listPodSettingsByPodIds(pods.map((p) => p.id));
  const settingsByPodId = new Map(settings.map((s) => [s.pod_id, s] as const));

  return pods.map((pod) => ({
    pod,
    settings: settingsByPodId.get(pod.id) ?? null,
  }));
}

export async function listActivePodsWithSettingsForUser(
  userId: Uuid,
): Promise<PodWithSettings[]> {
  const householdIds = await listHouseholdIdsForUser(userId);
  if (householdIds.length === 0) return [];

  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('pods')
    .select('*')
    .in('household_id', householdIds)
    .eq('is_active', true);

  if (error) {
    throw new Error(`pods lookup failed: ${error.message}`);
  }

  const pods = ((data as PodRow[]) ?? []).filter((p) =>
    householdIds.includes(p.household_id),
  );
  if (pods.length === 0) return [];

  const settings = await listPodSettingsByPodIds(pods.map((p) => p.id));
  const settingsByPodId = new Map(settings.map((s) => [s.pod_id, s] as const));

  return pods.map((pod) => ({
    pod,
    settings: settingsByPodId.get(pod.id) ?? null,
  }));
}

