-- ─────────────────────────────────────────────────────────────
-- Fase 06 — VSL: download, transcrição e mapeamento.
-- Uma linha por VSL processada, ligada ao passo de funil e à investigação.
-- Mídia (áudio/vídeo) no bucket privado `creatives`, pasta <investigation_id>/...
-- RLS: leitura só para o dono da investigação; worker grava via service role.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.vsls (
  id                   uuid primary key default gen_random_uuid(),
  investigation_id     uuid not null references public.investigations(id) on delete cascade,
  funnel_id            uuid references public.funnels(id) on delete set null,
  funnel_step_id       uuid references public.funnel_steps(id) on delete set null,
  source_url           text,
  player               text,
  manifest_url         text,
  duration_seconds     numeric(10,2),
  status               text not null default 'pendente',
  fail_reason          text,
  audio_path           text,
  video_path           text,
  video_bytes          bigint,
  transcription        text,
  segments             jsonb not null default '[]'::jsonb,
  approx_timestamps    boolean not null default false,
  partial              boolean not null default false,
  missing_chunks       jsonb not null default '[]'::jsonb,
  transcription_provider text,
  analysis             jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists vsls_inv_idx on public.vsls (investigation_id);
create index if not exists vsls_funnel_idx on public.vsls (funnel_id);

alter table public.vsls enable row level security;

drop policy if exists vsls_read on public.vsls;
create policy vsls_read on public.vsls
  for select to authenticated
  using (public.owns_investigation(investigation_id));
