import assert from 'node:assert/strict';
import test from 'node:test';

import { aiProposeResponseSchema } from '../schema';

test('schema rejects unsupported action type', () => {
  const bad = {
    intent: 'request_budget_change',
    assistantText: 'hi',
    proposedActionDrafts: [
      {
        type: 'unsupported_action',
        payload: { kind: 'unsupported_action', delta_in_cents: 100, pod_id: 'x', pod_name: 'X' },
      },
    ],
  };

  const parsed = aiProposeResponseSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test('schema rejects too many actions', () => {
  const goodDraft = {
    type: 'budget_transfer' as const,
    payload: {
      kind: 'budget_transfer' as const,
      amount_in_cents: 100,
      from_pod_id: 'a',
      from_pod_name: 'A',
      to_pod_id: 'b',
      to_pod_name: 'B',
    },
  };

  const bad = {
    intent: 'request_budget_change',
    assistantText: 'hi',
    proposedActionDrafts: [goodDraft, goodDraft, goodDraft, goodDraft],
  };

  const parsed = aiProposeResponseSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test('schema rejects non-positive amount_in_cents', () => {
  const bad = {
    intent: 'request_budget_change',
    assistantText: 'hi',
    proposedActionDrafts: [
      {
        type: 'budget_transfer',
        payload: {
          kind: 'budget_transfer',
          amount_in_cents: 0,
          from_pod_id: 'a',
          from_pod_name: 'A',
          to_pod_id: 'b',
          to_pod_name: 'B',
        },
      },
    ],
  };

  const parsed = aiProposeResponseSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

