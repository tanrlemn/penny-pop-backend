export type Uuid = string;

export interface HouseholdRow {
  id: Uuid;
  name: string;
  created_by: Uuid;
  created_at: string; // timestamptz
}

export type HouseholdMemberRole = 'admin' | 'member';

export interface HouseholdMemberRow {
  household_id: Uuid;
  user_id: Uuid;
  role: HouseholdMemberRole;
  created_at: string; // timestamptz
}

export interface PodRow {
  id: Uuid;
  household_id: Uuid;
  sequence_account_id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string; // timestamptz
  created_at: string; // timestamptz
  balance_amount_in_cents: number | null;
  balance_error: string | null;
  balance_updated_at: string | null; // timestamptz
}

export type PodSettingsCategory =
  | 'Income'
  | 'Savings'
  | 'Kiddos'
  | 'Necessities'
  | 'Pressing'
  | 'Discretionary';

export interface PodSettingsRow {
  pod_id: Uuid;
  category: PodSettingsCategory | null;
  notes: string | null;
  updated_at: string; // timestamptz
  budgeted_amount_in_cents: number | null;
}

export interface PodWithSettings {
  pod: PodRow;
  settings: PodSettingsRow | null;
}

export interface ChatThreadRow {
  id: Uuid;
  household_id: Uuid;
  created_at: string; // timestamptz
}

export type ChatMessageSenderRole = 'user' | 'assistant';

export interface ChatMessageRow {
  id: Uuid;
  thread_id: Uuid;
  sender_role: ChatMessageSenderRole;
  sender_user_id: Uuid | null;
  text: string;
  created_at: string; // timestamptz
}

export type ProposedActionRowStatus = 'proposed' | 'applied' | 'ignored' | 'failed';

export interface ProposedActionRow {
  id: Uuid;
  household_id: Uuid;
  message_id: Uuid;
  type: string;
  payload_json: unknown;
  status: ProposedActionRowStatus;
  applied_at: string | null; // timestamptz
  applied_by: Uuid | null;
  created_at: string; // timestamptz
}

export interface BudgetEventRow {
  id: Uuid;
  household_id: Uuid;
  actor_user_id: Uuid | null;
  type: string;
  payload: unknown;
  created_at: string; // timestamptz
}

