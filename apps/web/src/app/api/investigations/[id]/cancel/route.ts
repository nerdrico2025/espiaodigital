import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// POST /api/investigations/[id]/cancel
// Marca a investigação e seus jobs como 'cancelada'. O worker checa isso
// entre etapas/itens e para, preservando o que já foi coletado e o custo.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  // RLS garante que o usuário só enxerga as próprias investigações.
  const { data: inv } = await supabase
    .from('investigations')
    .select('id, status')
    .eq('id', params.id)
    .maybeSingle();
  if (!inv) return NextResponse.json({ error: 'Investigação não encontrada' }, { status: 404 });
  if (inv.status === 'concluida' || inv.status === 'cancelada') {
    return NextResponse.json({ error: 'Investigação já finalizada.' }, { status: 409 });
  }

  const admin = createAdminClient();
  const { error: e1 } = await admin
    .from('investigations')
    .update({ status: 'cancelada', notice: 'Investigação cancelada pelo usuário.' })
    .eq('id', params.id);
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

  await admin
    .from('jobs')
    .update({ status: 'cancelada', locked_at: null, locked_by: null })
    .eq('investigation_id', params.id)
    .in('status', ['pendente', 'rodando', 'falhou']);

  return NextResponse.json({ ok: true });
}
