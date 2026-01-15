---
name: supabase-access-layer
overview: Introduce a Supabase server-side client, auth verification helper, repo layer for households/pods/pod_settings, and document env vars, plus a small script scaffold to exercise the repos.
todos: []
---

# Supabase access layer plan

## Files to add

- Create `[src/supabase/serverClient.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/supabase/serverClient.ts) `to initialize a Supabase client with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only).
- Create `[src/auth/verifyUser.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/auth/verifyUser.ts) `to parse the `Authorization` header, call `supabase.auth.getUser(token)`, and return `{ userId, email }`.
- Create `[src/repos/householdsRepo.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/repos/householdsRepo.ts)`, `[src/repos/podsRepo.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/repos/podsRepo.ts)`, and `[src/repos/podSettingsRepo.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/repos/podSettingsRepo.ts)` with typed queries:
- `household_members` lookup by `user_id` → `household_id` list.
- `pods` by `household_id` (optionally `is_active = true`).
- `pod_settings` by `pod_id`, and a helper that left-joins pods with settings via Supabase `select` or two-query merge.
- Add types under `[src/types](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/types) `(new folder) for `Household`, `HouseholdMember`, `Pod`, `PodSettings`, and combined shapes used by repos.
- Add a small script `[src/scripts/testSupabasePods.ts](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/src/scripts/testSupabasePods.ts) `that uses the repos to fetch pods for a provided `USER_ID` and logs shape only (no real token required).

## Updates

- Update `[env.example](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/env.example) `with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and short usage notes for server-only use.
- Update `[README.md](/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny-pop-backend/README.md)` with Supabase env setup and a note on the new test script.

## Implementation notes

- Use service role key only in `serverClient.ts` and ensure it is not referenced from any client code paths.
- Repo functions should return typed data and surface Supabase errors with useful context.
- For pods + settings, use `select('*, pod_settings(*)')` with a left join if supported; otherwise perform two queries and merge by `pod.id`.

## Tests/verification

- Run the new script locally with a dummy `USER_ID` and confirm it returns an empty array or structured results without throwing.
- Ensure TypeScript build passes with the new types and imports.

## Todos

- [ ] Add Supabase server client and auth verify helper
- [ ] Implement repo queries with types for households/pods/settings
- [ ] Add test script and document env vars/usage