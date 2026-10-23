-- ─────────────────────────────────────────────────────────────
-- Fase 07 — VSL: status por sub-etapa.
-- Guarda o resultado de cada sub-etapa do processamento da VSL
-- (download, áudio, transcrição, mapeamento), cada uma com ok/falhou + motivo.
-- A tela usa isso para distinguir "Concluída", "Concluída com problemas" e "Falhou".
-- ─────────────────────────────────────────────────────────────

alter table public.vsls
  add column if not exists substeps jsonb not null default '[]'::jsonb;

comment on column public.vsls.substeps is
  'Lista [{etapa, ok, motivo}] por sub-etapa (download, audio, transcricao, mapeamento).';
