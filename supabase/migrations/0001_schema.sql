-- ─────────────────────────────────────────────────────────────
-- Espião de Ofertas Escaladas — schema inicial
-- ─────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Status de job/etapa.
do $$ begin
  create type job_status as enum ('pendente', 'rodando', 'concluida', 'falhou');
exception when duplicate_object then null; end $$;

do $$ begin
  create type evidence_level as enum ('alto', 'medio', 'baixo');
exception when duplicate_object then null; end $$;

-- ── investigations ───────────────────────────────────────────
create table if not exists public.investigations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  query              text not null,
  country            text not null default 'BR',
  competitors        integer not null default 5,
  only_active        boolean not null default true,
  status             job_status not null default 'pendente',
  estimated_cost_usd numeric(10,4) not null default 0,
  final_cost_usd     numeric(10,4),
  notice             text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── jobs (fila via Postgres) ─────────────────────────────────
create table if not exists public.jobs (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  status            job_status not null default 'pendente',
  current_step      text,
  -- Etapas já concluídas, para o "refazer etapa" não repetir trabalho.
  completed_steps   text[] not null default '{}',
  attempts          integer not null default 0,
  max_attempts      integer not null default 3,
  run_after         timestamptz not null default now(),
  locked_at         timestamptz,
  locked_by         text,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists jobs_pickup_idx
  on public.jobs (status, run_after)
  where status in ('pendente', 'falhou');

-- ── job_events (log por etapa) ───────────────────────────────
create table if not exists public.job_events (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  step              text not null,
  status            job_status not null,
  message           text,
  meta              jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists job_events_inv_idx on public.job_events (investigation_id, created_at);

-- ── candidates ───────────────────────────────────────────────
create table if not exists public.candidates (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  name              text not null,
  domain            text,
  facebook_page     text,
  offer_type        text,
  source            text,
  score             numeric(8,2) not null default 0,
  evidence_level    evidence_level,
  reasons           jsonb not null default '[]'::jsonb,
  evidence          jsonb,
  selected          boolean not null default false,
  selection_reason  text,
  -- Preenchidos na etapa de consolidação:
  summary           text,
  hook_patterns     jsonb not null default '[]'::jsonb,
  angle_patterns    jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists candidates_inv_idx on public.candidates (investigation_id);

-- ── ads ──────────────────────────────────────────────────────
create table if not exists public.ads (
  id                uuid primary key default gen_random_uuid(),
  candidate_id      uuid not null references public.candidates(id) on delete cascade,
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  ad_archive_id     text,
  page_name         text,
  body_text         text,
  title             text,
  cta_text          text,
  cta_type          text,
  link_url          text,
  start_date        timestamptz,
  end_date          timestamptz,
  is_active         boolean not null default false,
  platforms         text[] not null default '{}',
  countries         text[] not null default '{}',
  variations        integer not null default 0,
  images            jsonb not null default '[]'::jsonb,
  videos            jsonb not null default '[]'::jsonb,
  is_champion       boolean not null default false,
  raw               jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists ads_candidate_idx on public.ads (candidate_id);
create index if not exists ads_inv_idx on public.ads (investigation_id);

-- ── creatives (mídia, transcrição, análise) ──────────────────
create table if not exists public.creatives (
  id                     uuid primary key default gen_random_uuid(),
  ad_id                  uuid not null references public.ads(id) on delete cascade,
  candidate_id           uuid not null references public.candidates(id) on delete cascade,
  investigation_id       uuid not null references public.investigations(id) on delete cascade,
  media_type             text not null check (media_type in ('image', 'video')),
  source_url             text,
  storage_path           text,
  preview_path           text,
  transcription          text,
  transcription_provider text,
  analysis               jsonb,
  duration_seconds       numeric(10,2),
  status                 text not null default 'pendente',
  error                  text,
  created_at             timestamptz not null default now()
);
create index if not exists creatives_candidate_idx on public.creatives (candidate_id);
create index if not exists creatives_inv_idx on public.creatives (investigation_id);

-- ── cost_log ─────────────────────────────────────────────────
create table if not exists public.cost_log (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references public.investigations(id) on delete cascade,
  provider          text not null,
  unit              text not null,
  quantity          numeric(12,4) not null default 0,
  estimated_usd     numeric(12,6) not null default 0,
  note              text,
  created_at        timestamptz not null default now()
);
create index if not exists cost_log_inv_idx on public.cost_log (investigation_id);

-- ── updated_at automático ────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_investigations_touch on public.investigations;
create trigger trg_investigations_touch before update on public.investigations
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_jobs_touch on public.jobs;
create trigger trg_jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ── Storage bucket para mídias (privado) ─────────────────────
insert into storage.buckets (id, name, public)
values ('creatives', 'creatives', false)
on conflict (id) do nothing;
