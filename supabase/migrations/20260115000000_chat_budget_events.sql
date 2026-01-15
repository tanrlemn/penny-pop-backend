-- Chat threads/messages + proposed actions + budget events (Phase 1 app-first chat)

create extension if not exists pgcrypto;

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (household_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_role text not null check (sender_role in ('user', 'assistant')),
  sender_user_id uuid null references auth.users(id),
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_created_at_idx
  on public.chat_messages(thread_id, created_at);

create table if not exists public.proposed_actions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  type text not null,
  payload_json jsonb not null,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'ignored', 'failed')),
  applied_at timestamptz null,
  applied_by uuid null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists proposed_actions_household_status_idx
  on public.proposed_actions(household_id, status, created_at);

create index if not exists proposed_actions_message_idx
  on public.proposed_actions(message_id);

create table if not exists public.budget_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  actor_user_id uuid null references auth.users(id),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists budget_events_household_created_at_idx
  on public.budget_events(household_id, created_at);

