-- ─────────────────────────────────────────────────────────────
-- Modo da investigação:
--   'concorrentes' (padrão) — descobre concorrentes da referência.
--   'anunciante'            — analisa só a empresa informada (sem descoberta).
-- ─────────────────────────────────────────────────────────────

alter table public.investigations
  add column if not exists mode text not null default 'concorrentes';
