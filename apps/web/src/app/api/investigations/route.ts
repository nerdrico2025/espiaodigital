import { NextResponse } from 'next/server';
import {
  estimateInvestigationCost,
  clampInvestigationConfig,
  resolveLimits,
  parseInvestigationMode,
} from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.query || typeof body.query !== 'string') {
    return NextResponse.json({ error: 'Informe o nicho, app ou URL.' }, { status: 400 });
  }
  let mode;
  try {
    mode = parseInvestigationMode(body.mode); // erro explícito p/ modo inválido
  } catch {
    return NextResponse.json({ error: 'Modo de investigação inválido.' }, { status: 400 });
  }
  const country = String(body.country || 'BR').toUpperCase();
  const onlyActive = body.onlyActive !== false;
  // "anunciante"/"pagina": um único alvo (sem descoberta de concorrentes).
  const competitors =
    mode === 'concorrentes' ? Math.max(1, Math.min(20, Number(body.competitors) || 5)) : 1;

  // Opções avançadas: valida/clampa e deixa só os campos preenchidos.
  const config = clampInvestigationConfig(body.config);
  const est = estimateInvestigationCost(competitors, resolveLimits(config), mode);

  // Usa service role para criar investigação + job + custo estimado atomicamente.
  const admin = createAdminClient();

  const { data: inv, error: e1 } = await admin
    .from('investigations')
    .insert({
      user_id: user.id,
      query: body.query.trim(),
      country,
      competitors,
      only_active: onlyActive,
      config,
      mode,
      status: 'pendente',
      estimated_cost_usd: est.total,
    })
    .select('id')
    .single();
  if (e1 || !inv) {
    return NextResponse.json({ error: e1?.message ?? 'Falha ao criar' }, { status: 500 });
  }

  const { error: e2 } = await admin.from('jobs').insert({
    investigation_id: inv.id,
    status: 'pendente',
  });
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  // Registra a estimativa como linhas de custo "estimado".
  await admin.from('cost_log').insert(
    est.entries.map((entry) => ({
      investigation_id: inv.id,
      provider: entry.provider,
      unit: `estimativa:${entry.unit}`,
      quantity: entry.quantity,
      estimated_usd: 0, // estimativa não entra no custo final real
      note: `estimativa US$ ${entry.estimatedUsd.toFixed(4)}`,
    })),
  );

  return NextResponse.json({ id: inv.id });
}
