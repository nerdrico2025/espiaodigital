-- ─────────────────────────────────────────────────────────────
-- Fila sem Redis: claim atômico com FOR UPDATE SKIP LOCKED.
-- O worker chama esta função (via service role) a cada polling.
-- ─────────────────────────────────────────────────────────────

create or replace function public.claim_job(p_worker text)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.jobs;
begin
  select * into claimed
  from public.jobs j
  where j.status in ('pendente', 'falhou')
    and j.run_after <= now()
    and j.attempts < j.max_attempts
  order by j.created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.jobs
     set status = 'rodando',
         locked_at = now(),
         locked_by = p_worker,
         attempts = attempts + 1
   where id = claimed.id
   returning * into claimed;

  update public.investigations
     set status = 'rodando'
   where id = claimed.investigation_id;

  return claimed;
end $$;

-- Reenfileira a partir de uma etapa para "refazer etapa" sem repetir as concluídas.
-- p_clear_steps = a etapa que falhou + todas as seguintes (o app conhece a ordem).
create or replace function public.requeue_step(p_investigation uuid, p_clear_steps text[])
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.jobs;
begin
  update public.jobs
     set status = 'pendente',
         run_after = now(),
         attempts = 0,
         last_error = null,
         current_step = p_clear_steps[1],
         -- mantém só as etapas concluídas que NÃO estão na lista a refazer
         completed_steps = (
           select coalesce(array_agg(s), '{}')
           from unnest(completed_steps) s
           where not (s = any(p_clear_steps))
         )
   where investigation_id = p_investigation
   returning * into j;

  update public.investigations set status = 'pendente' where id = p_investigation;
  return j;
end $$;
