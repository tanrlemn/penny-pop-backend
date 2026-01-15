import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretMessage } from '../chat/interpretMessage';
import { applyPayloadsToBudgetMap } from '../handlers/applyActionsHandler';

test('observed transfer proposes repair action', () => {
  const pods = [
    { id: 'pod-groceries', name: 'Groceries' },
    { id: 'pod-education', name: 'Education' },
    { id: 'pod-move', name: 'Move to ___' },
  ];

  const result = interpretMessage({
    messageText: 'I moved $25 from Groceries to Education',
    pods,
  });

  assert.equal(result.proposedActionDrafts.length, 1);
  assert.equal(result.proposedActionDrafts[0]?.type, 'budget_repair_restore_donor');
  assert.ok(result.proposedActionDrafts.every((a) => a.type !== 'budget_transfer'));
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
