create table if not exists public.app_state (
  id text primary key check (id = 'main'),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

revoke all on table public.app_state from public, anon, authenticated;
grant all on table public.app_state to service_role;

comment on table public.app_state is
  'Estado persistente do Make Money; contem contas, sessoes, pagamentos e configuracoes Pix.';
