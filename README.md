# Sequence Savings Sentinel

No-UI savings trend sentinel that emails **GREEN / YELLOW / RED** based on whether your configured savings total is growing over a lookback window. It uses balances-only data from Sequence and persists state in a private GitHub Gist.

## What this repo is now
This repository is a deterministic envelope engine plus routing math. It focuses on the pure calculations for envelope floors, issue detection, fix plans, and deposit routing. The Supabase-backed API layer and Flutter app integration come next.

## What it does
- Fetches balances from Sequence (`POST https://api.getsequence.io/accounts` with `x-sequence-access-token: Bearer <token>`).
- Computes a **Savings Total** from a configured allow-list of account/pod names.
- Writes a daily snapshot to a **private GitHub Gist** (`state.json`).
- Classifies trend over `lookbackDays` as:
  - GREEN: up meaningfully
  - YELLOW: flat, down-but-not-catastrophic, missing data, or baseline
  - RED: down more than the configured threshold
- Sends an email every time it runs (cadence controlled by GitHub Actions cron).

## Setup

### 1) Create the private Gist
Create a private Gist containing a file named `state.json`.

You can leave it empty, or initialize it with:

```json
{ "version": 1, "snapshots": [], "lastAlert": null }
```

Save the Gist ID (the long hex-ish id in the URL).

### 2) Create a GitHub token for the Gist
Create a token that can read/write that Gist.

- Classic PAT: `gist` scope
- Fine-grained token: permissions to manage your gists

### 3) Configure savings account names
Edit `src/config.ts`:
- `classification.savingsNames`: the allow-list of savings accounts/pods you want to track
- thresholds/cadence/alerts as desired

### 4) Environment variables
This repo includes `env.example` (the environment blocks `.env.example` creation here). Copy it to `.env` for local runs, or set the same keys as GitHub secrets.

Required keys:
- `SEQ_TOKEN`
- `GIST_ID`, `GIST_TOKEN`, optional `GIST_FILENAME` (defaults to `state.json`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `EMAIL_FROM`, `EMAIL_TO`

Supabase (server-side API layer):
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (server-only; never expose to clients)

AI (optional, proposals-only; never applies changes):
- `AI_ENABLED` set to `true` to enable AI proposals for `POST /api/chat/message` (fails closed to deterministic parsing on any error).
- `OPENAI_API_KEY` OpenAI API key for server-side calls (do not expose to clients).

Quick sanity script (pods for a user across their household(s)):

```bash
npm run build
USER_ID="<uuid>" SUPABASE_URL="<url>" SUPABASE_SECRET_KEY="<secret_key>" node dist/scripts/testSupabasePods.js
```

## App-first Chat API (Phase 1)

This repo includes two minimal, app-first endpoints (no AI) implemented as Vercel-style functions:

- `POST /api/chat/message` (`api/chat/message.ts`)
- `POST /api/actions/apply` (`api/actions/apply.ts`)

Both endpoints require:

- Header: `Authorization: Bearer <Supabase JWT>`
- The authenticated user must be a member of the provided `householdId`.

### Database migrations

Apply the SQL migration in `supabase/migrations/20260115000000_chat_budget_events.sql` (via Supabase SQL editor or your migration tooling). It creates:

- `chat_threads` (one per household; `household_id` is unique)
- `chat_messages` (user/assistant messages per thread)
- `proposed_actions` (stored proposals linked to the assistant message; includes applied metadata)
- `budget_events` (append-only history for applied actions)

### `POST /api/chat/message`

Request body:

```json
{ "householdId": "<uuid>", "messageText": "moved $80 from Groceries to Education" }
```

Response body:

```json
{
  "apiVersion": "2026-01-16",
  "traceId": "<uuid>",
  "aiUsed": false,
  "warnings": [],
  "assistantText": "…",
  "proposedActions": [{ "id": "<uuid>", "type": "budget_transfer", "payload": { "kind": "budget_transfer", "...": "..." }, "status": "proposed" }],
  "entities": { "fromCandidate": "…", "toCandidate": "…", "candidates": ["…"] }
}
```

Transfer intent rules:

- **Observed transfers** (already happened): “I moved…”, “I transferred…”, “I had to move…”.
  - Logs a `budget_events` entry with type `observed_transfer`.
  - Proposes a repair action (`budget_repair_restore_donor`) to restore the donor budget.
  - Uses `Move to ___` as the default funding pod (fallback: `Safety Net`).
- **Requested transfers** (future/imperative): “Move…”, “I need to move…”, “Can you move…”.
  - Proposes a `budget_transfer` action (no observed event).

Observed transfer response example:

```json
{
  "assistantText": "Got it — logged that transfer. Here’s the cleanest way to repair your budget plan.",
  "proposedActions": [
    {
      "id": "<uuid>",
      "type": "budget_repair_restore_donor",
      "payload": {
        "kind": "budget_repair_restore_donor",
        "amount_in_cents": 8000,
        "donor_pod_id": "<uuid>",
        "donor_pod_name": "Groceries",
        "funding_pod_id": "<uuid>",
        "funding_pod_name": "Move to ___"
      },
      "status": "proposed"
    }
  ],
  "entities": {
    "fromCandidate": "Groceries",
    "toCandidate": "Education",
    "fundingCandidate": "Move to ___",
    "candidates": ["Groceries", "Education", "Move to ___"]
  }
}
```

### `POST /api/actions/apply`

Request body:

```json
{ "householdId": "<uuid>", "actionIds": ["<uuid>", "<uuid>"] }
```

Response body (UI snapshot):

```json
{
  "pods": [
    {
      "id": "<uuid>",
      "name": "Groceries",
      "balance_amount_in_cents": 12345,
      "budgeted_amount_in_cents": 20000,
      "category": "Necessities"
    }
  ]
}
```

## GitHub Actions deployment
Add repository secrets with the env vars above, then enable the workflow in `.github/workflows/sentinel.yml`.

Note: the sentinel uses **UTC dates** (`YYYY-MM-DD`) for snapshots (same as GitHub Actions).

## Local run
After installing dependencies:

```bash
npm install
npm run build
node dist/index.js
```

## Fixit (Gmail poller + rules engine)

This repo now supports an email-first “Fixit” loop backed by Turso (SQLite/libSQL):
- Gmail API polling (label-based)
- Deterministic envelope engine (floors + due funding)
- Plans labeled as Restore / Routing / Structural
- `APPLY A/B/C` replies that store routing overrides and/or rule changes

### Seed rules + routing baselines

Edit the example seed files:
- `seed/envelopeRules.example.json`
- `seed/routingBaselines.example.json`

Then run:

```bash
npm run seed
```

### Sync budgets from Google Sheet CSVs

1) Export `expenses.csv` + `income.csv` from the Google Sheet and copy them into `data/`.
2) (Optional) Adjust `seed/envelopeOverrides.json` or set `BUDGET_OVERRIDES_PATH`.
3) Run:

```bash
npm run budget:sync
```

4) Verify the audit output totals + diffs, then run Fixit:

```bash
npm run fixit:dev
```

### Run the Fixit worker

Set the env vars in `env.example` (especially Turso + Gmail OAuth2), then run:

```bash
npm run fixit:dev
```

This is intended to run on an always-on worker (e.g. a small DigitalOcean droplet). The weekly savings sentinel can continue to run via GitHub Actions.

### Manual checklist
- Observed transfer: “I moved $80 from Groceries to Education” → log observed event + propose repair from `Move to ___`.
- Transfer request: “Move $80 from Groceries to Education” → propose `budget_transfer`.

## Sequence Remote API (deposit routing)

For Sequence “Remote API Action” amount lookup, deploy the `api/sequence-routing.ts` endpoint (Vercel recommended).

You’ll configure one remote amount URL per transfer action, passing the destination pod name as a query param:

- `.../api/sequence-routing?pod=Car%20Payment`
- `.../api/sequence-routing?pod=Education`

The endpoint returns `{ "amountInCents": <number> }` for that pod based on baseline bps + active overrides (with remainder flowing to `Move to ___`).

You can protect the endpoint by setting `SEQUENCE_REMOTE_API_SHARED_SECRET` and sending:
- Header: `x-sequence-signature: Bearer <secret>`

### Dry run mode
Set `ROUTING_DRY_RUN=1` (or `true` / `yes`) to return the computed plan without mutating overrides. Example response:

```json
{
  "dryRun": true,
  "plan": {
    "depositAmountDollars": 2500,
    "lines": [
      { "podName": "Car Payment", "bps": 1200, "amountDollars": 300 },
      { "podName": "Move to ___", "bps": 8800, "amountDollars": 2200 }
    ],
    "catchAllPodName": "Move to ___",
    "warnings": []
  },
  "notes": [
    "idempotencyKey=present",
    "Overrides with remainingDeposits: [{\"id\":\"ovr_123\",\"podName\":\"Car Payment\",\"remainingDeposits\":2,\"expiresOn\":null}]"
  ]
}
```


