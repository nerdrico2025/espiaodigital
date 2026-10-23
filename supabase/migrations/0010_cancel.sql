-- ─────────────────────────────────────────────────────────────
-- Cancelamento de investigação.
-- Adiciona o valor 'cancelada' ao enum job_status (usado por
-- investigations.status e jobs.status).
-- OBS: ALTER TYPE ... ADD VALUE não roda dentro de transação em algumas
-- versões do Postgres. Rode esta linha SOZINHA no SQL Editor do Supabase.
-- ─────────────────────────────────────────────────────────────

alter type job_status add value if not exists 'cancelada';
