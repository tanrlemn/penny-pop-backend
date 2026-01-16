import { callOpenAIResponsesApi } from './client';
import { aiActionsOutputSchema } from './schema';
import type { ParsedEntitiesHints, ProposedActionDraft, ProposedActionPayload } from '../types/chat';
import type { PodSettingsCategory, Uuid } from '../types/supabase';

type PodSnapshot = {
  id: Uuid;
  name: string;
  category?: PodSettingsCategory | null;
  budgeted_amount_in_cents?: number | null;
  balance_amount_in_cents?: number | null;
  balance_error?: string | null;
  balance_updated_at?: string | null;
};

export type GenerateActionsResult =
  | {
      ok: true;
      aiUsed: true;
      assistantText: string;
      drafts: ProposedActionDraft[];
      entities: ParsedEntitiesHints;
      warnings: string[];
    }
  | {
      ok: false;
      aiUsed: false;
      error: string;
      warnings: string[];
      validationError?: string;
    };

function buildPrompt(opts: { messageText: string; pods: PodSnapshot[] }): string {
  const podsList = opts.pods
    .map((p) => {
      const budget = p.budgeted_amount_in_cents ?? null;
      const bal = p.balance_amount_in_cents ?? null;
      const balUpdated = p.balance_updated_at ?? null;
      const balErr = p.balance_error ?? null;
      const cat = p.category ?? null;
      return `- id=${p.id} name=${JSON.stringify(p.name)} category=${JSON.stringify(
        cat,
      )} budgeted_amount_in_cents=${budget} balance_amount_in_cents=${bal} balance_updated_at=${JSON.stringify(
        balUpdated,
      )} balance_error=${JSON.stringify(balErr)}`;
    })
    .join('\n');

  // Keep instructions short + strict: JSON only, no extra keys.
  return [
    'You are an assistant that proposes budget actions.',
    'You MUST return ONLY valid JSON (no markdown, no commentary, no extra keys).',
    'Allowed proposedActionDrafts[].type values: "budget_transfer" or "budget_repair_restore_donor".',
    'Each payload MUST match the existing app schema and use ONLY pod ids from the provided pod list.',
    'Rules:',
    '- proposedActionDrafts length must be <= 3.',
    '- amount_in_cents must be an integer > 0.',
    '- Do not invent pod ids; choose from the list.',
    '',
    'Return JSON with this exact shape:',
    '{"assistantText": "...", "proposedActionDrafts": [{"type":"budget_transfer","payload":{...},"confidence":0.7,"reason":"..."}], "entities": {"fromCandidate": "...", "toCandidate": "...", "fundingCandidate": "..."}}',
    '',
    `User message: ${JSON.stringify(opts.messageText)}`,
    '',
    'Pods:',
    podsList,
  ].join('\n');
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Empty AI output' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Some models may accidentally wrap JSON in whitespace/newlines; still handled above.
    return { ok: false, error: 'AI output was not valid JSON' };
  }
}

function normalizeDrafts(opts: {
  rawDrafts: Array<{ type: ProposedActionDraft['type']; payload: any }>;
  podsById: Map<Uuid, { id: Uuid; name: string }>;
}): { drafts: ProposedActionDraft[]; warnings: string[] } {
  const warnings: string[] = [];
  const drafts: ProposedActionDraft[] = [];

  for (const d of opts.rawDrafts) {
    if (d.type === 'budget_transfer') {
      const fromId = d.payload?.from_pod_id as Uuid | undefined;
      const toId = d.payload?.to_pod_id as Uuid | undefined;
      const amt = d.payload?.amount_in_cents as number | undefined;
      if (!fromId || !toId) throw new Error('AI draft missing pod ids');
      if (fromId === toId) throw new Error('AI draft used same from/to pod');
      const from = opts.podsById.get(fromId);
      const to = opts.podsById.get(toId);
      if (!from || !to) throw new Error('AI draft referenced unknown pod id');
      const payload: ProposedActionPayload = {
        kind: 'budget_transfer',
        amount_in_cents: amt ?? 0,
        from_pod_id: from.id,
        from_pod_name: from.name,
        to_pod_id: to.id,
        to_pod_name: to.name,
      };
      drafts.push({ type: 'budget_transfer', payload });
      continue;
    }

    if (d.type === 'budget_repair_restore_donor') {
      const donorId = d.payload?.donor_pod_id as Uuid | undefined;
      const fundingId = d.payload?.funding_pod_id as Uuid | undefined;
      const amt = d.payload?.amount_in_cents as number | undefined;
      if (!donorId || !fundingId) throw new Error('AI draft missing pod ids');
      if (donorId === fundingId) throw new Error('AI draft used same donor/funding pod');
      const donor = opts.podsById.get(donorId);
      const funding = opts.podsById.get(fundingId);
      if (!donor || !funding) throw new Error('AI draft referenced unknown pod id');
      const optionLabel =
        typeof d.payload?.option_label === 'string' ? (d.payload.option_label as string) : undefined;
      const payload: ProposedActionPayload = {
        kind: 'budget_repair_restore_donor',
        amount_in_cents: amt ?? 0,
        donor_pod_id: donor.id,
        donor_pod_name: donor.name,
        funding_pod_id: funding.id,
        funding_pod_name: funding.name,
        ...(optionLabel ? { option_label: optionLabel } : {}),
      };
      drafts.push({ type: 'budget_repair_restore_donor', payload });
      continue;
    }

    warnings.push('AI_UNSUPPORTED_ACTION_TYPE');
    throw new Error('Unsupported action type');
  }

  return { drafts, warnings };
}

export async function generateActions(opts: {
  messageText: string;
  pods: PodSnapshot[];
  timeoutMs?: number;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<GenerateActionsResult> {
  const warnings: string[] = [];
  const messageText = (opts.messageText ?? '').trim();
  const maxLen = 500;
  if (messageText.length > maxLen) {
    return {
      ok: false,
      aiUsed: false,
      error: 'Message too long for AI',
      warnings: ['AI_SKIPPED_MESSAGE_TOO_LONG'],
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      aiUsed: false,
      error: 'Missing OPENAI_API_KEY',
      warnings: ['AI_DISABLED_NO_KEY'],
    };
  }

  const podsById = new Map(opts.pods.map((p) => [p.id, { id: p.id, name: p.name }] as const));

  try {
    const prompt = buildPrompt({ messageText, pods: opts.pods });
    const { outputText } = await callOpenAIResponsesApi({
      apiKey,
      model: opts.model ?? 'gpt-4.1-mini',
      timeoutMs: opts.timeoutMs ?? 10_000,
      input: prompt,
      fetchImpl: opts.fetchImpl,
    });

    const parsed = safeJsonParse(outputText);
    if (!parsed.ok) {
      return {
        ok: false,
        aiUsed: false,
        error: parsed.error,
        warnings: ['AI_NON_JSON'],
      };
    }

    const validated = aiActionsOutputSchema.safeParse(parsed.value);
    if (!validated.success) {
      return {
        ok: false,
        aiUsed: false,
        error: 'AI output did not match schema',
        warnings: ['AI_SCHEMA_INVALID'],
        validationError: JSON.stringify(validated.error.flatten()),
      };
    }

    const normalized = normalizeDrafts({
      rawDrafts: validated.data.proposedActionDrafts as any,
      podsById,
    });
    warnings.push(...normalized.warnings);

    // Entities must include candidates for Flutter compatibility.
    const candidates = opts.pods.map((p) => p.name).slice(0, 8);
    const entities: ParsedEntitiesHints = {
      candidates,
      ...(validated.data.entities ?? {}),
    };

    return {
      ok: true,
      aiUsed: true,
      assistantText: validated.data.assistantText,
      drafts: normalized.drafts,
      entities,
      warnings,
    };
  } catch (err: any) {
    const msg = typeof err?.message === 'string' ? err.message : 'AI failed';
    const code = msg.toLowerCase().includes('timed out') ? 'AI_TIMEOUT' : 'AI_ERROR';
    return {
      ok: false,
      aiUsed: false,
      error: msg,
      warnings: [code],
    };
  }
}

