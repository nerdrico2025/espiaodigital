-- ─────────────────────────────────────────────────────────────
-- Métricas de avaliação por candidato (seção "Candidatos avaliados").
-- Guarda o que a tela/export precisam para explicar por que cada
-- candidato foi ou não selecionado, mesmo com 0 selecionados:
--   { adsCollected, noOwnAds, adsPerCandidateLimit,
--     daysLive, distinctPlatforms, maxVariations,
--     distinctCountries, hasVideo, hasActionCta }
-- ─────────────────────────────────────────────────────────────

alter table public.candidates
  add column if not exists metrics jsonb not null default '{}'::jsonb;
