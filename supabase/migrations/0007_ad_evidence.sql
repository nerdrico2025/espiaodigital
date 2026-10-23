-- ─────────────────────────────────────────────────────────────
-- Evidência POR ANÚNCIO (nível do anúncio, não do anunciante).
-- Preenchidas na etapa "pontuar". Defaults seguros: investigações
-- antigas abrem normalmente e mostram "não coletado" onde faltar.
--   dias_no_ar      — dias no ar (início→hoje se ativo, senão início→fim)
--   versoes         — tamanho do cluster do anúncio (anúncios parecidos)
--   nivel_evidencia — 'alto' | 'medio' | 'baixo' (null = não coletado)
--   motivo          — texto em PT simples
--   cluster_id      — chave do cluster (destino + texto-base)
-- Obs.: "ativo" reaproveita a coluna existente `is_active`.
-- ─────────────────────────────────────────────────────────────

alter table public.ads
  add column if not exists dias_no_ar      integer,
  add column if not exists versoes         integer not null default 1,
  add column if not exists nivel_evidencia text,
  add column if not exists motivo          text,
  add column if not exists cluster_id      text;
