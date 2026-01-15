-- Enable RLS and add read policies for chat + audit tables.

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.proposed_actions enable row level security;
alter table public.budget_events enable row level security;

drop policy if exists "Chat threads are readable by household members"
  on public.chat_threads;
create policy "Chat threads are readable by household members"
  on public.chat_threads
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.household_members
      where household_members.household_id = chat_threads.household_id
        and household_members.user_id = auth.uid()
    )
  );

drop policy if exists "Chat messages are readable by household members"
  on public.chat_messages;
create policy "Chat messages are readable by household members"
  on public.chat_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.chat_threads
      join public.household_members
        on household_members.household_id = chat_threads.household_id
      where chat_threads.id = chat_messages.thread_id
        and household_members.user_id = auth.uid()
    )
  );

drop policy if exists "Proposed actions are readable by household members"
  on public.proposed_actions;
create policy "Proposed actions are readable by household members"
  on public.proposed_actions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.household_members
      where household_members.household_id = proposed_actions.household_id
        and household_members.user_id = auth.uid()
    )
  );

drop policy if exists "Budget events are readable by household members"
  on public.budget_events;
create policy "Budget events are readable by household members"
  on public.budget_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.household_members
      where household_members.household_id = budget_events.household_id
        and household_members.user_id = auth.uid()
    )
  );
