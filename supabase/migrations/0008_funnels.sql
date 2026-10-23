-- ─────────────────────────────────────────────────────────────
-- Fase 05 — Funil: captura e análise de páginas.
-- funnels: um funil por página de destino (anunciante/anúncio) ou
--          por página informada manualmente (modo 'pagina').
-- funnel_steps: passos seguidos (pré-sell → ... → checkout), em ordem.
-- RLS: leitura só para o dono da investigação; o worker grava via service role.
-- Screenshots/HTML/texto ficam no bucket privado `creatives`, sob a pasta
-- <investigation_id>/... (a policy de storage já existente cobre isso).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.funnels (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  candidate_id      uuid references public.candidates(id) on delete set null,
  ad_id             uuid references public.ads(id) on delete set null,
  entry_url         text not null,
  domain            text,
  status            text not null default 'pendente',
  checkout_platform text,
  video_player      text,
  pixels            jsonb not null default '[]'::jsonb,
  manifests         jsonb not null default '[]'::jsonb,
  tech              jsonb,
  blocked           boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists funnels_inv_idx on public.funnels (investigation_id);
create index if not exists funnels_cand_idx on public.funnels (candidate_id);

create table if not exists public.funnel_steps (
  id                uuid primary key default gen_random_uuid(),
  funnel_id         uuid not null references public.funnels(id) on delete cascade,
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  step_order        integer not null default 0,
  step_type         text,
  url               text,
  screenshot_path   text,
  html_path         text,
  text_path         text,
  requests          jsonb not null default '[]'::jsonb,
  analysis          jsonb,
  blocked           boolean not null default false,
  load_ms           integer,
  created_at        timestamptz not null default now()
);
create index if not exists funnel_steps_funnel_idx on public.funnel_steps (funnel_id, step_order);
create index if not exists funnel_steps_inv_idx on public.funnel_steps (investigation_id);

-- RLS: dono da investigação lê; escrita é do worker (service role ignora RLS).
alter table public.funnels      enable row level security;
alter table public.funnel_steps enable row level security;

drop policy if exists funnels_read on public.funnels;
create policy funnels_read on public.funnels
  for select to authenticated
  using (public.owns_investigation(investigation_id));

drop policy if exists funnel_steps_read on public.funnel_steps;
create policy funnel_steps_read on public.funnel_steps
  for select to authenticated
  using (public.owns_investigation(investigation_id));
