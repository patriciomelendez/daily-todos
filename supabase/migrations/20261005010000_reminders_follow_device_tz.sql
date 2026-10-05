-- Reminders follow the time zone the phone last reported (falls back to Toronto).

alter table public.push_subscriptions add column if not exists tz text not null default 'America/Toronto';
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();

create or replace function public.due_reminders()
returns table (item_id uuid, user_id uuid, title text, start_time time, location text, remind int, remind_at timestamptz)
language sql stable security definer set search_path = public as $$
  with due as (
    select i.*,
           ((i.date + i.start_time) at time zone z.tz) - make_interval(mins => i.remind) as at
    from items i
    cross join lateral (
      select coalesce(
        (select n.name from push_subscriptions p join pg_timezone_names n on n.name = p.tz
         where p.user_id = i.user_id order by p.updated_at desc limit 1),
        'America/Toronto') as tz
    ) z
    where not i.done and i.start_time is not null and i.remind > 0
  )
  select d.id, d.user_id, d.title, d.start_time, d.location, d.remind, d.at
  from due d
  where d.at between now() - interval '2 minutes' and now()
    and not exists (select 1 from sent_reminders s where s.item_id = d.id and s.remind_at = d.at);
$$;
revoke all on function public.due_reminders() from public, anon, authenticated;
grant execute on function public.due_reminders() to service_role;
