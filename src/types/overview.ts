export type AttentionQueueItemType =
  | 'over_budget'
  | 'unassigned'
  | 'balances_stale'
  | 'balance_error';

export type AttentionQueueSeverity = 'high' | 'medium' | 'low';

export interface AttentionQueueItem {
  id: string;
  type: AttentionQueueItemType;
  severity: AttentionQueueSeverity;
  title: string;
  subtitle: string;
  cta: { label: string; action: string };
  data: Record<string, unknown>;
}

export interface OverviewBudgetSummary {
  totalIncomeCents: number;
  totalBudgetedExpensesCents: number;
  leftToBudgetCents: number;
  leftToBudgetPct: number | null;
}

export interface OverviewBalancesSummary {
  latestBalanceUpdatedAt: string | null;
  hasBalanceErrors: boolean;
  balanceErrorCount: number;
}

export interface OverviewResponseBody {
  budget: OverviewBudgetSummary;
  balances: OverviewBalancesSummary;
  attentionQueue: AttentionQueueItem[];
}
