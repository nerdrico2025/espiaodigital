import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'md';

  const supabase = createClient();
  const { data: inv } = await supabase.from('investigations').select('*').eq('id', params.id).maybeSingle();
  if (!inv) return new Response('Não encontrada', { status: 404 });

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('investigation_id', params.id)
    .eq('selected', true)
    .order('score', { ascending: false });

  const { data: creatives } = await supabase
    .from('creatives')
    .select('*')
    .eq('investigation_id', params.id);

  const cands = candidates ?? [];
  const crs = creatives ?? [];

  if (format === 'csv') {
    const header = [
      'concorrente', 'dominio', 'score', 'evidencia', 'motivo',
      'criativo_tipo', 'criativo_status', 'transcricao', 'analise_hook', 'analise_angulo',
    ];
    const lines = [header.join(',')];
    for (const c of cands) {
      const ccrs = crs.filter((x) => x.candidate_id === c.id);
      if (ccrs.length === 0) {
        lines.push(csvRow([c.name, c.domain, c.score, c.evidence_level, c.selection_reason, '', '', '', '', '']));
      }
      for (const cr of ccrs) {
        lines.push(
          csvRow([
            c.name, c.domain, c.score, c.evidence_level, c.selection_reason,
            cr.media_type, cr.status, cr.transcription,
            cr.analysis?.hook ?? '', cr.analysis?.angulo ?? '',
          ]),
        );
      }
    }
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="investigacao-${params.id}.csv"`,
      },
    });
  }

  // Markdown
  const md: string[] = [];
  md.push(`# Investigação: ${inv.query}`);
  md.push(`\nPaís: ${inv.country} · Concorrentes pedidos: ${inv.competitors} · Status: ${inv.status}`);
  md.push(`Custo final estimado: US$ ${Number(inv.final_cost_usd ?? 0).toFixed(4)}`);
  if (inv.notice) md.push(`\n> ⚠️ ${inv.notice}`);

  for (const c of cands) {
    md.push(`\n## ${c.name}${c.domain ? ` (${c.domain})` : ''}`);
    md.push(`- Score: **${c.score}** · Evidência: **${c.evidence_level}**`);
    md.push(`- Motivo: ${c.selection_reason ?? '—'}`);
    if (c.summary) md.push(`- Resumo: ${c.summary}`);
    if (Array.isArray(c.hook_patterns) && c.hook_patterns.length)
      md.push(`- Hooks: ${c.hook_patterns.join(' | ')}`);

    const ccrs = crs.filter((x) => x.candidate_id === c.id);
    for (const cr of ccrs) {
      md.push(`\n### Criativo (${cr.media_type}) — ${cr.status}`);
      if (cr.transcription) md.push(`**Transcrição:** ${cr.transcription}`);
      if (cr.analysis) md.push('```json\n' + JSON.stringify(cr.analysis, null, 2) + '\n```');
    }
  }

  return new Response(md.join('\n'), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="investigacao-${params.id}.md"`,
    },
  });
}

function csvRow(cols: (string | number | null | undefined)[]): string {
  return cols
    .map((c) => {
      const s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
