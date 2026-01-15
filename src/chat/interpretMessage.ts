import type { Uuid } from '../types/supabase';
import type { ParsedEntitiesHints, ProposedActionDraft } from '../types/chat';

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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
  pods: Array<{ id: Uuid; name: string }>;
}): {
  assistantText: string;
  proposedActionDrafts: ProposedActionDraft[];
  entities: ParsedEntitiesHints;
} {
  const messageText = (opts.messageText ?? '').trim();
  const pods = opts.pods;
  const podNames = pods.map((p) => p.name);

  // 1) moved $X from A to B
  {
    const m = messageText.match(
      /^\s*moved\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+from\s+(.+?)\s+to\s+(.+?)\s*$/i,
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

