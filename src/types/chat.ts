import type { PodSettingsCategory, Uuid } from './supabase';

export type ChatSenderRole = 'user' | 'assistant';

export type ProposedActionStatus = 'proposed' | 'applied' | 'ignored' | 'failed';

export type ProposedActionType =
  | 'budget_transfer'
  | 'budget_adjust'
  | 'budget_repair_restore_donor';

export type ProposedActionPayload =
  | {
      kind: 'budget_transfer';
      amount_in_cents: number;
      from_pod_id: Uuid;
      from_pod_name: string;
      to_pod_id: Uuid;
      to_pod_name: string;
    }
  | {
      kind: 'budget_adjust';
      delta_in_cents: number;
      pod_id: Uuid;
      pod_name: string;
    }
  | {
      kind: 'budget_repair_restore_donor';
      amount_in_cents: number;
      donor_pod_id: Uuid;
      donor_pod_name: string;
      funding_pod_id: Uuid;
      funding_pod_name: string;
      option_label?: string;
    };

export interface ProposedAction {
  id: Uuid;
  type: ProposedActionType;
  payload: ProposedActionPayload;
  status: ProposedActionStatus;
}

export interface ProposedActionDraft {
  type: ProposedActionType;
  payload: ProposedActionPayload;
}

export interface ParsedEntitiesHints {
  fromCandidate?: string | null;
  toCandidate?: string | null;
  fundingCandidate?: string | null;
  candidates: string[];
}

export interface ChatMessageRequestBody {
  householdId: Uuid;
  messageText: string;
}

export interface ChatMessageResponseBody {
  apiVersion?: string;
  traceId?: string;
  assistantText: string;
  proposedActions: ProposedAction[];
  entities: ParsedEntitiesHints;
}

export interface ApplyActionsRequestBody {
  householdId: Uuid;
  actionIds: Uuid[];
}

export interface ApplyActionsResponseBody {
  apiVersion?: string;
  traceId?: string;
  appliedActionIds: Uuid[];
  changes: Array<{
    pod_id: Uuid;
    pod_name: string;
    delta_in_cents: number;
    before_in_cents: number;
    after_in_cents: number;
  }>;
  pods: Array<{
    id: Uuid;
    name: string;
    balance_amount_in_cents: number | null;
    budgeted_amount_in_cents: number | null;
    category: PodSettingsCategory | null;
  }>;
  left_to_budget?: number;
}

