import { verifyUser } from '../auth/verifyUser';
import { generateProposals } from '../ai/generateProposals';
import { MAX_MESSAGE_CHARS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../config';
import { hasRecentObservedTransfer, insertBudgetEvents } from '../repos/budgetEventsRepo';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { insertChatMessage } from '../repos/chatMessagesRepo';
import { getOrCreateChatThreadForHousehold } from '../repos/chatThreadsRepo';
import { insertProposedActions, toApiProposedAction } from '../repos/proposedActionsRepo';
import { listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import type { ChatMessageRequestBody, ChatMessageResponseBody } from '../types/chat';
import type { Uuid } from '../types/supabase';
import { errorResponse } from '../http/errors';
import { checkRateLimit } from '../http/rateLimit';
import { makeTraceId } from '../http/trace';
import { chatMessageRequestSchema } from '../http/validation';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

export async function handleChatMessage(opts: {
  method: string;
  headers: Record<string, any>;
  body: any;
}): Promise<HandlerResult> {
  const traceId = makeTraceId();
  const startedAt = Date.now();
  const route = '/api/chat/message';
  let userIdForLog: string | null = null;
  const finalize = (result: HandlerResult): HandlerResult => {
    console.log('chat_message handled', {
      traceId,
      route,
      userId: userIdForLog ?? 'unknown',
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
    const { userId } = await verifyUser(authorization);
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
            code: 'BAD_REQUEST',
            message: `Message exceeds ${MAX_MESSAGE_CHARS} characters`,
            traceId,
            details: { max: MAX_MESSAGE_CHARS, length: messageText.length },
          },
          400,
        ),
      );
    }

    await assertUserInHousehold(userId as Uuid, householdId);

    const limiterKey = `${route}:${userId}:${householdId}`;
    const limit = checkRateLimit({
      key: limiterKey,
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX,
    });
    if (!limit.allowed) {
      return finalize(
        errorResponse(
          {
            code: 'TOO_MANY_REQUESTS',
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

    const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
      activeOnly: true,
    });
    const pods = podsWithSettings.map((p) => ({
      id: p.pod.id,
      name: p.pod.name,
      budgeted_amount_in_cents: p.settings?.budgeted_amount_in_cents ?? 0,
      category: p.settings?.category ?? null,
    }));

    const { assistantText, proposedActionDrafts, entities, observedTransferEvent } =
      await generateProposals({
      messageText,
      pods,
    });

    const thread = await getOrCreateChatThreadForHousehold(householdId);
    await insertChatMessage({
      threadId: thread.id,
      senderRole: 'user',
      senderUserId: userId as Uuid,
      text: messageText,
    });

    const assistantMessage = await insertChatMessage({
      threadId: thread.id,
      senderRole: 'assistant',
      senderUserId: null,
      text: assistantText,
    });

    if (observedTransferEvent) {
      const amountInCents = observedTransferEvent.amount_in_cents;
      const fromPodId = observedTransferEvent.from_pod_id;
      const toPodId = observedTransferEvent.to_pod_id;
      const hasRecent = await hasRecentObservedTransfer({
        householdId,
        fromPodId,
        toPodId,
        amountInCents,
      });

      if (hasRecent) {
        console.log('observed_transfer dedup hit: skipping insert', {
          householdId,
          fromPodId,
          toPodId,
          amountInCents,
        });
      } else {
        await insertBudgetEvents([
          {
            household_id: householdId,
            actor_user_id: userId as Uuid,
            type: 'observed_transfer',
            payload: observedTransferEvent,
          },
        ]);
        console.log('observed_transfer inserted', {
          householdId,
          fromPodId,
          toPodId,
          amountInCents,
        });
      }
    }

    const actionRows = await insertProposedActions({
      householdId,
      assistantMessageId: assistantMessage.id,
      actionDrafts: proposedActionDrafts,
    });

    const response: ChatMessageResponseBody = {
      apiVersion: 'v1',
      traceId,
      assistantText,
      proposedActions: actionRows.map(toApiProposedAction),
      entities,
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

