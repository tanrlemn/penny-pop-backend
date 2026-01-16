import { verifyUser } from '../auth/verifyUser';
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../config';
import { insertBudgetEvents } from '../repos/budgetEventsRepo';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { getProposedActionsForHouseholdByIds, markProposedActionsApplied, markProposedActionFailed } from '../repos/proposedActionsRepo';
import { listPodsByIds, listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import { listPodSettingsByPodIds, upsertPodBudgetedAmountsInCents } from '../repos/podSettingsRepo';
import type { ApplyActionsResponseBody, ProposedActionPayload } from '../types/chat';
import type { PodWithSettings, Uuid } from '../types/supabase';
import { errorResponse } from '../http/errors';
import { checkRateLimit } from '../http/rateLimit';
import { makeTraceId } from '../http/trace';
import { applyActionsRequestSchema } from '../http/validation';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

function toSnapshot(
  pods: PodWithSettings[],
  appliedActionIds: Uuid[],
  changes: ApplyActionsResponseBody['changes'],
): ApplyActionsResponseBody {
  return {
    appliedActionIds,
    changes,
    pods: pods.map((p) => ({
      id: p.pod.id,
      name: p.pod.name,
      balance_amount_in_cents: p.pod.balance_amount_in_cents,
      budgeted_amount_in_cents: p.settings?.budgeted_amount_in_cents ?? null,
      category: p.settings?.category ?? null,
    })),
  };
}

function toChanges(
  podIds: Uuid[],
  podsById: Map<Uuid, { id: Uuid; name: string }>,
  beforeBudgetByPodId: Map<Uuid, number>,
  afterBudgetByPodId: Map<Uuid, number>,
): ApplyActionsResponseBody['changes'] {
  const changes: ApplyActionsResponseBody['changes'] = [];
  for (const podId of podIds) {
    const before = beforeBudgetByPodId.get(podId) ?? 0;
    const after = afterBudgetByPodId.get(podId) ?? 0;
    const delta = after - before;
    if (delta === 0) continue;
    const pod = podsById.get(podId);
    if (!pod) continue;
    changes.push({
      pod_id: podId,
      pod_name: pod.name,
      delta_in_cents: delta,
      before_in_cents: before,
      after_in_cents: after,
    });
  }
  return changes;
}

function assertNonNegativeBudget(next: number, podName: string) {
  if (next < 0) {
    throw new Error(`Budget for ${podName} would become negative (${next} cents).`);
  }
}

export function applyPayloadsToBudgetMap(
  payloads: ProposedActionPayload[],
  budgetByPodId: Map<Uuid, number>,
): void {
  for (const payload of payloads) {
    if (payload.kind === 'budget_transfer') {
      const amt = payload.amount_in_cents;
      const fromCur = budgetByPodId.get(payload.from_pod_id) ?? 0;
      const toCur = budgetByPodId.get(payload.to_pod_id) ?? 0;
      const fromNext = fromCur - amt;
      const toNext = toCur + amt;
      assertNonNegativeBudget(fromNext, payload.from_pod_name);
      budgetByPodId.set(payload.from_pod_id, fromNext);
      budgetByPodId.set(payload.to_pod_id, toNext);
      continue;
    }

    if (payload.kind === 'budget_adjust') {
      const cur = budgetByPodId.get(payload.pod_id) ?? 0;
      const next = cur + payload.delta_in_cents;
      assertNonNegativeBudget(next, payload.pod_name);
      budgetByPodId.set(payload.pod_id, next);
      continue;
    }

    if (payload.kind === 'budget_repair_restore_donor') {
      const amt = payload.amount_in_cents;
      const donorCur = budgetByPodId.get(payload.donor_pod_id) ?? 0;
      const fundingCur = budgetByPodId.get(payload.funding_pod_id) ?? 0;
      const donorNext = donorCur + amt;
      const fundingNext = fundingCur - amt;
      assertNonNegativeBudget(fundingNext, payload.funding_pod_name);
      budgetByPodId.set(payload.donor_pod_id, donorNext);
      budgetByPodId.set(payload.funding_pod_id, fundingNext);
      continue;
    }

    // Unknown payload kinds should not happen in Phase 1.
    throw new Error(`Unsupported action payload kind: ${(payload as any)?.kind}`);
  }
}

export async function handleApplyActions(opts: {
  method: string;
  headers: Record<string, any>;
  body: any;
}): Promise<HandlerResult> {
  const traceId = makeTraceId();
  const startedAt = Date.now();
  const route = '/api/actions/apply';
  let userIdForLog: string | null = null;
  const finalize = (result: HandlerResult): HandlerResult => {
    console.log('apply_actions handled', {
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

  const appliedAtISO = new Date().toISOString();

  try {
    const authorization = getHeader(opts.headers, 'authorization');
    const { userId } = await verifyUser(authorization);
    userIdForLog = userId;

    const body = (opts.body ?? {}) as { householdId?: Uuid; actionIds?: Uuid[] };
    const householdId = body.householdId as Uuid | undefined;
    const actionIds = (body.actionIds ?? []) as Uuid[];

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
    if (!Array.isArray(actionIds) || actionIds.length === 0) {
      return finalize(
        errorResponse(
          {
            code: 'BAD_REQUEST',
            message: 'Missing actionIds[]',
            traceId,
          },
          400,
        ),
      );
    }

    const parsed = applyActionsRequestSchema.safeParse(body);
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

    const actions = await getProposedActionsForHouseholdByIds({
      householdId,
      actionIds,
    });

    if (actions.length !== actionIds.length) {
      const found = new Set(actions.map((a) => a.id));
      const missing = actionIds.filter((id) => !found.has(id));
      return finalize(
        errorResponse(
          {
            code: 'NOT_FOUND',
            message: 'Some actionIds were not found',
            traceId,
            details: { missing },
          },
          404,
        ),
      );
    }

    const anyNonProposed = actions.some((a) => a.status !== 'proposed');
    if (anyNonProposed) {
      const allApplied = actions.every((a) => a.status === 'applied');
      if (allApplied) {
        const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
          activeOnly: true,
        });
        return finalize({
          status: 200,
          json: {
            apiVersion: 'v1',
            traceId,
            ...toSnapshot(podsWithSettings, actionIds, []),
          },
        });
      }

      const firstNonProposed = actions.find((a) => a.status !== 'proposed');
      return finalize(
        errorResponse(
          {
            code: 'CONFLICT',
            message: `Action ${firstNonProposed?.id} is not in proposed status`,
            traceId,
            details: { status: firstNonProposed?.status },
          },
          409,
        ),
      );
    }

    const payloads = actions.map((a) => ({
      id: a.id,
      type: a.type,
      payload: a.payload_json as ProposedActionPayload,
    }));

    // Validate pods referenced by payloads belong to household.
    const podIds = Array.from(
      new Set(
        payloads.flatMap((p) => {
          if (p.payload?.kind === 'budget_transfer') {
            return [p.payload.from_pod_id, p.payload.to_pod_id];
          }
          if (p.payload?.kind === 'budget_adjust') {
            return [p.payload.pod_id];
          }
          if (p.payload?.kind === 'budget_repair_restore_donor') {
            return [p.payload.donor_pod_id, p.payload.funding_pod_id];
          }
          return [];
        }),
      ),
    );

    const pods = await listPodsByIds(podIds);
    const podsById = new Map(pods.map((p) => [p.id, p] as const));

    for (const podId of podIds) {
      const pod = podsById.get(podId);
      if (!pod) {
        return finalize(
          errorResponse(
            {
              code: 'BAD_REQUEST',
              message: `Pod not found for pod_id=${podId}`,
              traceId,
            },
            400,
          ),
        );
      }
      if (pod.household_id !== householdId) {
        return finalize(
          errorResponse(
            {
              code: 'FORBIDDEN',
              message: `Pod ${podId} is not in this household`,
              traceId,
            },
            403,
          ),
        );
      }
    }

    const settings = await listPodSettingsByPodIds(podIds);
    const budgetByPodId = new Map<Uuid, number>();
    for (const podId of podIds) budgetByPodId.set(podId, 0);
    for (const s of settings) {
      budgetByPodId.set(s.pod_id, s.budgeted_amount_in_cents ?? 0);
    }
    const beforeBudgetByPodId = new Map(budgetByPodId);

    // Compute final budgets deterministically.
    try {
      applyPayloadsToBudgetMap(
        payloads.map((p) => p.payload),
        budgetByPodId,
      );
    } catch (err) {
      const msg = asErrorMessage(err);
      return finalize(
        errorResponse(
          {
            code: 'BAD_REQUEST',
            message: msg,
            traceId,
          },
          400,
        ),
      );
    }

    const changes = toChanges(podIds, podsById, beforeBudgetByPodId, budgetByPodId);
    const updates = Array.from(budgetByPodId.entries()).map(([podId, cents]) => ({
      podId,
      budgetedAmountInCents: cents,
    }));

    await upsertPodBudgetedAmountsInCents(updates);

    await insertBudgetEvents(
      payloads.map((a) => ({
        household_id: householdId,
        actor_user_id: userId as Uuid,
        type: a.type,
        payload: {
          action_id: a.id,
          ...a.payload,
          applied_at: appliedAtISO,
        },
      })),
    );

    await markProposedActionsApplied({
      householdId,
      actionIds,
      appliedBy: userId as Uuid,
      appliedAtISO,
    });

    const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
      activeOnly: true,
    });
    return finalize({
      status: 200,
      json: {
        apiVersion: 'v1',
        traceId,
        ...toSnapshot(podsWithSettings, actionIds, changes),
      },
    });
  } catch (err) {
    const msg = asErrorMessage(err);

    // Best-effort mark single-action failures if possible.
    const householdId = opts.body?.householdId as Uuid | undefined;
    const actionIds = (opts.body?.actionIds ?? []) as Uuid[];
    const authorization = getHeader(opts.headers, 'authorization');
    try {
      if (householdId && Array.isArray(actionIds) && actionIds.length === 1) {
        const { userId } = await verifyUser(authorization);
        await markProposedActionFailed({
          householdId,
          actionId: actionIds[0],
          appliedBy: userId as Uuid,
          appliedAtISO,
        });
      }
    } catch {
      // swallow
    }

    const status =
      msg.includes('Missing Authorization header') ||
      msg.includes('Invalid Authorization') ||
      msg.includes('Invalid token') ||
      msg.includes('auth.getUser')
        ? 401
        : msg.includes('User is not a member of this household')
          ? 403
          : msg.includes('would become negative')
            ? 400
            : 500;

    const code =
      status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 400
            ? 'BAD_REQUEST'
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

