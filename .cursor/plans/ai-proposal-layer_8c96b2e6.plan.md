---
name: ai-proposal-layer
overview: Add a schema-validated AI proposal path with strict fallback and consistent response metadata, plus rate limiting, message length guard, and minimal tests.
todos:
  - id: ai-core
    content: Add OpenAI client, schema, and generateActions orchestrator.
    status: completed
  - id: handler-integration
    content: Wire AI fallback, apiVersion/traceId, warnings, logging, limits.
    status: completed
  - id: types-docs
    content: Update response types, README env vars, config limits.
    status: completed
  - id: tests
    content: Add Vitest setup and minimal AI fallback/schema tests.
    status: completed
---

# AI Proposal Layer Plan

## Key changes and locations

- Add OpenAI wrapper, schema, and orchestrator in [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/client.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/client.ts)(), [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/schema.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/schema.ts)(), [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/generateActions.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/generateActions.ts)().
- Integrate AI-first fallback logic, traceId, warnings, and logging in [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/handlers/chatMessageHandler.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/handlers/chatMessageHandler.ts)(), and add apiVersion/traceId to apply responses in [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/handlers/applyActionsHandler.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/handlers/applyActionsHandler.ts)().
- Extend response types in [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/types/chat.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/types/chat.ts)().
- Add shared `apiVersion` constant (e.g. new [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/http/version.ts`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/http/version.ts)()) and wire into both handlers.
- Update env docs in [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/README.md`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/README.md)().
- Add minimal test harness (Vitest) and tests under [`/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/__tests__`](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/ai/__tests__)().

## Implementation details

- **OpenAI client**: build a `Responses API` call with timeout (8–12s) and one retry on network/5xx; skip when `OPENAI_API_KEY` missing. Ensure no key is logged. Use `AI_ENABLED === "true"` gate before calling.
- **Schema**: Zod schema enforcing:
- `assistantText` string.
- `proposedActionDrafts` array max 3; each `type` is only `budget_transfer` or `budget_repair_restore_donor`.
- Payloads match existing `ProposedActionPayload` kinds (no new shapes).
- `amount_in_cents > 0`.
- Pod IDs must exist in supplied pod list (validation step in orchestrator).
- Optional `confidence` (0..1) and `reason`.
- Optional `entities` with `fromCandidate`, `toCandidate`, `fundingCandidate` (nullable/undefined). No extra keys.
- **Orchestrator**: `generateActions` takes `messageText` and pod snapshots including budget + optional balance fields. If message length > 500, return `ok:false` with warning and let handler fall back. Build prompt with pods list + freshness hints; instruct `Return ONLY valid JSON. No extra keys.` Parse JSON, validate, normalize to `ProposedActionDraft[]`, and return `{ ok:true, assistantText, drafts, entities, warnings, aiUsed:true }` or `{ ok:false, error, warnings }`.
- **Handler integration**:
- Enforce message length server-side at 500 (return 400 or 413 per requirement; use 413 for “too large”).
- Rate limit: use existing in-memory rate limiter with new config window (5 min) + max (30). Return `{ error, code:"RATE_LIMITED", traceId }` for 429. Keep other errors structured as `{ error, code, traceId }`.
- Add `traceId` generation; include in success + errors.
- AI flow: if `AI_ENABLED === "true"` and key present, attempt AI; on any failure/timeout/invalid schema, append warning and fallback to `interpretMessage`.
- Preserve the current persistence flow: insert chat messages, insert proposed actions, observed_transfer logging/dedup unchanged.
- Response shape: `{ apiVersion, traceId, aiUsed, warnings, assistantText, proposedActions, entities }`.
- Single-line log per request: traceId, aiUsed, duration, action count, warning codes.
- **Apply endpoint**: add `apiVersion` + `traceId` to both success and error responses; do not modify apply logic.
- **Config**: update `MAX_MESSAGE_CHARS` to 500 and `RATE_LIMIT_WINDOW_MS` to 5 minutes; keep `RATE_LIMIT_MAX` 30.
- **Tests** (Vitest):
- `schema` rejects invalid outputs (bad types, too many actions, invalid pod ids, amount <= 0).
- `generateActions` returns `ok:false` on missing key / non-JSON.
- `handleChatMessage` falls back when AI disabled.
- `handleChatMessage` falls back when AI throws timeout.

## Notes on current code

- `chatMessageHandler` already uses `checkRateLimit`, `makeTraceId`, and returns `apiVersion: 'v1'` — this will be replaced with a shared `apiVersion` constant and the required response fields.
- `generateProposals` currently wraps `interpretMessage` with a timeout; it will be replaced/augmented by the new AI orchestrator.