import { NextResponse } from 'next/server';
import { mediaFileName, slug, temNarracao, SEM_NARRACAO_MSG } from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { zipStream, toReadableStream, type ZipEntry } from '@/lib/zip';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

// GET /api/investigations/[id]/media.zip?candidate=<id>
// Zip em streaming: pasta por anunciante + nomes amigáveis + transcricoes.md.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  const candidateFilter = new URL(req.url).searchParams.get('candidate');

  const { data: inv } = await supabase
    .from('investigations')
    .select('id, query')
    .eq('id', params.id)
    .maybeSingle();
  if (!inv) return NextResponse.json({ error: 'Investigação não encontrada' }, { status: 404 });

  let cq = supabase
    .from('creatives')
    .select('id, storage_path, media_type, candidate_id, ad_id, transcription, analysis')
    .eq('investigation_id', params.id)
    .not('storage_path', 'is', null);
  if (candidateFilter) cq = cq.eq('candidate_id', candidateFilter);
  const { data: creatives } = await cq;

  const crs = creatives ?? [];
  if (crs.length === 0) {
    return NextResponse.json({ error: 'Nenhuma mídia baixada para empacotar.' }, { status: 404 });
  }

  const [{ data: cands }, { data: ads }] = await Promise.all([
    supabase.from('candidates').select('id, name, domain').eq('investigation_id', params.id),
    supabase.from('ads').select('id, nivel_evidencia, dias_no_ar').eq('investigation_id', params.id),
  ]);
  const candById = new Map((cands ?? []).map((c) => [c.id, c]));
  const adById = new Map((ads ?? []).map((a) => [a.id, a]));

  const admin = createAdminClient();
  const paths = crs.map((c) => c.storage_path as string);
  const { data: signedList } = await admin.storage.from('creatives').createSignedUrls(paths, 300);
  const signedByPath = new Map((signedList ?? []).map((s) => [s.path, s.signedUrl]));

  // Monta metadados (pasta/nome por criativo) e checa o tamanho total antes.
  type Item = { cr: (typeof crs)[number]; folder: string; fileName: string; url: string };
  const items: Item[] = [];
  let totalBytes = 0;
  for (const cr of crs) {
    const url = signedByPath.get(cr.storage_path as string);
    if (!url) continue;
    const cand = candById.get(cr.candidate_id);
    const ad = adById.get(cr.ad_id);
    const folder = slug(cand?.name ?? cand?.domain ?? 'anunciante');
    const fileName = mediaFileName({
      candidate: cand?.name ?? cand?.domain ?? 'anunciante',
      nivel: ad?.nivel_evidencia ?? null,
      dias: ad?.dias_no_ar ?? null,
      creativeId: cr.id,
      storagePath: cr.storage_path,
      mediaType: cr.media_type,
    });
    items.push({ cr, folder, fileName, url });
    totalBytes += await fileSize(url);
  }

  if (totalBytes > MAX_BYTES) {
    const mb = Math.round(totalBytes / (1024 * 1024));
    return NextResponse.json(
      {
        error:
          `O pacote ficaria com ~${mb} MB, acima do limite de 500 MB. ` +
          `Baixe por anunciante (botão "Baixar todas as mídias" no cartão de cada anunciante).`,
      },
      { status: 413 },
    );
  }

  // transcricoes.md
  const md: string[] = [`# Transcrições e análises — ${inv.query}`, ''];
  for (const it of items) {
    const cand = candById.get(it.cr.candidate_id);
    md.push(`## ${cand?.name ?? 'anunciante'} — ${it.folder}/${it.fileName}`);
    if (it.cr.media_type === 'video') {
      md.push(
        `**Transcrição:** ${temNarracao(it.cr.transcription) ? it.cr.transcription : SEM_NARRACAO_MSG}`,
      );
    }
    if (it.cr.analysis) md.push('```json\n' + JSON.stringify(it.cr.analysis, null, 2) + '\n```');
    md.push('');
  }
  const mdBytes = new TextEncoder().encode(md.join('\n'));

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const it of items) {
      yield { name: `${it.folder}/${it.fileName}`, data: streamBody(it.url) };
    }
    yield { name: 'transcricoes.md', data: mdBytes };
  }

  const zipName = `midias-${candidateFilter ? slug(candById.get(candidateFilter)?.name ?? 'anunciante') : slug(inv.query)}.zip`;
  return new Response(toReadableStream(zipStream(entries())) as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Tamanho via Range de 1 byte (Content-Range: bytes 0-0/<total>). */
async function fileSize(url: string): Promise<number> {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const cr = r.headers.get('content-range');
    const m = cr?.match(/\/(\d+)\s*$/);
    if (m && m[1]) return Number(m[1]);
    if (r.status === 200) {
      const cl = r.headers.get('content-length');
      if (cl) return Number(cl);
    }
  } catch {
    // ignora — segue sem contar este arquivo
  }
  return 0;
}

/** Lê o corpo da signed URL em chunks (sem bufferizar o arquivo inteiro). */
async function* streamBody(url: string): AsyncIterable<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status})`);
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) yield value;
  }
}
