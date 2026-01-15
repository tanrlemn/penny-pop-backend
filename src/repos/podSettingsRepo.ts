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

