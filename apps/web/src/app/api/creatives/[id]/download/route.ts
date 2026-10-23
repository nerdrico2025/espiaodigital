import { NextResponse } from 'next/server';
import { mediaFileName } from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// GET /api/creatives/[id]/download
// Valida a sessão, acha o criativo (RLS garante dono), gera uma signed URL
// curta (60s) com download + nome amigável e redireciona. Service role só
// no servidor (nunca no browser); o bucket continua privado.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  const { data: cr } = await supabase
    .from('creatives')
    .select('id, storage_path, media_type, candidate_id, ad_id')
    .eq('id', params.id)
    .maybeSingle();
  if (!cr) return NextResponse.json({ error: 'Criativo não encontrado' }, { status: 404 });
  if (!cr.storage_path) return NextResponse.json({ error: 'Mídia indisponível' }, { status: 409 });

  const [{ data: cand }, { data: ad }] = await Promise.all([
    supabase.from('candidates').select('name, domain').eq('id', cr.candidate_id).maybeSingle(),
    supabase.from('ads').select('nivel_evidencia, dias_no_ar').eq('id', cr.ad_id).maybeSingle(),
  ]);

  const filename = mediaFileName({
    candidate: cand?.name ?? cand?.domain ?? 'anunciante',
    nivel: ad?.nivel_evidencia ?? null,
    dias: ad?.dias_no_ar ?? null,
    creativeId: cr.id,
    storagePath: cr.storage_path,
    mediaType: cr.media_type,
  });

  const admin = createAdminClient();
  const { data: signed, error } = await admin.storage
    .from('creatives')
    .createSignedUrl(cr.storage_path, 60, { download: filename });
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: 'Falha ao gerar link de download' }, { status: 500 });
  }
  return NextResponse.redirect(signed.signedUrl);
}
