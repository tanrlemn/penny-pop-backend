import { verifyUser } from '../auth/verifyUser';
import { AiProposeError, aiProposeBudgetActions } from '../ai/client';
import { interpretMessage } from '../chat/interpretMessage';
import { MAX_MESSAGE_CHARS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../config';
import { hasRecentObservedTransfer, insertBudgetEvents } from '../repos/budgetEventsRepo';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { insertChatMessage } from '../repos/chatMessagesRepo';
import { getOrCreateChatThreadForHousehold } from '../repos/chatThreadsRepo';
import { insertProposedActions, toApiProposedAction } from '../repos/proposedActionsRepo';
import { listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import type { ChatIntent, ChatMessageRequestBody, ChatMessageResponseBody } from '../types/chat';
import type { Uuid } from '../types/supabase';
import { errorResponse } from '../http/errors';
import { checkRateLimit } from '../http/rateLimit';
import { makeTraceId } from '../http/trace';
import { API_VERSION } from '../http/version';
import { chatMessageRequestSchema } from '../http/validation';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

type ChatMessageDeps = {
  verifyUser: typeof verifyUser;
  aiProposeBudgetActions: typeof aiProposeBudgetActions;
  interpretMessage: typeof interpretMessage;
  assertUserInHousehold: typeof assertUserInHousehold;
  listPodsWithSettingsForHousehold: typeof listPodsWithSettingsForHousehold;
  getOrCreateChatThreadForHousehold: typeof getOrCreateChatThreadForHousehold;
  insertChatMessage: typeof insertChatMessage;
  insertProposedActions: typeof insertProposedActions;
  toApiProposedAction: typeof toApiProposedAction;
  hasRecentObservedTransfer: typeof hasRecentObservedTransfer;
  insertBudgetEvents: typeof insertBudgetEvents;
  checkRateLimit: typeof checkRateLimit;
  makeTraceId: typeof makeTraceId;
};

const defaultDeps: ChatMessageDeps = {
  verifyUser,
  aiProposeBudgetActions,
  interpretMessage,
  assertUserInHousehold,
  listPodsWithSettingsForHousehold,
  getOrCreateChatThreadForHousehold,
  insertChatMessage,
  insertProposedActions,
  toApiProposedAction,
  hasRecentObservedTransfer,
  insertBudgetEvents,
  checkRateLimit,
  makeTraceId,
};

function classifyIntent(messageText: string): ChatIntent {
  const text = (messageText ?? '').toLowerCase();
  const normalized = text.replace(/[^a-z0-9?]+/g, ' ').replace(/\s+/g, ' ').trim();

  const observedPatterns = [
    /\bi\s+moved\b/,
    /\bi\s+transferred\b/,
    /\bi\s+already\s+moved\b/,
    /\bi\s+just\s+moved\b/,
    /\bi\s+sent\b/,
    /\bi\s+paid\b/,
    /\bi\s+took\s+from\b/,
  ];
  if (observedPatterns.some((re) => re.test(normalized))) {
    return 'observed_transfer';
  }

  const questionPatterns = ['got any ideas', 'how should', 'what should', 'can we'];
  if (questionPatterns.some((phrase) => normalized.includes(phrase)) || normalized.endsWith('?')) {
    return 'question_advice';
  }

  return 'request_budget_change';
}

export async function handleChatMessage(opts: {
  method: string;
  headers: Record<string, any>;
  body: any;
}, depsOverride?: Partial<ChatMessageDeps>): Promise<HandlerResult> {
  const deps: ChatMessageDeps = { ...defaultDeps, ...(depsOverride ?? {}) };
  const traceId = deps.makeTraceId();
  const startedAt = Date.now();
  const route = '/api/chat/message';
  let userIdForLog: string | null = null;
  let aiUsedForLog = false;
  let warningsForLog: string[] = [];
  let actionCountForLog = 0;
  let aiAttemptedForDebug = false;
  let aiSucceededForDebug = false;
  let aiEnabled = false;
  let intentChosenForDebug: ChatIntent = 'request_budget_change';
  let aiIntentForDebug: ChatIntent | null = null;
  let aiFailureStageForDebug:
    | 'disabled'
    | 'call_failed'
    | 'invalid_output'
    | 'fallback_router'
    | null = null;
  let aiErrorMessageForDebug: string | null = null;
  let aiValidationErrorForLog: string | null = null;
  const finalize = (result: HandlerResult): HandlerResult => {
    console.log('chat_message handled', {
      traceId,
      route,
      userId: userIdForLog ?? 'unknown',
      aiUsed: aiUsedForLog,
      aiEnabled,
      aiAttempted: aiAttemptedForDebug,
      aiSucceeded: aiSucceededForDebug,
      aiFailureStage: aiFailureStageForDebug,
      warnings: warningsForLog,
      actionCount: actionCountForLog,
      status: result.status,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  };

  if (opts.method !== 'POST') {
    return finalize(
      errorResponse(
        {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Method not allowed',
          traceId,
        },
        405,
      ),
    );
  }

  try {
    const authorization = getHeader(opts.headers, 'authorization');
    const { userId } = await deps.verifyUser(authorization);
    userIdForLog = userId;

    const body = (opts.body ?? {}) as ChatMessageRequestBody;
    const householdId = body.householdId as Uuid | undefined;
    const messageText = body.messageText as string | undefined;

    if (!householdId || typeof householdId !== 'string') {
      return finalize(
        errorResponse(
          {
            code: 'BAD_REQUEST',
            message: 'Missing householdId',
            traceId,
          },
          400,
        ),
      );
    }
    if (!messageText || typeof messageText !== 'string') {
      return finalize(
        errorResponse(
          {
            code: 'BAD_REQUEST',
            message: 'Missing messageText',
            traceId,
          },
          400,
        ),
      );
    }

    console.log('chat_message incoming', { traceId, messageText });

    const parsed = chatMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return finalize(
        errorResponse(
          {
            code: 'BAD_REQUEST',
            message: 'Invalid request body',
            traceId,
            details: parsed.error.flatten(),
          },
          400,
        ),
      );
    }

    if (messageText.length > MAX_MESSAGE_CHARS) {
      return finalize(
        errorResponse(
          {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Message exceeds ${MAX_MESSAGE_CHARS} characters`,
            traceId,
            details: { max: MAX_MESSAGE_CHARS, length: messageText.length },
          },
          413,
        ),
      );
    }

    await deps.assertUserInHousehold(userId as Uuid, householdId);

    const limiterKey = `${route}:${userId}:${householdId}`;
    const limit = deps.checkRateLimit({
      key: limiterKey,
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX,
    });
    if (!limit.allowed) {
      return finalize(
        errorResponse(
          {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded',
            traceId,
            details: {
              limit: RATE_LIMIT_MAX,
              windowMs: RATE_LIMIT_WINDOW_MS,
              resetAtMs: limit.resetAtMs,
            },
          },
          429,
        ),
      );
    }

    const podsWithSettings = await deps.listPodsWithSettingsForHousehold(householdId, {
      activeOnly: true,
    });
    const pods = podsWithSettings.map((p) => ({
      id: p.pod.id,
      name: p.pod.name,
      budgeted_amount_in_cents: p.settings?.budgeted_amount_in_cents ?? 0,
      category: p.settings?.category ?? null,
      balance_amount_in_cents: p.pod.balance_amount_in_cents,
      balance_error: p.pod.balance_error,
      balance_updated_at: p.pod.balance_updated_at,
    }));

    const base = deps.interpretMessage({
      messageText,
      pods: pods.map((p) => ({
        id: p.id,
        name: p.name,
        budgeted_amount_in_cents: p.budgeted_amount_in_cents ?? 0,
        category: p.category ?? null,
      })),
    });

    const intentChosen = classifyIntent(messageText);
    intentChosenForDebug = intentChosen;

    let assistantText = base.assistantText;
    let proposedActionDrafts = base.proposedActionDrafts;
    let entities = base.entities;
    const observedTransferEvent = base.observedTransferEvent;

    const warnings: string[] = [];
    aiEnabled = process.env.AI_ENABLED === 'true';
    const aiKeyPresent = !!process.env.OPENAI_API_KEY;
    const shouldTryAi =
      aiEnabled && aiKeyPresent && intentChosen !== 'observed_transfer';
    if (aiEnabled && !aiKeyPresent) warnings.push('AI_DISABLED_NO_KEY');
    if (!shouldTryAi) {
      aiFailureStageForDebug =
        aiEnabled && aiKeyPresent ? 'fallback_router' : 'disabled';
    }

    console.log('chat_message decision_branch', {
      traceId,
      branch: shouldTryAi ? 'ai' : 'deterministic',
      intentChosen,
    });

    if (shouldTryAi) {
      try {
        aiAttemptedForDebug = true;
        const ai = await deps.aiProposeBudgetActions({
          messageText,
          pods,
          traceId,
          intent: intentChosen,
        });
        aiUsedForLog = true;
        aiSucceededForDebug = true;
        aiFailureStageForDebug = null;
        aiIntentForDebug = ai.intent;

        if (
          ai.intent === 'observed_transfer' &&
          ai.proposedActionDrafts.some((draft) => draft.type === 'budget_transfer')
        ) {
          throw new AiProposeError(
            'invalid_args',
            'observed_transfer intent cannot include budget_transfer actions',
          );
        }

        assistantText = ai.assistantText;
        proposedActionDrafts =
          intentChosen === 'question_advice' ? [] : ai.proposedActionDrafts;

        const mergedCandidates = Array.from(
          new Set([...(base.entities.candidates ?? []), ...(ai.entities.candidates ?? [])]),
        ).slice(0, 8);
        entities = {
          ...base.entities,
          ...ai.entities,
          candidates: mergedCandidates,
        };
      } catch (err) {
        const msg = asErrorMessage(err);
        const aiStage =
          err instanceof AiProposeError
            ? err.stage
            : msg.toLowerCase().includes('timed out')
              ? 'timeout'
              : 'api_error';
        const warning =
          aiStage === 'timeout'
            ? 'AI_TIMEOUT'
            : aiStage === 'tool_missing' || aiStage === 'tool_parse' || aiStage === 'invalid_args'
              ? 'AI_SCHEMA_INVALID'
              : aiStage === 'missing_key'
                ? 'AI_DISABLED_NO_KEY'
                : 'AI_ERROR';
        aiAttemptedForDebug = true;
        aiFailureStageForDebug =
          aiStage === 'tool_missing' || aiStage === 'tool_parse' || aiStage === 'invalid_args'
            ? 'invalid_output'
            : aiStage === 'missing_key'
              ? 'disabled'
              : 'call_failed';
        aiErrorMessageForDebug = msg;
        aiValidationErrorForLog = aiStage === 'invalid_args' ? msg : null;
        console.error('chat_message ai_exception', { traceId, error: err, stage: aiStage });
        warnings.push(warning, 'AI_FALLBACK_TO_DETERMINISTIC');
      }
    }

    warningsForLog = warnings;
    actionCountForLog = proposedActionDrafts.length;

    const thread = await deps.getOrCreateChatThreadForHousehold(householdId);
    await deps.insertChatMessage({
      threadId: thread.id,
      senderRole: 'user',
      senderUserId: userId as Uuid,
      text: messageText,
    });

    const assistantMessage = await deps.insertChatMessage({
      threadId: thread.id,
      senderRole: 'assistant',
      senderUserId: null,
      text: assistantText,
    });

    if (observedTransferEvent) {
      const amountInCents = observedTransferEvent.amount_in_cents;
      const fromPodId = observedTransferEvent.from_pod_id;
      const toPodId = observedTransferEvent.to_pod_id;
      const hasRecent = await deps.hasRecentObservedTransfer({
        householdId,
        fromPodId,
        toPodId,
        amountInCents,
      });

      if (!hasRecent) {
        await deps.insertBudgetEvents([
          {
            household_id: householdId,
            actor_user_id: userId as Uuid,
            type: 'observed_transfer',
            payload: observedTransferEvent,
          },
        ]);
      }
    }

    const actionRows = await deps.insertProposedActions({
      householdId,
      assistantMessageId: assistantMessage.id,
      actionDrafts: proposedActionDrafts,
    });

    const modeChosen: 'advisory' | 'proposal' | 'deterministic' | 'help_fallback' =
      aiSucceededForDebug
        ? 'proposal'
        : proposedActionDrafts.length > 0
          ? 'deterministic'
          : assistantText.startsWith('I can help with:')
            ? 'help_fallback'
            : 'advisory';

    const response: ChatMessageResponseBody = {
      apiVersion: API_VERSION,
      traceId,
      aiUsed: aiUsedForLog,
      warnings: warningsForLog,
      assistantText,
      proposedActions: actionRows.map(deps.toApiProposedAction),
      entities,
      debug: {
        traceId,
        aiEnabled,
        aiAttempted: aiAttemptedForDebug,
        aiSucceeded: aiSucceededForDebug,
        aiFailureStage: aiFailureStageForDebug,
        aiErrorMessage: aiErrorMessageForDebug
          ? aiErrorMessageForDebug.replace(/\s+/g, ' ').trim().slice(0, 180)
          : null,
        modeChosen,
        intentChosen: intentChosenForDebug,
        aiIntent: aiIntentForDebug,
      },
    };

    return finalize({ status: 200, json: response });
  } catch (err) {
    const msg = asErrorMessage(err);
    const status =
      msg.includes('Missing Authorization header') ||
      msg.includes('Invalid Authorization') ||
      msg.includes('Invalid token') ||
      msg.includes('auth.getUser')
        ? 401
        : msg.includes('User is not a member of this household')
          ? 403
          : 500;

    const code =
      status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : 'INTERNAL_ERROR';
    return finalize(
      errorResponse(
        {
          code,
          message: msg,
          traceId,
        },
        status,
      ),
    );
  }
}

