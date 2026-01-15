import { verifyUser } from '../auth/verifyUser';
import { interpretMessage } from '../chat/interpretMessage';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { insertChatMessage } from '../repos/chatMessagesRepo';
import { getOrCreateChatThreadForHousehold } from '../repos/chatThreadsRepo';
import { insertProposedActions, toApiProposedAction } from '../repos/proposedActionsRepo';
import { listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import type { ChatMessageRequestBody, ChatMessageResponseBody } from '../types/chat';
import type { Uuid } from '../types/supabase';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

export async function handleChatMessage(opts: {
  method: string;
  headers: Record<string, any>;
  body: any;
}): Promise<HandlerResult> {
  if (opts.method !== 'POST') {
    return { status: 405, json: { error: 'Method not allowed' } };
  }

  try {
    const authorization = getHeader(opts.headers, 'authorization');
    const { userId } = await verifyUser(authorization);

    const householdId = opts.body?.householdId as Uuid | undefined;
    const messageText = opts.body?.messageText as string | undefined;

    if (!householdId || typeof householdId !== 'string') {
      return { status: 400, json: { error: 'Missing householdId' } };
    }
    if (!messageText || typeof messageText !== 'string') {
      return { status: 400, json: { error: 'Missing messageText' } };
    }

    await assertUserInHousehold(userId as Uuid, householdId);

    const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
      activeOnly: true,
    });
    const pods = podsWithSettings.map((p) => ({ id: p.pod.id, name: p.pod.name }));

    const { assistantText, proposedActionDrafts, entities } = interpretMessage({
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

    const actionRows = await insertProposedActions({
      householdId,
      assistantMessageId: assistantMessage.id,
      actionDrafts: proposedActionDrafts,
    });

    const response: ChatMessageResponseBody = {
      assistantText,
      proposedActions: actionRows.map(toApiProposedAction),
      entities,
    };

    return { status: 200, json: response };
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

    return { status, json: { error: msg } };
  }
}

