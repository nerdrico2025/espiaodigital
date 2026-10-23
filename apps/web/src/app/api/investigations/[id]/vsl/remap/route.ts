import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Refazer SÓ o mapeamento das VSLs: reenfileira apenas a etapa processar_vsl.
// O worker reaproveita a transcrição já salva (não baixa nem transcreve de novo).
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  // Confirma posse (RLS no cliente de sessão).
  const { data: owned } = await supabase
    .from('investigations')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'Não encontrada' }, { status: 404 });

  const admin = createAdminClient();
  // Limpa só processar_vsl (consolidar segue concluída). A transcrição salva na
  // própria linha da VSL é reaproveitada pelo worker no modo "refazer mapeamento".
  const { error } = await admin.rpc('requeue_step', {
    p_investigation: params.id,
    p_clear_steps: ['processar_vsl'],
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
