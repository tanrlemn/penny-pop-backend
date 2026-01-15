import { getSupabaseServerClient } from '../supabase/serverClient';
import type { Uuid } from '../types/supabase';

export async function listHouseholdIdsForUser(userId: Uuid): Promise<Uuid[]> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`household_members lookup failed: ${error.message}`);
  }

  return (data ?? []).map((row) => row.household_id as Uuid);
}

export async function assertUserInHousehold(
  userId: Uuid,
  householdId: Uuid,
): Promise<void> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', userId)
    .eq('household_id', householdId)
    .maybeSingle();

  if (error) {
    throw new Error(`household membership check failed: ${error.message}`);
  }
  if (!data) {
    throw new Error('User is not a member of this household');
  }
}

