import { NextResponse } from 'next/server';
import { STEP_ORDER, type StepName } from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Refazer a partir de uma etapa que falhou, sem repetir as concluídas.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  // Confirma que a investigação é do usuário (via RLS no cliente de sessão).
  const { data: owned } = await supabase
    .from('investigations')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'Não encontrada' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const step = body?.step as StepName;
  if (!STEP_ORDER.includes(step)) {
    return NextResponse.json({ error: 'Etapa inválida' }, { status: 400 });
  }

  // Limpa a etapa alvo e todas as seguintes (o resto permanece concluído).
  const idx = STEP_ORDER.indexOf(step);
  const clear = STEP_ORDER.slice(idx);

  const admin = createAdminClient();
  const { error } = await admin.rpc('requeue_step', {
    p_investigation: params.id,
    p_clear_steps: clear,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, requeuedFrom: step });
}
