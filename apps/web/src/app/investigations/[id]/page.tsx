import Link from 'next/link';
import { notFound } from 'next/navigation';
import { classifyCandidate, type CandidateMetrics, type CandidateStatus } from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { STATUS_PT, STATUS_STYLE, EVIDENCE_PT, usdFmt, dateFmt } from '@/lib/format';
import { StepBar } from '@/components/StepBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Expandable } from '@/components/Expandable';

export const dynamic = 'force-dynamic';

export default async function InvestigationDetail({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: inv } = await supabase
    .from('investigations')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!inv) notFound();

  const [{ data: job }, { data: events }, { data: candidates }, { data: allCandidates }, { data: creatives }] =
    await Promise.all([
      supabase.from('jobs').select('*').eq('investigation_id', params.id).maybeSingle(),
      supabase.from('job_events').select('*').eq('investigation_id', params.id).order('created_at'),
      supabase
        .from('candidates')
        .select('*')
        .eq('investigation_id', params.id)
        .eq('selected', true)
        .order('score', { ascending: false }),
      supabase
        .from('candidates')
        .select('*')
        .eq('investigation_id', params.id)
        .order('score', { ascending: false }),
      supabase.from('creatives').select('*').eq('investigation_id', params.id),
    ]);

  const cands = candidates ?? [];
  const evaluated = allCandidates ?? [];
  const crs = creatives ?? [];

  // Métricas efetivas por candidato: `evidence` como base (investigações
  // anteriores à coluna `metrics`) + `metrics` por cima (adsCollected etc.).
  const metricsOf = (c: any): Partial<CandidateMetrics> =>
    ({ ...(c.evidence ?? {}), ...(c.metrics ?? {}) }) as Partial<CandidateMetrics>;

  // Dica de amostra pequena: algum candidato não selecionado coletou ≤ o limite.
  const showSampleTip = evaluated.some(
    (c) => !c.selected && classifyCandidate(metricsOf(c), c.selected).smallSample,
  );

  // URLs assinadas para a mídia privada (via service role, server-side).
  const admin = createAdminClient();
  const signed = new Map<string, string>();
  const paths = crs.map((c) => c.storage_path).filter(Boolean) as string[];
  if (paths.length) {
    const { data } = await admin.storage.from('creatives').createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  const running = inv.status === 'rodando' || inv.status === 'pendente';
  const isAnunciante = inv.mode === 'anunciante';

  return (
    <div>
      <AutoRefresh active={running} />

      <div className="mb-4">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-900">
          ← Voltar
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{inv.query}</h1>
          <p className="text-sm text-gray-500">
            {isAnunciante ? (
              <>Modo: analisar anunciante · País {inv.country}</>
            ) : (
              <>
                Modo: descobrir concorrentes · País {inv.country} · {inv.competitors} concorrentes
              </>
            )}{' '}
            · criada {dateFmt(inv.created_at)}
          </p>
          {!isAnunciante && (
            <p className="mt-1 text-sm text-gray-600">
              <span className="font-medium">Referência:</span> {inv.query}{' '}
              <span className="text-gray-400">(excluída da lista de concorrentes)</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${STATUS_STYLE[inv.status]}`}>{STATUS_PT[inv.status]}</span>
          <a className="btn-ghost" href={`/api/investigations/${params.id}/export?format=md`}>
            Exportar .md
          </a>
          <a className="btn-ghost" href={`/api/investigations/${params.id}/export?format=csv`}>
            Exportar .csv
          </a>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-3 text-sm">
        <div className="card">
          <div className="text-gray-500">Custo estimado</div>
          <div className="text-lg font-semibold">{usdFmt(Number(inv.estimated_cost_usd))}</div>
        </div>
        <div className="card">
          <div className="text-gray-500">Custo final</div>
          <div className="text-lg font-semibold">
            {usdFmt(inv.final_cost_usd == null ? null : Number(inv.final_cost_usd))}
          </div>
        </div>
        <div className="card">
          <div className="text-gray-500">Concorrentes selecionados</div>
          <div className="text-lg font-semibold">{cands.length}</div>
        </div>
      </div>

      {inv.notice && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ {inv.notice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        <StepBar
          investigationId={params.id}
          completed={(job?.completed_steps ?? []) as string[]}
          current={job?.current_step ?? null}
          jobStatus={inv.status}
          lastError={job?.last_error ?? null}
          events={(events ?? []) as any}
        />

        <div className="space-y-5">
          {/* Candidatos avaliados — sempre visível, mesmo com 0 selecionados. */}
          <div className="card">
            <h2 className="mb-1 text-lg font-semibold">Candidatos avaliados ({evaluated.length})</h2>
            <p className="mb-3 text-xs text-gray-500">
              Todos os candidatos analisados e o porquê de cada um. Só os “Selecionado” recebem
              download e transcrição; “Quase lá” é evidência média e não entra na contagem.
            </p>

            {showSampleTip && (
              <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
                💡 Alguns candidatos tiveram <strong>poucos anúncios coletados</strong> (≤ o limite por
                candidato). Em <em>Opções avançadas</em>, aumente <strong>“Anúncios por candidato”</strong>{' '}
                para coletar uma amostra maior e revelar mais evidência.
              </div>
            )}

            {evaluated.length === 0 ? (
              <p className="text-sm text-gray-500">
                {running
                  ? 'Processando… a avaliação aparece ao final da pontuação.'
                  : 'Nenhum candidato foi avaliado.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-xs text-gray-500">
                      <th className="py-2 pr-3">{isAnunciante ? 'Empresa' : 'Concorrente'}</th>
                      <th className="px-2">Anúncios</th>
                      <th className="px-2">Dias</th>
                      <th className="px-2">Variações</th>
                      <th className="px-2">Plat.</th>
                      <th className="px-2">Países</th>
                      <th className="px-2">Score</th>
                      <th className="px-2">Status</th>
                      <th className="px-2">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluated.map((c) => {
                      const m = metricsOf(c);
                      const v = classifyCandidate(m, c.selected);
                      return (
                        <tr key={c.id} className="border-b border-gray-100 align-top">
                          <td className="py-2 pr-3">
                            <div className="font-medium">{c.name}</div>
                            {c.domain && <div className="text-xs text-gray-400">{c.domain}</div>}
                          </td>
                          <td className="px-2 tabular-nums">
                            {m.adsCollected ?? <span className="text-gray-400">não coletado</span>}
                          </td>
                          <td className="px-2 tabular-nums">{m.daysLive ?? '—'}</td>
                          <td className="px-2 tabular-nums">{m.maxVariations ?? '—'}</td>
                          <td className="px-2 tabular-nums">{m.distinctPlatforms ?? '—'}</td>
                          <td className="px-2 tabular-nums">{m.distinctCountries ?? '—'}</td>
                          <td className="px-2 tabular-nums">{c.score}</td>
                          <td className="px-2">
                            <StatusBadge status={v.status} label={v.label} />
                          </td>
                          <td className="px-2 text-xs text-gray-600">{v.reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <h2 className="text-lg font-semibold">
            {isAnunciante ? 'Anúncios escalados desta empresa' : 'Concorrentes selecionados'}
          </h2>
          {cands.length === 0 ? (
            <div className="card text-sm text-gray-500">
              {running
                ? 'Processando… os anúncios campeões aparecem aqui ao final do pipeline.'
                : isAnunciante
                  ? 'Nenhum anúncio próprio foi encontrado para esta empresa.'
                  : 'Nenhum concorrente com evidência forte foi selecionado.'}
            </div>
          ) : (
            cands.map((c) => {
              const ccrs = crs.filter((x) => x.candidate_id === c.id);
              const ev = c.evidence ?? {};
              return (
                <div key={c.id} className="card">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">{c.name}</h3>
                      {c.domain && <p className="text-sm text-gray-500">{c.domain}</p>}
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-500">Score</div>
                      <div className="text-xl font-bold text-brand">{c.score}</div>
                      <span className="badge bg-brand-soft text-brand">
                        Evidência {EVIDENCE_PT[c.evidence_level] ?? c.evidence_level}
                      </span>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-2 text-xs text-gray-600">
                    <Evi label="Dias no ar" value={ev.daysLive} />
                    <Evi label="Plataformas" value={ev.distinctPlatforms} />
                    <Evi label="Variações" value={ev.maxVariations} />
                    <Evi label="Países" value={ev.distinctCountries} />
                    <Evi label="Vídeo" value={ev.hasVideo ? 'sim' : 'não'} />
                    <Evi label="CTA ação" value={ev.hasActionCta ? 'sim' : 'não'} />
                  </div>

                  {c.selection_reason && (
                    <p className="mb-3 text-sm text-gray-600">
                      <span className="font-medium">Por que foi selecionado:</span> {c.selection_reason}
                    </p>
                  )}
                  {c.summary && <p className="mb-3 text-sm text-gray-700">{c.summary}</p>}

                  <h4 className="mb-2 text-sm font-semibold text-gray-500">Criativos ({ccrs.length})</h4>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {ccrs.map((cr) => {
                      const mediaUrl = cr.storage_path ? signed.get(cr.storage_path) : null;
                      return (
                        <div key={cr.id} className="rounded-lg border border-gray-200 p-3">
                          <div className="mb-2 flex items-center justify-between text-xs">
                            <span className="badge bg-gray-100 text-gray-700">{cr.media_type}</span>
                            <span className="text-gray-400">{cr.status}</span>
                          </div>
                          {cr.status === 'midia_indisponivel' ? (
                            <div className="rounded bg-gray-50 p-4 text-center text-xs text-gray-400">
                              mídia indisponível
                            </div>
                          ) : mediaUrl && cr.media_type === 'video' ? (
                            <video controls className="w-full rounded" src={mediaUrl} />
                          ) : mediaUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img alt="criativo" className="w-full rounded" src={mediaUrl} />
                          ) : (
                            <div className="rounded bg-gray-50 p-4 text-center text-xs text-gray-400">
                              (mídia ainda não baixada)
                            </div>
                          )}

                          <div className="mt-2 space-y-2">
                            {cr.transcription && (
                              <Expandable title="Transcrição">
                                <p className="whitespace-pre-wrap">{cr.transcription}</p>
                              </Expandable>
                            )}
                            {cr.analysis && (
                              <Expandable title="Análise">
                                <AnalysisView analysis={cr.analysis} />
                              </Expandable>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, label }: { status: CandidateStatus; label: string }) {
  const style: Record<CandidateStatus, string> = {
    selecionado: 'bg-green-100 text-green-800',
    quase: 'bg-amber-100 text-amber-800',
    nao: 'bg-gray-100 text-gray-600',
  };
  return <span className={`badge whitespace-nowrap ${style[status]}`}>{label}</span>;
}

function Evi({ label, value }: { label: string; value: unknown }) {
  return (
    <span className="rounded bg-gray-100 px-2 py-1">
      {label}: <span className="font-medium">{value == null ? '—' : String(value)}</span>
    </span>
  );
}

function AnalysisView({ analysis }: { analysis: any }) {
  const rows: [string, unknown][] = [
    ['Hook', analysis.hook],
    ['Ângulo', analysis.angulo],
    ['Mecanismo', analysis.mecanismo],
    ['Prova', analysis.prova],
    ['CTA', analysis.cta],
    ['Twist', analysis.twist],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="font-medium">{k}:</span> {v == null ? <span className="text-gray-400">não coletado</span> : String(v)}
        </div>
      ))}
      {Array.isArray(analysis.blocos) && analysis.blocos.length > 0 && (
        <div>
          <span className="font-medium">Estrutura (VSL):</span>
          <ul className="ml-4 list-disc">
            {analysis.blocos.map((b: any, i: number) => (
              <li key={i}>
                <span className="text-gray-500">{b.timestamp}</span> — {b.descricao}
              </li>
            ))}
          </ul>
        </div>
      )}
      {analysis.imagem && (
        <div>
          <span className="font-medium">Imagem:</span> formato {analysis.imagem.formato ?? '—'}, texto “
          {analysis.imagem.textoNaImagem ?? '—'}”, estilo {analysis.imagem.estilo ?? '—'}, paleta{' '}
          {analysis.imagem.paleta ?? '—'}
        </div>
      )}
    </div>
  );
}
