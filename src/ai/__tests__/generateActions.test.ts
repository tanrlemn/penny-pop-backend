import assert from 'node:assert/strict';
import test from 'node:test';

import { generateActions } from '../generateActions';

test('generateActions returns ok:false on non-JSON output', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ output_text: 'not json' }), { status: 200 });

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
  const aiJson = JSON.stringify({
    // assistantText missing
    proposedActionDrafts: [],
  });

  const fetchImpl = async () =>
    new Response(JSON.stringify({ output_text: aiJson }), { status: 200 });

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
  const aiJson = JSON.stringify({
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
  });

  const fetchImpl = async () =>
    new Response(JSON.stringify({ output_text: aiJson }), { status: 200 });

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

