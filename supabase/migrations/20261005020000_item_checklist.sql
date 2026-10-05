-- Checklist inside an item (e.g. a shopping list): [{"text": "...", "done": false}, ...]
alter table public.items add column if not exists checklist jsonb not null default '[]'::jsonb;
