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

