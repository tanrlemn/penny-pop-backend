import assert from 'node:assert/strict';
import test from 'node:test';

import { handleChatMessage } from '../chatMessageHandler';

const householdId = '00000000-0000-0000-0000-000000000000';

function makePodsWithSettings() {
  return [
    {
      pod: {
        id: 'pod-a',
        household_id: householdId,
        sequence_account_id: 'seq',
        name: 'A',
        is_active: true,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        balance_amount_in_cents: null,
        balance_error: null,
        balance_updated_at: null,
      },
      settings: { pod_id: 'pod-a', category: null, notes: null, updated_at: new Date().toISOString(), budgeted_amount_in_cents: 0 },
    },
    {
      pod: {
        id: 'pod-b',
        household_id: householdId,
        sequence_account_id: 'seq',
        name: 'B',
        is_active: true,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        balance_amount_in_cents: null,
        balance_error: null,
        balance_updated_at: null,
      },
      settings: { pod_id: 'pod-b', category: null, notes: null, updated_at: new Date().toISOString(), budgeted_amount_in_cents: 0 },
    },
  ];
}

test('handleChatMessage falls back when AI is disabled', async () => {
  process.env.AI_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key';

  let insertDraftsCount = -1;

  const result = await handleChatMessage({
    method: 'POST',
    headers: { authorization: 'Bearer test' },
    body: { householdId, messageText: 'rent due soon' },
  }, {
    verifyUser: async () => ({ userId: 'user-1', email: null }),
    assertUserInHousehold: async () => {},
    checkRateLimit: () => ({ allowed: true, remaining: 1, resetAtMs: Date.now() + 1000 }),
    listPodsWithSettingsForHousehold: async () => makePodsWithSettings() as any,
    interpretMessage: () => ({
      assistantText: 'deterministic',
      proposedActionDrafts: [],
      entities: { candidates: ['A', 'B'] },
    }),
    generateActions: async () => {
      throw new Error('generateActions should not be called when AI is disabled');
    },
    getOrCreateChatThreadForHousehold: async () => ({
      id: 'thread-1',
      household_id: householdId,
      created_at: new Date().toISOString(),
    }),
    insertChatMessage: async (args: any) => ({
      id: args.senderRole === 'assistant' ? 'm2' : 'm1',
      thread_id: args.threadId,
      sender_role: args.senderRole,
      sender_user_id: args.senderUserId ?? null,
      text: args.text,
      created_at: new Date().toISOString(),
    }),
    insertProposedActions: async (args: any) => {
      insertDraftsCount = args.actionDrafts.length;
      return [];
    },
    toApiProposedAction: (row: any) => row,
    hasRecentObservedTransfer: async () => false,
    insertBudgetEvents: async () => [],
    makeTraceId: () => 'trace-1',
  });

  assert.equal(result.status, 200);
  assert.equal((result.json as any).assistantText, 'deterministic');
  assert.equal((result.json as any).aiUsed, false);
  assert.deepEqual((result.json as any).warnings, []);
  assert.equal(insertDraftsCount, 0);
});

test('handleChatMessage falls back when AI times out', async () => {
  process.env.AI_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-key';

  const result = await handleChatMessage({
    method: 'POST',
    headers: { authorization: 'Bearer test' },
    body: { householdId, messageText: 'rent due soon' },
  }, {
    verifyUser: async () => ({ userId: 'user-1', email: null }),
    assertUserInHousehold: async () => {},
    checkRateLimit: () => ({ allowed: true, remaining: 1, resetAtMs: Date.now() + 1000 }),
    listPodsWithSettingsForHousehold: async () => makePodsWithSettings() as any,
    interpretMessage: () => ({
      assistantText: 'deterministic_after_timeout',
      proposedActionDrafts: [],
      entities: { candidates: ['A', 'B'] },
    }),
    generateActions: async () => {
      throw new Error('OpenAI request timed out');
    },
    getOrCreateChatThreadForHousehold: async () => ({
      id: 'thread-1',
      household_id: householdId,
      created_at: new Date().toISOString(),
    }),
    insertChatMessage: async (args: any) => ({
      id: args.senderRole === 'assistant' ? 'm2' : 'm1',
      thread_id: args.threadId,
      sender_role: args.senderRole,
      sender_user_id: args.senderUserId ?? null,
      text: args.text,
      created_at: new Date().toISOString(),
    }),
    insertProposedActions: async () => [],
    toApiProposedAction: (row: any) => row,
    hasRecentObservedTransfer: async () => false,
    insertBudgetEvents: async () => [],
    makeTraceId: () => 'trace-2',
  });

  assert.equal(result.status, 200);
  assert.equal((result.json as any).assistantText, 'deterministic_after_timeout');
  assert.equal((result.json as any).aiUsed, false);
  assert.ok(((result.json as any).warnings ?? []).includes('AI_TIMEOUT'));
  assert.ok(((result.json as any).warnings ?? []).includes('AI_FALLBACK_TO_DETERMINISTIC'));
});

