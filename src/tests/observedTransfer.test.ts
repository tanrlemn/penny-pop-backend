import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretMessage } from '../chat/interpretMessage';
import { applyPayloadsToBudgetMap } from '../handlers/applyActionsHandler';

test('observed transfer proposes repair action', () => {
  const pods = [
    { id: 'pod-groceries', name: 'Groceries', budgeted_amount_in_cents: 0, category: 'Necessities' as const },
    { id: 'pod-education', name: 'Education', budgeted_amount_in_cents: 0, category: 'Pressing' as const },
    { id: 'pod-move', name: 'Move to ___', budgeted_amount_in_cents: 5000, category: 'Savings' as const },
  ];

  const result = interpretMessage({
    messageText: 'I moved $25 from Groceries to Education',
    pods,
  });

  assert.equal(result.proposedActionDrafts.length, 1);
  assert.equal(result.proposedActionDrafts[0]?.type, 'budget_repair_restore_donor');
  assert.ok(result.proposedActionDrafts.every((a) => a.type !== 'budget_transfer'));
});

test('repair selection skips pods that cannot cover amount', () => {
  const pods = [
    { id: 'pod-moving', name: 'Moving Fund', budgeted_amount_in_cents: 0, category: 'Pressing' as const },
    { id: 'pod-health', name: 'Health', budgeted_amount_in_cents: 0, category: 'Necessities' as const },
    { id: 'pod-car', name: 'Car Gas', budgeted_amount_in_cents: 15000, category: 'Necessities' as const },
    { id: 'pod-move', name: 'Move to ___', budgeted_amount_in_cents: 50000, category: 'Savings' as const },
  ];

  const result = interpretMessage({
    messageText: 'I moved $220 from Moving Fund to Health',
    pods,
  });

  assert.ok(result.proposedActionDrafts.length > 0);
  const fundingNames = result.proposedActionDrafts.map(
    (draft) => (draft.payload as any).funding_pod_name,
  );
  assert.ok(!fundingNames.includes('Car Gas'));
});

test('repair apply updates donor and funding pods', () => {
  const payloads = [
    {
      kind: 'budget_repair_restore_donor' as const,
      amount_in_cents: 300,
      donor_pod_id: 'pod-groceries',
      donor_pod_name: 'Groceries',
      funding_pod_id: 'pod-move',
      funding_pod_name: 'Move to ___',
    },
  ];

  const budgetByPodId = new Map([
    ['pod-groceries', 1000],
    ['pod-move', 5000],
  ]);

  applyPayloadsToBudgetMap(payloads, budgetByPodId);

  assert.equal(budgetByPodId.get('pod-groceries'), 1300);
  assert.equal(budgetByPodId.get('pod-move'), 4700);
});
