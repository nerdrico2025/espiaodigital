import {
  classifyCandidate,
  mediaFileName,
  slug,
  temNarracao,
  SEM_NARRACAO_MSG,
  type CandidateMetrics,
} from '@espiao/shared';
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

  const { data: allCandidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('investigation_id', params.id)
    .order('score', { ascending: false });

  const { data: creatives } = await supabase
    .from('creatives')
    .select('*')
    .eq('investigation_id', params.id);

  const { data: adsData } = await supabase
    .from('ads')
    .select('id, nivel_evidencia, dias_no_ar, versoes, is_active, motivo')
    .eq('investigation_id', params.id);
  const adById = new Map((adsData ?? []).map((a) => [a.id, a]));

  const [{ data: funnelsData }, { data: funnelStepsData }] = await Promise.all([
    supabase.from('funnels').select('*').eq('investigation_id', params.id),
    supabase.from('funnel_steps').select('*').eq('investigation_id', params.id).order('step_order'),
  ]);
  const funnels = funnelsData ?? [];
  const funnelSteps = funnelStepsData ?? [];
  const { data: vslsData } = await supabase.from('vsls').select('*').eq('investigation_id', params.id);
  const vsls = vslsData ?? [];

  const cands = candidates ?? [];
  const evaluated = allCandidates ?? [];
  const crs = creatives ?? [];

  // `evidence` como base (dados antigos) + `metrics` por cima.
  const metricsOf = (c: any): Partial<CandidateMetrics> =>
    ({ ...(c.evidence ?? {}), ...(c.metrics ?? {}) }) as Partial<CandidateMetrics>;
  const nc = (v: unknown) => (v == null || v === '' ? 'não coletado' : v);

  // Caminho/nome do arquivo de mídia de um criativo (pasta por anunciante).
  const mediaPathOf = (cr: any, c: any): string => {
    if (!cr.storage_path) return '';
    const a = adById.get(cr.ad_id);
    const name = mediaFileName({
      candidate: c?.name ?? c?.domain ?? 'anunciante',
      nivel: a?.nivel_evidencia ?? null,
      dias: a?.dias_no_ar ?? null,
      creativeId: cr.id,
      storagePath: cr.storage_path,
      mediaType: cr.media_type,
    });
    return `${slug(c?.name ?? c?.domain ?? 'anunciante')}/${name}`;
  };
  // Transcrição legível: mensagem padrão quando vídeo sem narração.
  const transcricaoOf = (cr: any): string =>
    cr.media_type === 'video' && !temNarracao(cr.transcription)
      ? SEM_NARRACAO_MSG
      : cr.transcription ?? '';

  if (format === 'csv') {
    const header = [
      'concorrente', 'dominio', 'nivel', 'dias_no_ar', 'versoes', 'ativo', 'motivo',
      'criativo_tipo', 'criativo_status', 'arquivo_midia', 'transcricao', 'analise_hook', 'analise_angulo',
    ];
    const lines = [header.join(',')];
    for (const c of cands) {
      const ccrs = crs.filter((x) => x.candidate_id === c.id);
      if (ccrs.length === 0) {
        lines.push(csvRow([c.name, c.domain, '', '', '', '', c.selection_reason, '', '', '', '', '', '']));
      }
      for (const cr of ccrs) {
        const a = adById.get(cr.ad_id);
        lines.push(
          csvRow([
            c.name, c.domain,
            nc(a?.nivel_evidencia), nc(a?.dias_no_ar), nc(a?.versoes),
            a?.is_active == null ? 'não coletado' : a.is_active ? 'sim' : 'não',
            nc(a?.motivo),
            cr.media_type, cr.status, mediaPathOf(cr, c) || 'não coletado', transcricaoOf(cr),
            cr.analysis?.hook ?? '', cr.analysis?.angulo ?? '',
          ]),
        );
      }
    }

    // Seção "Candidatos avaliados" (todos, mesmo com 0 selecionados).
    lines.push('');
    lines.push('# Candidatos avaliados');
    lines.push(
      [
        'concorrente', 'dominio', 'anuncios_coletados', 'dias', 'variacoes',
        'plataformas', 'paises', 'score', 'status', 'motivo',
      ].join(','),
    );
    for (const c of evaluated) {
      const m = metricsOf(c);
      const v = classifyCandidate(m, c.selected);
      lines.push(
        csvRow([
          c.name, c.domain, m.adsCollected ?? '', m.daysLive ?? '', m.maxVariations ?? '',
          m.distinctPlatforms || 'não coletado', m.distinctCountries || 'não coletado', c.score, v.label, v.reason,
        ]),
      );
    }

    // Seção "Funil" (passos por página capturada).
    lines.push('');
    lines.push('# Funil');
    lines.push(
      ['funil_url', 'checkout', 'player', 'passo', 'tipo', 'url', 'bloqueado', 'screenshot', 'headline', 'preco', 'cta'].join(','),
    );
    for (const f of funnels) {
      const fsteps = funnelSteps.filter((s) => s.funnel_id === f.id);
      for (const s of fsteps) {
        const a = s.analysis ?? {};
        lines.push(
          csvRow([
            f.entry_url, nc(f.checkout_platform), nc(f.video_player),
            s.step_order + 1, nc(a.tipo ?? s.step_type), s.url, s.blocked ? 'sim' : 'não',
            s.screenshot_path ?? 'não coletado', a.headline ?? '', a.preco ?? '', a.cta ?? '',
          ]),
        );
      }
    }

    // Seção "VSL" (um bloco por linha).
    lines.push('');
    lines.push('# VSL');
    lines.push(
      ['vsl_url', 'status', 'duracao_seg', 'provedor', 'parcial', 'aproximado', 'audio', 'video', 'bloco', 'nome', 'presente', 'inicio', 'fim', 'nota'].join(','),
    );
    for (const v of vsls) {
      const blocos = v.analysis?.blocos ?? [];
      if (blocos.length === 0) {
        lines.push(csvRow([v.source_url, v.status, v.duration_seconds ?? '', v.transcription_provider ?? '', v.partial ? 'sim' : 'não', v.approx_timestamps ? 'sim' : 'não', v.audio_path ?? '', v.video_path ?? '', '', '', '', '', '', '']));
      }
      for (const b of blocos) {
        lines.push(
          csvRow([
            v.source_url, v.status, v.duration_seconds ?? '', v.transcription_provider ?? '',
            v.partial ? 'sim' : 'não', v.approx_timestamps ? 'sim' : 'não', v.audio_path ?? '', v.video_path ?? '',
            b.bloco, b.nome, b.presente ? 'sim' : 'não', b.inicio ?? '', b.fim ?? '', b.nota ?? '',
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

  // Seção "Candidatos avaliados" (todos, mesmo com 0 selecionados).
  md.push(`\n## Candidatos avaliados (${evaluated.length})`);
  md.push('| Concorrente | Anúncios | Melhor anúncio (dias · versões) | Plat. | Países | Status | Motivo |');
  md.push('|---|---|---|---|---|---|---|');
  for (const c of evaluated) {
    const m = metricsOf(c);
    const v = classifyCandidate(m, c.selected);
    const anuncios = m.adsCollected ?? 'não coletado';
    const melhor =
      m.bestAdDays != null || m.bestAdVersions != null
        ? `${m.bestAdDays ?? '—'}d · ${m.bestAdVersions ?? '—'} ver.`
        : 'não coletado';
    md.push(
      `| ${c.name}${c.domain ? ` (${c.domain})` : ''} | ${anuncios} | ${melhor} | ` +
        `${m.distinctPlatforms || 'não coletado'} | ${m.distinctCountries || 'não coletado'} | ${v.label} | ${v.reason} |`,
    );
  }

  const tituloSel = inv.mode === 'anunciante' ? 'Anúncios escalados desta empresa' : 'Concorrentes selecionados';
  if (cands.length > 0) md.push(`\n## ${tituloSel}`);
  for (const c of cands) {
    md.push(`\n## ${c.name}${c.domain ? ` (${c.domain})` : ''}`);
    md.push(`- Motivo: ${c.selection_reason ?? '—'}`);
    if (c.summary) md.push(`- Resumo: ${c.summary}`);
    if (Array.isArray(c.hook_patterns) && c.hook_patterns.length)
      md.push(`- Hooks: ${c.hook_patterns.join(' | ')}`);

    const ccrs = crs.filter((x) => x.candidate_id === c.id);
    for (const cr of ccrs) {
      const a = adById.get(cr.ad_id);
      const ativo = a?.is_active == null ? 'não coletado' : a.is_active ? 'sim' : 'não';
      md.push(`\n### Anúncio (${cr.media_type}) — evidência ${nc(a?.nivel_evidencia)}`);
      md.push(
        `- Dias no ar: ${nc(a?.dias_no_ar)} · Versões: ${nc(a?.versoes)} · Ativo: ${ativo}`,
      );
      md.push(`- Motivo: ${nc(a?.motivo)}`);
      md.push(`- Arquivo de mídia: ${mediaPathOf(cr, c) || 'não coletado'}`);
      if (cr.media_type === 'video') md.push(`**Transcrição:** ${transcricaoOf(cr)}`);
      if (cr.analysis) md.push('```json\n' + JSON.stringify(cr.analysis, null, 2) + '\n```');
    }
  }

  // Seção "Funil"
  if (funnels.length > 0) md.push(`\n## Funil (${funnels.length})`);
  for (const f of funnels) {
    md.push(`\n### ${f.entry_url}`);
    md.push(
      `- Checkout: ${nc(f.checkout_platform)} · Player: ${nc(f.video_player)} · ` +
        `Pixels: ${(f.pixels ?? []).map((p: any) => `${p.tipo}${p.id ? `(${p.id})` : ''}`).join(', ') || 'não coletado'}`,
    );
    if (f.blocked) md.push(`- ⚠️ possível bloqueio em algum passo`);
    const tech = f.tech ?? {};
    if (Array.isArray(tech.samePixelOtherDomain) && tech.samePixelOtherDomain.length)
      md.push(`- ⚠️ mesmo pixel em outro domínio: ${tech.samePixelOtherDomain.map((x: any) => `${x.id}→${x.domain}`).join(', ')}`);
    for (const s of funnelSteps.filter((x) => x.funnel_id === f.id)) {
      const a = s.analysis ?? {};
      md.push(`\n#### Passo ${s.step_order + 1} — ${nc(a.tipo ?? s.step_type)}${s.blocked ? ' (possível bloqueio)' : ''}`);
      md.push(`- URL: ${s.url}`);
      md.push(`- Screenshot: ${s.screenshot_path ?? 'não coletado'}`);
      md.push(
        `- Headline: ${nc(a.headline)} · Preço: ${nc(a.preco)} · Oferta: ${nc(a.oferta)} · CTA: ${nc(a.cta)}`,
      );
    }
  }

  // Seção "VSL"
  if (vsls.length > 0) md.push(`\n## VSL (${vsls.length})`);
  for (const v of vsls) {
    md.push(`\n### ${v.source_url}`);
    md.push(
      `- Status: ${v.status}${v.fail_reason ? ` (${v.fail_reason})` : ''} · Duração: ${v.duration_seconds ?? '—'}s · Provedor: ${nc(v.transcription_provider)}`,
    );
    if (v.partial) md.push(`- ⚠️ transcrição parcial`);
    if (v.approx_timestamps) md.push(`- timestamps aproximados`);
    md.push(`- Áudio: ${v.audio_path ?? 'não coletado'} · Vídeo: ${v.video_path ?? 'não coletado'}`);
    const r = v.analysis?.resumo;
    if (r) {
      md.push(
        `- Big Idea: ${nc(r.bigIdea)} · Mecanismo: ${nc(r.mecanismo)} · Oferta: ${nc(r.oferta)} · Preço: ${nc(r.preco)}`,
      );
      md.push(`- Garantia: ${nc(r.garantia)} · Emoção: ${nc(r.emocaoDominante)} · Vilão: ${nc(r.vilao)}`);
    }
    for (const b of v.analysis?.blocos ?? []) {
      if (!b.presente) continue;
      md.push(`\n#### ${b.bloco} ${b.nome} — nota ${b.nota ?? '—'} (${b.inicio ?? '—'}–${b.fim ?? '—'})`);
      if (b.analise) md.push(`${b.analise}`);
      for (const c of b.citacoes ?? []) md.push(`> “${c}”`);
    }
    if (v.transcription) md.push(`\n**Transcrição:**\n\n${v.transcription}`);
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
