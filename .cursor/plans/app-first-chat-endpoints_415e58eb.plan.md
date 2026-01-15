---
name: app-first-chat-endpoints
overview: Add two authenticated app-first endpoints for parsing chat messages into deterministic proposed actions, storing them, and applying selected actions with budget event logging, plus Supabase schema updates and README guidance.
todos:
  - id: types-parser
    content: Add ProposedAction types and deterministic parser module
    status: completed
  - id: repos-db
    content: Create repos for chat/proposed_actions + SQL migrations
    status: completed
  - id: handlers
    content: Implement chat message + apply actions handlers
    status: completed
  - id: docs
    content: Update README with migration/apply steps
    status: completed
---

# App-First API Endpoints Plan

## Scope

Implement `POST /api/chat/message` and `POST /api/actions/apply` using the existing entrypoint, with handlers in `src/handlers/`, Supabase server auth, and household membership checks. Add Supabase tables `chat_threads`, `chat_messages`, `proposed_actions`, and `budget_events` with SQL migrations stored under `supabase/migrations/` and documented in README.

## Implementation Steps

- **Define domain types**
- Add `ProposedAction` (id, type, payload, status) to a shared types file (likely `src/types.ts` or a new `src/types/chat.ts`) alongside request/response shapes for both endpoints. Ensure payload is typed per action type (transfer, shortfall, rent_due).

- **Deterministic parser + action proposal**
- Implement a simple parser module under `src/chat/` (new folder) that uses regex to parse:
- `moved $X from A to B`
- `X is short $Y`
- `rent due soon`
- Map parse results to `ProposedAction[]` and `assistantText` with deterministic phrasing. Keep this module pure (no DB calls).

- **Supabase persistence layer**
- Add repo helpers under `src/repos/` for:
- `chat_threads` lookup/create by household (unique `household_id`)
- `chat_messages` insert (user + assistant messages)
- `proposed_actions` insert (linked to assistant message, with `applied_at`/`applied_by`)
- `budget_events` insert (append-only history per applied action)
- Reuse existing `verifyUser` (`src/auth/verifyUser.ts`) and `assertUserInHousehold` (`src/repos/householdsRepo.ts`) in handlers.

- **Endpoints and handlers**
- Add handlers under `src/handlers/` (new files like `chatMessageHandler.ts`, `applyActionsHandler.ts`) and wire into the existing entrypoint (same place `handleSequenceRemoteApi` is exported/used). Behavior:
- `POST /api/chat/message`: verify auth, check membership, parse message, run envelope/routing math (use `computeDepositPlan` where applicable), store assistant message + proposed actions, return `{ assistantText, proposedActions, entities }` (entities include candidates for clarifications).
- `POST /api/actions/apply`: verify auth, check membership, load proposed actions by `actionIds`, apply to `pod_settings.budgeted_amount_in_cents`, insert `budget_events`, mark actions applied, return UI snapshot: `pods: [{ id, name, balance_amount_in_cents, budgeted_amount_in_cents, category }] `(+ optional `left_to_budget` if computed).

- **Database migrations + README**
- Add SQL migrations under `supabase/migrations/` for tables:
- `chat_threads` (id, household_id unique, created_at)
- `chat_messages` (id, thread_id, sender_role, text, created_at)
- `proposed_actions` (id, message_id, type, payload_json, status, applied_at, applied_by, created_at)
- `budget_events` (id, household_id, actor_user_id, type, payload, created_at)
- Update `README.md` with instructions on applying migrations and any required env vars.

## Touchpoints

- Entry point: existing api/entrypoint (wire new handlers)
- Handlers: `src/handlers/` (chat/apply)
- Chat logic: `src/chat/` (parser + proposal builder)
- Repos: `src/repos/` (chat/proposed_actions/budget_events CRUD)
- Types: `src/types.ts` or `src/types/chat.ts`
- Supabase SQL: new migration file(s) under `supabase/migrations/` (and README guidance)

## Notes / Assumptions

- Apply actions will **only** update `pod_settings.budgeted_amount_in_cents` for now (no override table).
- Proposed actions are stored and linked to the assistant message (not the user message) with applied metadata.