import { EnvelopeRule } from "../envelopes/types";
import { computeDepositPlan } from "./computeDepositPlan";
import { RoutingBaseline, RoutingOverride } from "./types";

function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string | null {
  const v = headers[key.toLowerCase()] ?? headers[key] ?? null;
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

function parseDepositAmountCents(body: any): number | null {
  const candidates = [
    body?.depositAmountInCents,
    body?.deposit_amount_in_cents,
    body?.depositAmountCents,
    body?.deposit_amount_cents,
    body?.amountInCents, // sometimes called that in docs (but ambiguous)
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return Math.round(c);
    if (typeof c === "string" && c.trim() && Number.isFinite(Number(c))) return Math.round(Number(c));
  }
  return null;
}

function parseDepositAmountCentsFromQuery(query: Record<string, any>): number | null {
  const candidates = [query.depositAmountInCents, query.deposit_amount_in_cents, query.depositAmountCents, query.amountInCents];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return Math.round(c);
    if (typeof c === "string" && c.trim() && Number.isFinite(Number(c))) return Math.round(Number(c));
  }
  return null;
}

function centsFromDollars(d: number) {
  return Math.round(d * 100);
}

export type RemoteApiHandlerResult = { status: number; json: any };

export async function handleSequenceRemoteApi(opts: {
  method: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
  baselines: RoutingBaseline[];
  overrides: RoutingOverride[];
  envelopeRules: EnvelopeRule[];
  catchAllPodName: string;
  maxAdjustmentPerDepositDollars?: number;
  sharedSecret?: string;
  depositAmountAssumptionDollars?: number;
}): Promise<RemoteApiHandlerResult> {
  if (opts.method !== "POST") return { status: 405, json: { error: "Method not allowed" } };

  if (opts.sharedSecret) {
    const sig = getHeader(opts.headers, "x-sequence-signature");
    if (sig !== `Bearer ${opts.sharedSecret}`) {
      return { status: 401, json: { error: "Unauthorized" } };
    }
  }

  const podName = (opts.query.pod ?? opts.query.podName ?? opts.body?.podName ?? null) as string | null;
  if (!podName || typeof podName !== "string") {
    // This handler is intended to be used per-action with a pod query param.
    return { status: 400, json: { error: "Missing pod name (use ?pod=PodName)" } };
  }

  const depositAmountCents = parseDepositAmountCents(opts.body) ?? parseDepositAmountCentsFromQuery(opts.query);
  const depositAmountDollars =
    depositAmountCents != null
      ? depositAmountCents / 100
      : opts.depositAmountAssumptionDollars;
  if (depositAmountDollars == null || !Number.isFinite(depositAmountDollars)) {
    return { status: 400, json: { error: "Missing deposit amount" } };
  }

  const { plan } = computeDepositPlan({
    depositAmountDollars,
    baselines: opts.baselines,
    overrides: opts.overrides,
    envelopeRules: opts.envelopeRules,
    catchAllPodName: opts.catchAllPodName,
    maxAdjustmentPerDepositDollars: opts.maxAdjustmentPerDepositDollars ?? 200,
  });

  const line = plan.lines.find((l) => l.podName === podName);
  const amountDollars = line?.amountDollars ?? 0;
  const amountInCents = centsFromDollars(amountDollars);
  return { status: 200, json: { amountInCents } };
}

