import { AiProposeError, aiProposeBudgetActions } from './client';
import type { ChatIntent, ParsedEntitiesHints, ProposedActionDraft } from '../types/chat';
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

export async function generateActions(opts: {
  messageText: string;
  pods: PodSnapshot[];
  intent?: ChatIntent;
  timeoutMs?: number;
  model?: string;
  fetchImpl?: typeof fetch;
  traceId?: string;
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

  try {
    const result = await aiProposeBudgetActions({
      messageText,
      pods: opts.pods,
      intent: opts.intent,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
      fetchImpl: opts.fetchImpl,
      traceId: opts.traceId,
    });
    return {
      ok: true,
      aiUsed: true,
      assistantText: result.assistantText,
      drafts: result.proposedActionDrafts,
      entities: result.entities,
      warnings,
    };
  } catch (err: any) {
    const msg = typeof err?.message === 'string' ? err.message : 'AI failed';
    if (err instanceof AiProposeError) {
      const warningsForStage =
        err.stage === 'missing_key'
          ? ['AI_DISABLED_NO_KEY']
          : err.stage === 'timeout'
            ? ['AI_TIMEOUT']
            : err.stage === 'tool_missing' || err.stage === 'tool_parse' || err.stage === 'invalid_args'
              ? ['AI_SCHEMA_INVALID']
              : ['AI_ERROR'];
      return {
        ok: false,
        aiUsed: false,
        error: msg,
        warnings: warningsForStage,
        validationError: err.stage === 'invalid_args' ? msg : undefined,
      };
    }

    return {
      ok: false,
      aiUsed: false,
      error: msg,
      warnings: ['AI_ERROR'],
    };
  }
}
