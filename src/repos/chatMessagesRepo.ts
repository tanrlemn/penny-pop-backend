import { getSupabaseServerClient } from '../supabase/serverClient';
import type { ChatMessageRow, ChatMessageSenderRole, Uuid } from '../types/supabase';

export async function insertChatMessage(opts: {
  threadId: Uuid;
  senderRole: ChatMessageSenderRole;
  text: string;
  senderUserId?: Uuid | null;
}): Promise<ChatMessageRow> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      thread_id: opts.threadId,
      sender_role: opts.senderRole,
      sender_user_id: opts.senderUserId ?? null,
      text: opts.text,
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`chat_messages insert failed: ${error.message}`);
  }
  return data as ChatMessageRow;
}

