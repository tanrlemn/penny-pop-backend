import type { PodSettingsCategory, Uuid } from '../types/supabase';
import type { ParsedEntitiesHints, ProposedActionDraft } from '../types/chat';

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

type PodSnapshot = {
  id: Uuid;
  name: string;
  budgeted_amount_in_cents?: number | null;
  category?: PodSettingsCategory | null;
};

type TransferIntent = 'observed_transfer' | 'request_transfer' | 'unknown';

interface ObservedTransferEventDraft {
  amount_in_cents: number;
  from_pod_id: Uuid;
  from_pod_name: string;
  to_pod_id: Uuid;
  to_pod_name: string;
  raw_message_text: string;
}

function stripOuterQuotes(s: string): string {
  const trimmed = s.trim();
  return trimmed.replace(/^[“"']+/, '').replace(/[”"']+$/, '').trim();
}

const MOVE_TO_POD_NAME = 'Move to ___';
const PROTECTED_POD_NAMES = new Set(
  [
    'Rent',
    'Utilities',
    'AES Electric',
    'Citizens Gas Water',
    'Phones',
    'Wifi',
    'Sequence Billing',
  ].map(normalizeName),
);

function getAvailableToReduce(pod: PodSnapshot): number {
  return Math.max(0, pod.budgeted_amount_in_cents ?? 0);
}

function isProtectedPodName(name: string): boolean {
  return PROTECTED_POD_NAMES.has(normalizeName(name));
}

function categoryRank(category: PodSettingsCategory | null | undefined, isDonor: boolean): number {
  if (category === 'Savings' && isDonor) return 5;
  if (category === 'Savings') return 1;
  if (category === 'Discretionary') return 2;
  if (category === 'Pressing') return 3;
  if (category === 'Necessities') return 4;
  return 5;
}

function sortFundingCandidates(
  candidates: Array<{
    pod: PodSnapshot;
    available: number;
    isProtected: boolean;
    isMoveTo: boolean;
    isDonor: boolean;
  }>,
): Array<{
  pod: PodSnapshot;
  available: number;
  isProtected: boolean;
  isMoveTo: boolean;
  isDonor: boolean;
}> {
  return [...candidates].sort((a, b) => {
    if (a.isMoveTo !== b.isMoveTo) return a.isMoveTo ? -1 : 1;
    const aRank = categoryRank(a.pod.category ?? null, a.isDonor);
    const bRank = categoryRank(b.pod.category ?? null, b.isDonor);
    if (aRank !== bRank) return aRank - bRank;
    if (a.isDonor !== b.isDonor) return a.isDonor ? 1 : -1;
    return a.pod.name.localeCompare(b.pod.name);
  });
}

function selectFundingOptions(opts: {
  pods: PodSnapshot[];
  donorPodId: Uuid;
  amountInCents: number;
  maxOptions?: number;
}): {
  singleOptions: PodSnapshot[];
  splitOptions: Array<{
    a: PodSnapshot;
    b: PodSnapshot;
    aAmount: number;
    bAmount: number;
  }>;
} {
  const maxOptions = opts.maxOptions ?? 3;
  const baseCandidates = opts.pods.map((pod) => ({
    pod,
    available: getAvailableToReduce(pod),
    isProtected: isProtectedPodName(pod.name),
    isMoveTo: pod.name === MOVE_TO_POD_NAME,
    isDonor: pod.id === opts.donorPodId,
  }));

  const fullCoverage = baseCandidates.filter((c) => c.available >= opts.amountInCents);
  const fullCoverageNonProtected = fullCoverage.filter((c) => !c.isProtected);
  const fullPool = fullCoverageNonProtected.length > 0 ? fullCoverageNonProtected : fullCoverage;
  const rankedSingles = sortFundingCandidates(fullPool).slice(0, maxOptions);

  if (rankedSingles.length > 0) {
    return { singleOptions: rankedSingles.map((c) => c.pod), splitOptions: [] };
  }

  const splitCandidates = baseCandidates.filter((c) => c.available > 0);
  const splitNonProtected = splitCandidates.filter((c) => !c.isProtected);
  const splitPool =
    splitNonProtected.length >= 2 ? splitNonProtected : splitCandidates;
  const rankedSplit = sortFundingCandidates(splitPool);
  const splitOptions: Array<{
    a: PodSnapshot;
    b: PodSnapshot;
    aAmount: number;
    bAmount: number;
  }> = [];

  for (let i = 0; i < rankedSplit.length; i += 1) {
    for (let j = i + 1; j < rankedSplit.length; j += 1) {
      const a = rankedSplit[i];
      const b = rankedSplit[j];
      const aAmount = Math.min(a.available, opts.amountInCents);
      const remaining = opts.amountInCents - aAmount;
      if (remaining <= 0) continue;
      if (remaining <= b.available) {
        splitOptions.push({
          a: a.pod,
          b: b.pod,
          aAmount,
          bAmount: remaining,
        });
      }
      if (splitOptions.length >= maxOptions) break;
    }
    if (splitOptions.length >= maxOptions) break;
  }

  return { singleOptions: [], splitOptions };
}

function detectTransferIntent(messageText: string): TransferIntent {
  const text = stripOuterQuotes(messageText).toLowerCase();

  const observed =
    /\bi\s+(?:already\s+)?moved\b/.test(text) ||
    /\bi\s+transferred\b/.test(text) ||
    /\bi\s+had\s+to\s+move\b/.test(text) ||
    /\bi\s+had\s+to\s+transfer\b/.test(text) ||
    /^\s*(?:moved|transferred)\b/.test(text);

  if (observed) return 'observed_transfer';

  const requested = /\b(move|transfer)\b/.test(text);
  if (requested) return 'request_transfer';

  return 'unknown';
}

function parseUsdToCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function rankCandidates(query: string, podNames: string[], limit = 8): string[] {
  const q = normalizeName(query);
  if (!q) return podNames.slice(0, limit);

  const scored = podNames
    .map((name) => {
      const n = normalizeName(name);
      let score = 0;

      if (n === q) score += 1000;
      if (n.startsWith(q)) score += 300;
      if (n.includes(q)) score += 200;

      // token overlap
      const qTokens = new Set(q.split(' ').filter(Boolean));
      const nTokens = new Set(n.split(' ').filter(Boolean));
      let overlap = 0;
      for (const t of qTokens) if (nTokens.has(t)) overlap += 1;
      score += overlap * 50;

      // prefer closer lengths
      score -= Math.abs(n.length - q.length);

      return { name, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit).map((s) => s.name);
}

function resolveUniquePodIdByName(opts: {
  raw: string;
  pods: Array<{ id: Uuid; name: string }>;
}): { id: Uuid; name: string } | null {
  const q = normalizeName(opts.raw);
  if (!q) return null;

  const exact = opts.pods.filter((p) => normalizeName(p.name) === q);
  if (exact.length === 1) return exact[0];

  const starts = opts.pods.filter((p) => normalizeName(p.name).startsWith(q));
  if (starts.length === 1) return starts[0];

  const contains = opts.pods.filter((p) => normalizeName(p.name).includes(q));
  if (contains.length === 1) return contains[0];

  return null;
}

export function interpretMessage(opts: {
  messageText: string;
  pods: PodSnapshot[];
}): {
  assistantText: string;
  proposedActionDrafts: ProposedActionDraft[];
  entities: ParsedEntitiesHints;
  observedTransferEvent?: ObservedTransferEventDraft;
} {
  const messageText = (opts.messageText ?? '').trim();
  const strippedMessageText = stripOuterQuotes(messageText);
  const pods = opts.pods;
  const podNames = pods.map((p) => p.name);
  const transferIntent = detectTransferIntent(strippedMessageText);

  // 1) moved $X from A to B
  {
    const m = strippedMessageText.match(
      /^\s*(?:i\s+(?:already\s+)?(?:moved|transferred)|i\s+had\s+to\s+(?:move|transfer)|i\s+need\s+to\s+(?:move|transfer)|can\s+you\s+(?:move|transfer)|(?:move|transfer|moved|transferred))\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+from\s+(.+?)\s+to\s+(.+?)\s*$/i,
    );
    if (m) {
      const amountRaw = m[1] ?? '';
      const fromRaw = (m[2] ?? '').trim();
      const toRaw = (m[3] ?? '').trim();
      const amountInCents = parseUsdToCents(amountRaw);

      const candidates = Array.from(
        new Set([
          ...rankCandidates(fromRaw, podNames),
          ...rankCandidates(toRaw, podNames),
        ]),
      );

      const entities: ParsedEntitiesHints = {
        fromCandidate: fromRaw,
        toCandidate: toRaw,
        candidates,
      };

      if (amountInCents == null) {
        return {
          assistantText:
            `I couldn’t parse the amount in “${messageText}”. Try something like: moved $80 from Groceries to Education.`,
          proposedActionDrafts: [],
          entities,
        };
      }

      const from = resolveUniquePodIdByName({ raw: fromRaw, pods });
      const to = resolveUniquePodIdByName({ raw: toRaw, pods });

      if (!from || !to) {
        return {
          assistantText:
            `Which pods did you mean? I couldn’t uniquely match “${fromRaw}” and/or “${toRaw}”.`,
          proposedActionDrafts: [],
          entities,
        };
      }

      if (from.id === to.id) {
        return {
          assistantText: `Those look like the same pod (“${from.name}”). Which pod should receive the money?`,
          proposedActionDrafts: [],
          entities,
        };
      }

      const observedTransferEvent: ObservedTransferEventDraft = {
        amount_in_cents: amountInCents,
        from_pod_id: from.id,
        from_pod_name: from.name,
        to_pod_id: to.id,
        to_pod_name: to.name,
        raw_message_text: messageText,
      };

      if (transferIntent === 'observed_transfer') {
        const { singleOptions, splitOptions } = selectFundingOptions({
          pods,
          donorPodId: from.id,
          amountInCents,
        });
        const optionLabels = ['A', 'B', 'C'];
        const primaryFundingCandidate =
          singleOptions[0]?.name ??
          splitOptions[0]?.a.name ??
          splitOptions[0]?.b.name ??
          MOVE_TO_POD_NAME;
        const repairCandidates = Array.from(
          new Set([...candidates, ...rankCandidates(primaryFundingCandidate ?? '', podNames)]),
        );

        const repairEntities: ParsedEntitiesHints = {
          fromCandidate: fromRaw,
          toCandidate: toRaw,
          fundingCandidate: primaryFundingCandidate,
          candidates: repairCandidates,
        };

        if (singleOptions.length === 0 && splitOptions.length === 0) {
          return {
            assistantText:
              `Got it — logged that transfer. Which pod should I pull from to repair the budget plan?`,
            proposedActionDrafts: [],
            entities: repairEntities,
            observedTransferEvent,
          };
        }

        if (splitOptions.length > 0) {
          const proposedActionDrafts: ProposedActionDraft[] = [];
          splitOptions.forEach((opt, index) => {
            const optionLabel = optionLabels[index] ?? undefined;
            proposedActionDrafts.push(
              {
                type: 'budget_repair_restore_donor',
                payload: {
                  kind: 'budget_repair_restore_donor',
                  amount_in_cents: opt.aAmount,
                  donor_pod_id: from.id,
                  donor_pod_name: from.name,
                  funding_pod_id: opt.a.id,
                  funding_pod_name: opt.a.name,
                  option_label: optionLabel,
                },
              },
              {
                type: 'budget_repair_restore_donor',
                payload: {
                  kind: 'budget_repair_restore_donor',
                  amount_in_cents: opt.bAmount,
                  donor_pod_id: from.id,
                  donor_pod_name: from.name,
                  funding_pod_id: opt.b.id,
                  funding_pod_name: opt.b.name,
                  option_label: optionLabel,
                },
              },
            );
          });

          return {
            assistantText:
              proposedActionDrafts.length > 2
                ? `Got it — logged that transfer. I can split the repair across a couple of funding pods. Here are a few options.`
                : `Got it — logged that transfer. I can split the repair across a couple of funding pods.`,
            proposedActionDrafts,
            entities: repairEntities,
            observedTransferEvent,
          };
        }

        const proposedActionDrafts: ProposedActionDraft[] = singleOptions.map((pod, index) => ({
          type: 'budget_repair_restore_donor',
          payload: {
            kind: 'budget_repair_restore_donor',
            amount_in_cents: amountInCents,
            donor_pod_id: from.id,
            donor_pod_name: from.name,
            funding_pod_id: pod.id,
            funding_pod_name: pod.name,
            option_label: singleOptions.length > 1 ? optionLabels[index] : undefined,
          },
        }));

        return {
          assistantText:
            proposedActionDrafts.length > 1
              ? `Got it — logged that transfer. Here are a few ways to repair your budget plan.`
              : `Got it — logged that transfer. Here’s the cleanest way to repair your budget plan.`,
          proposedActionDrafts,
          entities: repairEntities,
          observedTransferEvent,
        };
      }

      return {
        assistantText: `Proposed: move $${(amountInCents / 100).toFixed(2)} of budget from ${from.name} to ${to.name}.`,
        proposedActionDrafts: [
          {
            type: 'budget_transfer',
            payload: {
              kind: 'budget_transfer',
              amount_in_cents: amountInCents,
              from_pod_id: from.id,
              from_pod_name: from.name,
              to_pod_id: to.id,
              to_pod_name: to.name,
            },
          },
        ],
        entities,
      };
    }
  }

  // 2) X is short $Y
  {
    const m = messageText.match(/^\s*(.+?)\s+is\s+short\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
    if (m) {
      const podRaw = (m[1] ?? '').trim();
      const amountRaw = m[2] ?? '';
      const amountInCents = parseUsdToCents(amountRaw);
      const candidates = rankCandidates(podRaw, podNames);

      const entities: ParsedEntitiesHints = {
        toCandidate: podRaw,
        candidates,
      };

      if (amountInCents == null) {
        return {
          assistantText:
            `I couldn’t parse the amount in “${messageText}”. Try something like: Groceries is short $40.`,
          proposedActionDrafts: [],
          entities,
        };
      }

      const pod = resolveUniquePodIdByName({ raw: podRaw, pods });
      if (!pod) {
        return {
          assistantText: `Which pod did you mean by “${podRaw}”?`,
          proposedActionDrafts: [],
          entities,
        };
      }

      return {
        assistantText: `Proposed: increase ${pod.name} budget by $${(amountInCents / 100).toFixed(2)}.`,
        proposedActionDrafts: [
          {
            type: 'budget_adjust',
            payload: {
              kind: 'budget_adjust',
              delta_in_cents: amountInCents,
              pod_id: pod.id,
              pod_name: pod.name,
            },
          },
        ],
        entities,
      };
    }
  }

  // 3) rent due soon (clarifying-first in-app)
  if (/\brent\s+due\s+soon\b/i.test(messageText)) {
    const candidates = rankCandidates('rent', podNames);
    return {
      assistantText:
        `Got it. Which pod is “rent” for you, and how much is due?`,
      proposedActionDrafts: [],
      entities: {
        toCandidate: 'rent',
        candidates,
      },
    };
  }

  return {
    assistantText:
      `I can help with:\n- “moved $80 from Groceries to Education”\n- “Groceries is short $40”\n- “rent due soon” (I’ll ask a quick follow-up)\n\nTry one of those formats.`,
    proposedActionDrafts: [],
    entities: { candidates: podNames.slice(0, 8) },
  };
}

