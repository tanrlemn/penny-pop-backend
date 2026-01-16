import assert from 'node:assert/strict';
import test from 'node:test';

import { generateActions } from '../generateActions';

test('generateActions returns ok:false on missing tool call', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ output_text: 'not a tool call' }), { status: 200 });

  process.env.OPENAI_API_KEY = 'test-key';

  const result = await generateActions({
    messageText: 'move $1 from A to B',
    pods: [
      { id: 'a', name: 'A', budgeted_amount_in_cents: 0, category: null },
      { id: 'b', name: 'B', budgeted_amount_in_cents: 0, category: null },
    ],
    fetchImpl: fetchImpl as any,
    timeoutMs: 100,
    model: 'test-model',
  });

  assert.equal(result.ok, false);
});

test('generateActions returns ok:false on schema missing required keys', async () => {
  const aiArgs = {
    intent: 'request_budget_change',
    // assistantText missing
    proposedActionDrafts: [],
  };

  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: 'function_call',
            name: 'propose_budget_actions',
            arguments: JSON.stringify(aiArgs),
          },
        ],
      }),
      { status: 200 },
    );

  process.env.OPENAI_API_KEY = 'test-key';

  const result = await generateActions({
    messageText: 'hello',
    pods: [{ id: 'a', name: 'A', budgeted_amount_in_cents: 0, category: null }],
    fetchImpl: fetchImpl as any,
    timeoutMs: 100,
    model: 'test-model',
  });

  assert.equal(result.ok, false);
});

test('generateActions returns ok:false when AI references unknown pod id', async () => {
  const aiArgs = {
    intent: 'request_budget_change',
    assistantText: 'ok',
    proposedActionDrafts: [
      {
        type: 'budget_transfer',
        payload: {
          kind: 'budget_transfer',
          amount_in_cents: 100,
          from_pod_id: 'unknown',
          from_pod_name: 'X',
          to_pod_id: 'b',
          to_pod_name: 'B',
        },
      },
    ],
  };

  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: 'function_call',
            name: 'propose_budget_actions',
            arguments: JSON.stringify(aiArgs),
          },
        ],
      }),
      { status: 200 },
    );

  process.env.OPENAI_API_KEY = 'test-key';

  const result = await generateActions({
    messageText: 'move $1 from A to B',
    pods: [
      { id: 'a', name: 'A', budgeted_amount_in_cents: 0, category: null },
      { id: 'b', name: 'B', budgeted_amount_in_cents: 0, category: null },
    ],
    fetchImpl: fetchImpl as any,
    timeoutMs: 100,
    model: 'test-model',
  });

  assert.equal(result.ok, false);
});

test('generateActions normalizes missing payload.kind and pod names', async () => {
  const aiArgs = {
    intent: 'request_budget_change',
    assistantText: 'ok',
    proposedActionDrafts: [
      {
        type: 'budget_transfer',
        payload: {
          amount_in_cents: 22000,
          from_pod_id: 'moving',
          to_pod_id: 'health',
        },
      },
    ],
  };

  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: 'function_call',
            name: 'propose_budget_actions',
            arguments: JSON.stringify(aiArgs),
          },
        ],
      }),
      { status: 200 },
    );

  process.env.OPENAI_API_KEY = 'test-key';

  const result = await generateActions({
    messageText: 'Move $220 from Moving Fund to Health',
    pods: [
      { id: 'moving', name: 'Moving Fund', budgeted_amount_in_cents: 0, category: null },
      { id: 'health', name: 'Health', budgeted_amount_in_cents: 0, category: null },
    ],
    fetchImpl: fetchImpl as any,
    timeoutMs: 100,
    model: 'test-model',
  });

  assert.equal(result.ok, true);
  assert.equal(result.aiUsed, true);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].type, 'budget_transfer');
  assert.equal(result.drafts[0].payload.kind, 'budget_transfer');
  assert.equal(result.drafts[0].payload.from_pod_name, 'Moving Fund');
  assert.equal(result.drafts[0].payload.to_pod_name, 'Health');
});

