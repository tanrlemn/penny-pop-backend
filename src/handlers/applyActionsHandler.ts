import { verifyUser } from '../auth/verifyUser';
import { insertBudgetEvents } from '../repos/budgetEventsRepo';
import { assertUserInHousehold } from '../repos/householdsRepo';
import { getProposedActionsForHouseholdByIds, markProposedActionsApplied, markProposedActionFailed } from '../repos/proposedActionsRepo';
import { listPodsByIds, listPodsWithSettingsForHousehold } from '../repos/podsRepo';
import { listPodSettingsByPodIds, upsertPodBudgetedAmountsInCents } from '../repos/podSettingsRepo';
import type { ApplyActionsResponseBody, ProposedActionPayload } from '../types/chat';
import type { PodWithSettings, Uuid } from '../types/supabase';
import { asErrorMessage, getHeader, type HandlerResult } from './http';

function toSnapshot(pods: PodWithSettings[]): ApplyActionsResponseBody {
  return {
    pods: pods.map((p) => ({
      id: p.pod.id,
      name: p.pod.name,
      balance_amount_in_cents: p.pod.balance_amount_in_cents,
      budgeted_amount_in_cents: p.settings?.budgeted_amount_in_cents ?? null,
      category: p.settings?.category ?? null,
    })),
  };
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
  if (opts.method !== 'POST') {
    return { status: 405, json: { error: 'Method not allowed' } };
  }

  const appliedAtISO = new Date().toISOString();

  try {
    const authorization = getHeader(opts.headers, 'authorization');
    const { userId } = await verifyUser(authorization);

    const householdId = opts.body?.householdId as Uuid | undefined;
    const actionIds = (opts.body?.actionIds ?? []) as Uuid[];

    if (!householdId || typeof householdId !== 'string') {
      return { status: 400, json: { error: 'Missing householdId' } };
    }
    if (!Array.isArray(actionIds) || actionIds.length === 0) {
      return { status: 400, json: { error: 'Missing actionIds[]' } };
    }

    await assertUserInHousehold(userId as Uuid, householdId);

    const actions = await getProposedActionsForHouseholdByIds({
      householdId,
      actionIds,
    });

    if (actions.length !== actionIds.length) {
      const found = new Set(actions.map((a) => a.id));
      const missing = actionIds.filter((id) => !found.has(id));
      return { status: 404, json: { error: 'Some actionIds were not found', missing } };
    }

    const anyNonProposed = actions.some((a) => a.status !== 'proposed');
    if (anyNonProposed) {
      const allApplied = actions.every((a) => a.status === 'applied');
      if (allApplied) {
        const podsWithSettings = await listPodsWithSettingsForHousehold(householdId, {
          activeOnly: true,
        });
        return { status: 200, json: toSnapshot(podsWithSettings) };
      }

      const firstNonProposed = actions.find((a) => a.status !== 'proposed');
      return {
        status: 409,
        json: {
          error: `Action ${firstNonProposed?.id} is not in proposed status`,
          status: firstNonProposed?.status,
        },
      };
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
        return { status: 400, json: { error: `Pod not found for pod_id=${podId}` } };
      }
      if (pod.household_id !== householdId) {
        return { status: 403, json: { error: `Pod ${podId} is not in this household` } };
      }
    }

    const settings = await listPodSettingsByPodIds(podIds);
    const budgetByPodId = new Map<Uuid, number>();
    for (const podId of podIds) budgetByPodId.set(podId, 0);
    for (const s of settings) {
      budgetByPodId.set(s.pod_id, s.budgeted_amount_in_cents ?? 0);
    }

    // Compute final budgets deterministically.
    try {
      applyPayloadsToBudgetMap(
        payloads.map((p) => p.payload),
        budgetByPodId,
      );
    } catch (err) {
      const msg = asErrorMessage(err);
      return { status: 400, json: { error: msg } };
    }

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
    return { status: 200, json: toSnapshot(podsWithSettings) };
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

    return { status, json: { error: msg } };
  }
}

