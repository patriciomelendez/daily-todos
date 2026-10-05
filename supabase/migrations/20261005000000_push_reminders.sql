-- Push reminders: subscriptions, dedupe log, and the "what's due" lookup.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own subs select" on public.push_subscriptions;
drop policy if exists "own subs insert" on public.push_subscriptions;
drop policy if exists "own subs update" on public.push_subscriptions;
drop policy if exists "own subs delete" on public.push_subscriptions;
create policy "own subs select" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "own subs insert" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "own subs update" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own subs delete" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Server-only: RLS on with no policies, so clients can't touch it.
create table if not exists public.sent_reminders (
  item_id uuid not null references public.items(id) on delete cascade,
  remind_at timestamptz not null,
  primary key (item_id, remind_at)
);
alter table public.sent_reminders enable row level security;

-- Reminders whose moment fell in the last 2 minutes and haven't been sent.
create or replace function public.due_reminders()
returns table (item_id uuid, user_id uuid, title text, start_time time, location text, remind int, remind_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.user_id, i.title, i.start_time, i.location, i.remind,
         ((i.date + i.start_time) at time zone 'America/Toronto') - make_interval(mins => i.remind) as remind_at
  from items i
  where not i.done and i.start_time is not null and i.remind > 0
    and ((i.date + i.start_time) at time zone 'America/Toronto') - make_interval(mins => i.remind)
        between now() - interval '2 minutes' and now()
    and not exists (
      select 1 from sent_reminders s
      where s.item_id = i.id
        and s.remind_at = ((i.date + i.start_time) at time zone 'America/Toronto') - make_interval(mins => i.remind)
    );
$$;
revoke all on function public.due_reminders() from public, anon, authenticated;
grant execute on function public.due_reminders() to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;
