import { getSupabaseServerClient } from '../supabase/serverClient';
import type { ProposedAction } from '../types/chat';
import type { ProposedActionDraft } from '../types/chat';
import type { ProposedActionRow, Uuid } from '../types/supabase';

export async function insertProposedActions(opts: {
  householdId: Uuid;
  assistantMessageId: Uuid;
  actionDrafts: ProposedActionDraft[];
}): Promise<ProposedActionRow[]> {
  if (opts.actionDrafts.length === 0) return [];

  const supabase = getSupabaseServerClient();
  const rows = opts.actionDrafts.map((a) => ({
    household_id: opts.householdId,
    message_id: opts.assistantMessageId,
    type: a.type,
    payload_json: a.payload,
    status: 'proposed',
  }));

  const { data, error } = await supabase
    .from('proposed_actions')
    .insert(rows)
    .select('*');

  if (error) {
    throw new Error(`proposed_actions insert failed: ${error.message}`);
  }

  return (data as ProposedActionRow[]) ?? [];
}

export async function getProposedActionsForHouseholdByIds(opts: {
  householdId: Uuid;
  actionIds: Uuid[];
}): Promise<ProposedActionRow[]> {
  if (opts.actionIds.length === 0) return [];

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('proposed_actions')
    .select('*')
    .eq('household_id', opts.householdId)
    .in('id', opts.actionIds);

  if (error) {
    throw new Error(`proposed_actions lookup failed: ${error.message}`);
  }
  return (data as ProposedActionRow[]) ?? [];
}

export async function markProposedActionsApplied(opts: {
  householdId: Uuid;
  actionIds: Uuid[];
  appliedBy: Uuid;
  appliedAtISO: string;
}): Promise<void> {
  if (opts.actionIds.length === 0) return;

  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from('proposed_actions')
    .update({
      status: 'applied',
      applied_by: opts.appliedBy,
      applied_at: opts.appliedAtISO,
    })
    .eq('household_id', opts.householdId)
    .in('id', opts.actionIds);

  if (error) {
    throw new Error(`proposed_actions mark applied failed: ${error.message}`);
  }
}

export async function markProposedActionFailed(opts: {
  householdId: Uuid;
  actionId: Uuid;
  appliedBy: Uuid;
  appliedAtISO: string;
}): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from('proposed_actions')
    .update({
      status: 'failed',
      applied_by: opts.appliedBy,
      applied_at: opts.appliedAtISO,
    })
    .eq('household_id', opts.householdId)
    .eq('id', opts.actionId);

  if (error) {
    throw new Error(`proposed_actions mark failed failed: ${error.message}`);
  }
}

export function toApiProposedAction(row: ProposedActionRow): ProposedAction {
  return {
    id: row.id,
    type: row.type as ProposedAction['type'],
    payload: row.payload_json as any,
    status: row.status,
  };
}

