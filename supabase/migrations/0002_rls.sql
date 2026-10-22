-- ─────────────────────────────────────────────────────────────
-- RLS: acesso só para o usuário autenticado dono da investigação.
-- O worker usa a service role key, que ignora RLS por padrão.
-- ─────────────────────────────────────────────────────────────

alter table public.investigations enable row level security;
alter table public.jobs           enable row level security;
alter table public.job_events      enable row level security;
alter table public.candidates      enable row level security;
alter table public.ads             enable row level security;
alter table public.creatives       enable row level security;
alter table public.cost_log        enable row level security;

-- investigations: dono = auth.uid()
drop policy if exists investigations_owner on public.investigations;
create policy investigations_owner on public.investigations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Helper: a investigação pertence ao usuário atual?
create or replace function public.owns_investigation(inv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.investigations i
    where i.id = inv and i.user_id = auth.uid()
  );
$$;

-- Tabelas-filhas: leitura liberada ao dono da investigação.
-- (Escrita é feita pelo worker via service role; o usuário só lê.)
do $$
declare t text;
begin
  foreach t in array array['jobs','job_events','candidates','ads','creatives','cost_log']
  loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format(
      'create policy %I_read on public.%I for select to authenticated using (public.owns_investigation(investigation_id))',
      t, t
    );
  end loop;
end $$;

-- Storage: o dono pode ler os objetos da pasta da sua investigação.
-- Caminho convencionado: <investigation_id>/<...>.
drop policy if exists creatives_read on storage.objects;
create policy creatives_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'creatives'
    and public.owns_investigation((storage.foldername(name))[1]::uuid)
  );
