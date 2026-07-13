create table if not exists public.game_archives (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  title text not null,
  archived_at timestamptz not null default now(),
  mode_state jsonb not null,
  team_data jsonb not null,
  evidence_summary jsonb not null default '{}'::jsonb,
  created_by text not null default 'admin-reset'
);

create index if not exists game_archives_archived_at_idx
  on public.game_archives (archived_at desc);

alter table public.game_archives enable row level security;

-- The app accesses this table only from Vercel server functions with a server key.
-- No public anon policy is intentionally created.
