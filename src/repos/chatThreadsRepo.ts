import { getSupabaseServerClient } from '../supabase/serverClient';
import type { ChatThreadRow, Uuid } from '../types/supabase';

export async function getOrCreateChatThreadForHousehold(
  householdId: Uuid,
): Promise<ChatThreadRow> {
  const supabase = getSupabaseServerClient();

  const { data: existing, error: lookupError } = await supabase
    .from('chat_threads')
    .select('*')
    .eq('household_id', householdId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`chat_threads lookup failed: ${lookupError.message}`);
  }
  if (existing) return existing as ChatThreadRow;

  const { data: created, error: createError } = await supabase
    .from('chat_threads')
    .insert({ household_id: householdId })
    .select('*')
    .single();

  if (!createError) return created as ChatThreadRow;

  // Race with unique(household_id): fall back to read.
  const { data: existing2, error: lookup2Error } = await supabase
    .from('chat_threads')
    .select('*')
    .eq('household_id', householdId)
    .single();

  if (lookup2Error) {
    throw new Error(
      `chat_threads create failed: ${createError.message}; follow-up lookup failed: ${lookup2Error.message}`,
    );
  }
  return existing2 as ChatThreadRow;
}

