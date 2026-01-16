import { aiProposeResponseSchema, aiProposeResponseToolSchema } from './schema';
import type {
  ChatIntent,
  ParsedEntitiesHints,
  ProposedActionDraft,
  ProposedActionPayload,
} from '../types/chat';
import type { PodSettingsCategory, Uuid } from '../types/supabase';

type FetchLike = typeof fetch;

type PodSnapshot = {
  id: Uuid;
  name: string;
  category?: PodSettingsCategory | null;
  budgeted_amount_in_cents?: number | null;
  balance_amount_in_cents?: number | null;
  balance_error?: string | null;
  balance_updated_at?: string | null;
};

export type AiProposeFailureStage =
  | 'missing_key'
  | 'timeout'
  | 'api_error'
  | 'tool_missing'
  | 'tool_parse'
  | 'invalid_args';

export class AiProposeError extends Error {
  stage: AiProposeFailureStage;

  constructor(stage: AiProposeFailureStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

const TOOL_NAME = 'propose_budget_actions';
const AI_DEBUG_ENABLED = process.env.AI_DEBUG === 'true';

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'AI request failed';
}

function stringifyPreview(value: unknown, maxLength = 2000): string {
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
  } catch {
    return '[unstringifiable]';
  }
}

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!AI_DEBUG_ENABLED) return;
  if (details) {
    console.log(message, details);
    return;
  }
  console.log(message);
}

function buildPrompt(opts: { messageText: string; pods: PodSnapshot[]; intent: ChatIntent }): string {
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

  return [
    'You are an assistant that proposes budget actions.',
    'Always call the propose_budget_actions tool.',
    'Only use pod ids from the provided pod list.',
    'Each proposed action draft must include type and payload.kind.',
    'Payload.kind must match the draft type.',
    'Required payload fields:',
    '- budget_transfer: amount_in_cents, from_pod_id, from_pod_name, to_pod_id, to_pod_name',
    '- budget_adjust: delta_in_cents, pod_id, pod_name',
    '- budget_repair_restore_donor: amount_in_cents, donor_pod_id, donor_pod_name, funding_pod_id, funding_pod_name',
    'Keep proposedActionDrafts length <= 3.',
    'Do not include any keys outside the tool schema.',
    '',
    `Intent hint: ${opts.intent}`,
    `User message: ${JSON.stringify(opts.messageText)}`,
    '',
    'Pods:',
    podsList,
  ].join('\n');
}

async function callOpenAIResponsesApi(opts: {
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = 'https://api.openai.com/v1/responses';

  const attemptOnce = async (): Promise<{
    ok: boolean;
    status?: number;
    raw?: unknown;
    retryable: boolean;
    error?: string;
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });

      const status = res.status;
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;

      if (!res.ok) {
        const retryable = isRetryableStatus(status);
        const msg =
          (parsed as any)?.error?.message ??
          (parsed as any)?.message ??
          `OpenAI request failed (status ${status})`;
        return { ok: false, status, retryable, error: msg };
      }

      return { ok: true, status, raw: parsed, retryable: false };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      return {
        ok: false,
        retryable: !isAbort,
        error: isAbort ? 'OpenAI request timed out' : 'OpenAI request failed',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const first = await attemptOnce();
  if (first.ok) {
    return first.raw ?? null;
  }
  if (first.retryable) {
    await sleep(200);
    const second = await attemptOnce();
    if (second.ok) {
      return second.raw ?? null;
    }
    throw new Error(second.error ?? first.error ?? 'OpenAI request failed');
  }

  throw new Error(first.error ?? 'OpenAI request failed');
}

function extractToolArgs(raw: any, toolName: string): unknown | null {
  const tryExtractFromCall = (call: any): unknown | null => {
    const name = call?.name ?? call?.function?.name;
    if (name !== toolName) return null;
    return call?.arguments ?? call?.arguments_json ?? call?.function?.arguments ?? null;
  };

  const output = raw?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const direct = tryExtractFromCall(item);
      if (direct !== null) return direct;

      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const nested = tryExtractFromCall(part);
          if (nested !== null) return nested;
        }
      }

      const toolCalls = item?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const nested = tryExtractFromCall(call);
          if (nested !== null) return nested;
        }
      }
    }
  }

  const chatToolCalls = raw?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(chatToolCalls)) {
    for (const call of chatToolCalls) {
      const nested = tryExtractFromCall(call);
      if (nested !== null) return nested;
    }
  }

  return null;
}

function parseToolArgs(rawArgs: unknown): unknown {
  if (rawArgs == null) return null;
  if (typeof rawArgs === 'string') {
    return JSON.parse(rawArgs);
  }
  if (typeof rawArgs === 'object') {
    return rawArgs;
  }
  throw new Error('Tool arguments were not JSON');
}

function normalizeAiArgs(opts: {
  rawArgs: unknown;
  podsById: Map<Uuid, { id: Uuid; name: string }>;
}): unknown {
  if (!opts.rawArgs || typeof opts.rawArgs !== 'object') return opts.rawArgs;
  const data = opts.rawArgs as Record<string, any>;
  const drafts = Array.isArray(data.proposedActionDrafts) ? data.proposedActionDrafts : null;
  const normalizedDrafts = drafts
    ? drafts.map((draft) => {
        if (!draft || typeof draft !== 'object') return draft;
        const draftRecord = draft as Record<string, any>;
        const payload = draftRecord.payload && typeof draftRecord.payload === 'object'
          ? { ...(draftRecord.payload as Record<string, any>) }
          : {};
        const kind = draftRecord.type ?? draftRecord.kind ?? payload.kind;
        if (typeof kind === 'string') {
          payload.kind = kind;
        }

        if (kind === 'budget_transfer') {
          const fromId = payload.from_pod_id as Uuid | undefined;
          const toId = payload.to_pod_id as Uuid | undefined;
          if (!payload.from_pod_name && fromId) {
            const from = opts.podsById.get(fromId);
            if (from) payload.from_pod_name = from.name;
          }
          if (!payload.to_pod_name && toId) {
            const to = opts.podsById.get(toId);
            if (to) payload.to_pod_name = to.name;
          }
        }

        if (kind === 'budget_adjust') {
          const podId = payload.pod_id as Uuid | undefined;
          if (!payload.pod_name && podId) {
            const pod = opts.podsById.get(podId);
            if (pod) payload.pod_name = pod.name;
          }
        }

        if (kind === 'budget_repair_restore_donor') {
          const donorId = payload.donor_pod_id as Uuid | undefined;
          const fundingId = payload.funding_pod_id as Uuid | undefined;
          if (!payload.donor_pod_name && donorId) {
            const donor = opts.podsById.get(donorId);
            if (donor) payload.donor_pod_name = donor.name;
          }
          if (!payload.funding_pod_name && fundingId) {
            const funding = opts.podsById.get(fundingId);
            if (funding) payload.funding_pod_name = funding.name;
          }
        }

        return {
          type: kind,
          payload,
        };
      })
    : data.proposedActionDrafts;

  return {
    intent: data.intent,
    assistantText: data.assistantText,
    proposedActionDrafts: normalizedDrafts,
    entities: data.entities,
  };
}

function normalizeDrafts(opts: {
  rawDrafts: ProposedActionDraft[];
  podsById: Map<Uuid, { id: Uuid; name: string }>;
}): ProposedActionDraft[] {
  const drafts: ProposedActionDraft[] = [];

  for (const d of opts.rawDrafts) {
    if (d.type === 'budget_transfer') {
      const fromId = (d.payload as any)?.from_pod_id as Uuid | undefined;
      const toId = (d.payload as any)?.to_pod_id as Uuid | undefined;
      const amt = (d.payload as any)?.amount_in_cents as number | undefined;
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

    if (d.type === 'budget_adjust') {
      const podId = (d.payload as any)?.pod_id as Uuid | undefined;
      const delta = (d.payload as any)?.delta_in_cents as number | undefined;
      if (!podId) throw new Error('AI draft missing pod id');
      const pod = opts.podsById.get(podId);
      if (!pod) throw new Error('AI draft referenced unknown pod id');
      const payload: ProposedActionPayload = {
        kind: 'budget_adjust',
        delta_in_cents: delta ?? 0,
        pod_id: pod.id,
        pod_name: pod.name,
      };
      drafts.push({ type: 'budget_adjust', payload });
      continue;
    }

    if (d.type === 'budget_repair_restore_donor') {
      const donorId = (d.payload as any)?.donor_pod_id as Uuid | undefined;
      const fundingId = (d.payload as any)?.funding_pod_id as Uuid | undefined;
      const amt = (d.payload as any)?.amount_in_cents as number | undefined;
      if (!donorId || !fundingId) throw new Error('AI draft missing pod ids');
      if (donorId === fundingId) throw new Error('AI draft used same donor/funding pod');
      const donor = opts.podsById.get(donorId);
      const funding = opts.podsById.get(fundingId);
      if (!donor || !funding) throw new Error('AI draft referenced unknown pod id');
      const optionLabel =
        typeof (d.payload as any)?.option_label === 'string'
          ? ((d.payload as any).option_label as string)
          : undefined;
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

    throw new Error('Unsupported action type');
  }

  return drafts;
}

export async function aiProposeBudgetActions(opts: {
  messageText: string;
  pods: PodSnapshot[];
  intent?: ChatIntent;
  timeoutMs?: number;
  model?: string;
  fetchImpl?: FetchLike;
  traceId?: string;
}): Promise<{
  intent: ChatIntent;
  assistantText: string;
  proposedActionDrafts: ProposedActionDraft[];
  entities: ParsedEntitiesHints;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AiProposeError('missing_key', 'Missing OPENAI_API_KEY');
  }

  const messageText = (opts.messageText ?? '').trim();
  const intent: ChatIntent = opts.intent ?? 'request_budget_change';
  const prompt = buildPrompt({ messageText, pods: opts.pods, intent });
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const model = opts.model ?? 'gpt-5.2';
  const traceId = opts.traceId ?? 'unknown';

  try {
    console.log('ai_propose request', {
      traceId,
      model,
      timeoutMs,
      messageChars: messageText.length,
      podCount: opts.pods.length,
    });

    const raw = await callOpenAIResponsesApi({
      apiKey,
      timeoutMs,
      fetchImpl: opts.fetchImpl,
      body: {
        model,
        input: [
          {
            role: 'system',
            content: [
              'You are a budgeting assistant.',
              'Intent rules:',
              '- observed_transfer: DO NOT propose budget_transfer. Propose repair options instead.',
              '- request_budget_change: budget_transfer is allowed.',
              '- question_advice: no actions; return assistantText only.',
            ].join('\n'),
          },
          { role: 'user', content: prompt },
        ],
        tools: [
          {
            type: 'function',
            name: TOOL_NAME,
            description: 'Propose budget actions based on a user message.',
            parameters: aiProposeResponseToolSchema,
          },
        ],
        tool_choice: { type: 'function', name: TOOL_NAME },
      },
    });

    const rawArgs = extractToolArgs(raw, TOOL_NAME);
    debugLog('ai_propose tool_call', {
      traceId,
      toolName: TOOL_NAME,
      toolCallFound: rawArgs !== null,
      rawArgsType: typeof rawArgs,
      rawArgsPreview: stringifyPreview(rawArgs),
    });
    if (!rawArgs) {
      throw new AiProposeError('tool_missing', 'AI response missing tool call');
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = parseToolArgs(rawArgs);
    } catch (err) {
      throw new AiProposeError('tool_parse', 'AI tool arguments were not JSON');
    }

    const podsById = new Map(opts.pods.map((p) => [p.id, { id: p.id, name: p.name }] as const));
    const normalizedArgs = normalizeAiArgs({ rawArgs: parsedArgs, podsById });
    debugLog('ai_propose validation_input', {
      traceId,
      argsType: typeof normalizedArgs,
      argsPreview: stringifyPreview(normalizedArgs),
    });
    const validated = aiProposeResponseSchema.safeParse(normalizedArgs);
    if (!validated.success) {
      const error = validated.error.flatten();
      debugLog('ai_propose zod_issues', {
        traceId,
        issues: validated.error.issues,
      });
      console.warn('ai_propose invalid_args', {
        traceId,
        error,
        argsPreview: stringifyPreview(normalizedArgs),
      });
      throw new AiProposeError('invalid_args', JSON.stringify(error));
    }

    if (
      validated.data.intent === 'observed_transfer' &&
      validated.data.proposedActionDrafts.some((draft) => draft.type === 'budget_transfer')
    ) {
      throw new AiProposeError(
        'invalid_args',
        'observed_transfer intent cannot include budget_transfer actions',
      );
    }

    if (
      validated.data.intent === 'question_advice' &&
      validated.data.proposedActionDrafts.length > 0
    ) {
      throw new AiProposeError(
        'invalid_args',
        'question_advice intent cannot include proposed actions',
      );
    }

    let normalizedDrafts: ProposedActionDraft[];
    try {
      normalizedDrafts = normalizeDrafts({
        rawDrafts: validated.data.proposedActionDrafts,
        podsById,
      });
    } catch (err) {
      throw new AiProposeError('invalid_args', asErrorMessage(err));
    }

    const baseCandidates = opts.pods.map((p) => p.name).slice(0, 8);
    const aiCandidates = validated.data.entities?.candidates ?? [];
    const mergedCandidates = Array.from(new Set([...baseCandidates, ...aiCandidates])).slice(0, 8);
    const entities: ParsedEntitiesHints = {
      candidates: mergedCandidates,
      ...(validated.data.entities ?? {}),
    };

    console.log('ai_propose validated', {
      traceId,
      intent: validated.data.intent,
      assistantTextLength: validated.data.assistantText.length,
      draftCount: normalizedDrafts.length,
      draftTypes: normalizedDrafts.map((draft) => draft.type),
    });

    return {
      intent: validated.data.intent,
      assistantText: validated.data.assistantText,
      proposedActionDrafts: normalizedDrafts,
      entities,
    };
  } catch (err: any) {
    if (err instanceof AiProposeError) throw err;
    const msg = typeof err?.message === 'string' ? err.message : 'AI request failed';
    if (msg.toLowerCase().includes('timed out')) {
      throw new AiProposeError('timeout', msg);
    }
    throw new AiProposeError('api_error', msg);
  }
}

