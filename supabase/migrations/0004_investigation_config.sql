-- ─────────────────────────────────────────────────────────────
-- Config por investigação (formulário "Opções avançadas").
-- Guarda os overrides de escopo/custo escolhidos na criação:
--   { candidates, adsPerCandidate, maxVideos, maxTranscriptionMinutes }
-- Campos ausentes fazem o worker cair nos padrões de DEFAULT_LIMITS.
-- ─────────────────────────────────────────────────────────────

alter table public.investigations
  add column if not exists config jsonb not null default '{}'::jsonb;
