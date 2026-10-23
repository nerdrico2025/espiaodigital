import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  classifyCandidate,
  temNarracao,
  SEM_NARRACAO_MSG,
  parseInvestigationMode,
  stepsForMode,
  VSL_SUBSTEP_PT,
  type CandidateMetrics,
  type CandidateStatus,
  type VslSubstep,
} from '@espiao/shared';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { STATUS_PT, STATUS_STYLE, EVIDENCE_PT, usdFmt, dateFmt } from '@/lib/format';
import { StepBar } from '@/components/StepBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Expandable } from '@/components/Expandable';
import { CancelButton } from '@/components/CancelButton';
import { Tabs } from '@/components/Tabs';
import { RemapVslButton } from '@/components/RemapVslButton';

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

  // Evidência por anúncio (nível, dias, versões, rótulos) para cada criativo.
  const { data: adsData } = await supabase
    .from('ads')
    .select('id, nivel_evidencia, dias_no_ar, versoes, motivo, is_active, platforms, countries, cta_text, videos')
    .eq('investigation_id', params.id);
  const adById = new Map((adsData ?? []).map((a) => [a.id, a]));

  // Funil (fase 05): funis + passos em ordem.
  const [{ data: funnelsData }, { data: funnelStepsData }] = await Promise.all([
    supabase.from('funnels').select('*').eq('investigation_id', params.id),
    supabase
      .from('funnel_steps')
      .select('*')
      .eq('investigation_id', params.id)
      .order('step_order'),
  ]);
  const funnels = funnelsData ?? [];
  const funnelSteps = funnelStepsData ?? [];
  const candNameById = new Map((allCandidates ?? []).map((c) => [c.id, c.name as string]));

  // VSLs (fase 06).
  const { data: vslsData } = await supabase
    .from('vsls')
    .select('*')
    .eq('investigation_id', params.id);
  const vsls = vslsData ?? [];

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
  const paths = [
    ...crs.map((c) => c.storage_path),
    ...funnelSteps.map((s) => s.screenshot_path),
    ...vsls.map((v) => v.audio_path),
    ...vsls.map((v) => v.video_path),
  ].filter(Boolean) as string[];
  if (paths.length) {
    const { data } = await admin.storage.from('creatives').createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  const running = inv.status === 'rodando' || inv.status === 'pendente';

  // Avisos de travamento: "Pendente" há muito (worker não pegou o job) ou
  // "Rodando" sem nenhum evento novo há muito (sem atividade). Baseado em
  // timestamps já existentes (job_events.created_at / investigations.created_at);
  // não exige coluna nova.
  const evs = (events ?? []) as { created_at: string }[];
  const lastEventIso = evs.length ? evs[evs.length - 1]!.created_at : null;
  const lastActivityIso = lastEventIso ?? inv.created_at;
  const nowMs = Date.now();
  const minsSince = (iso: string | null) =>
    iso ? Math.floor((nowMs - new Date(iso).getTime()) / 60000) : 0;
  const pendingTooLong = inv.status === 'pendente' && minsSince(inv.created_at) >= 2;
  const runningStalled = inv.status === 'rodando' && minsSince(lastActivityIso) >= 5;

  const mode = parseInvestigationMode(inv.mode);
  const isAnunciante = mode === 'anunciante';
  const isPagina = mode === 'pagina';
  const modeSteps = stepsForMode(mode);

  // Modo página sem nenhuma página capturada com sucesso → "Concluída sem
  // resultado" (amarelo), nunca "Concluída" verde.
  const capturedFunnels = funnels.filter((f) => f.status === 'concluida').length;
  const noResult = isPagina && inv.status === 'concluida' && capturedFunnels === 0;
  const badgeLabel = noResult ? 'Concluída sem resultado' : STATUS_PT[inv.status];
  const badgeStyle = noResult ? STATUS_STYLE['cancelada'] : STATUS_STYLE[inv.status];

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
            {isPagina ? (
              <>Modo: analisar página/VSL · País {inv.country}</>
            ) : isAnunciante ? (
              <>Modo: analisar anunciante · País {inv.country}</>
            ) : (
              <>
                Modo: descobrir concorrentes · País {inv.country} · {inv.competitors} concorrentes
              </>
            )}{' '}
            · criada {dateFmt(inv.created_at)}
          </p>
          {!isAnunciante && !isPagina && (
            <p className="mt-1 text-sm text-gray-600">
              <span className="font-medium">Referência:</span> {inv.query}{' '}
              <span className="text-gray-400">(excluída da lista de concorrentes)</span>
            </p>
          )}
          {isPagina && (
            <p className="mt-1 text-sm text-gray-600">
              <span className="font-medium">Página analisada:</span> {inv.query}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${badgeStyle}`}>{badgeLabel}</span>
          {running && <CancelButton investigationId={params.id} />}
          {/* No modo página os botões de exportar ficam na aba "Exportar". */}
          {!isPagina && (
            <>
              <a className="btn-ghost" href={`/api/investigations/${params.id}/export?format=md`}>
                Exportar .md
              </a>
              <a className="btn-ghost" href={`/api/investigations/${params.id}/export?format=csv`}>
                Exportar .csv
              </a>
              <a className="btn-ghost" href={`/api/investigations/${params.id}/media.zip`}>
                Baixar todas as mídias (.zip)
              </a>
            </>
          )}
        </div>
      </div>

      <div className={`mb-5 grid gap-3 text-sm ${isPagina ? 'grid-cols-2' : 'grid-cols-3'}`}>
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
        {!isPagina && (
          <div className="card">
            <div className="text-gray-500">
              {isAnunciante ? 'Empresa analisada' : 'Concorrentes selecionados'}
            </div>
            <div className="text-lg font-semibold">{cands.length}</div>
          </div>
        )}
      </div>

      {/* No modo página o aviso aparece dentro da aba Resumo (evita duplicar). */}
      {inv.notice && !isPagina && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ {inv.notice}
        </div>
      )}

      {pendingTooLong && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⏳ Pendente há {minsSince(inv.created_at)} min — o worker ainda não pegou este trabalho.
          Verifique se o worker está rodando.
        </div>
      )}
      {runningStalled && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⏳ Rodando sem atividade há {minsSince(lastActivityIso)} min — pode estar travado.
          A última atualização foi {dateFmt(lastActivityIso)}.
        </div>
      )}
      {running && lastEventIso && !runningStalled && (
        <p className="mb-5 text-xs text-gray-400">Última atividade: {dateFmt(lastActivityIso)}</p>
      )}

      {isPagina ? (
        <PageModeView
          investigationId={params.id}
          funnels={funnels}
          funnelSteps={funnelSteps}
          vsls={vsls}
          signed={signed}
          modeSteps={modeSteps}
          job={job}
          events={(events ?? []) as any}
          jobStatus={inv.status}
          running={running}
          noResult={noResult}
          noticeMotivo={inv.notice ?? null}
        />
      ) : (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        <StepBar
          investigationId={params.id}
          steps={modeSteps}
          completed={(job?.completed_steps ?? []) as string[]}
          current={job?.current_step ?? null}
          jobStatus={inv.status}
          lastError={job?.last_error ?? null}
          events={(events ?? []) as any}
        />

        <div className="space-y-5">
          {/* Candidatos avaliados — não se aplica ao modo página. */}
          {!isPagina && (
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
                      <th className="px-2">Melhor anúncio</th>
                      <th className="px-2">Plat.</th>
                      <th className="px-2">Países</th>
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
                          <td className="px-2 text-xs">
                            {m.bestAdDays != null || m.bestAdVersions != null ? (
                              <span className="tabular-nums">
                                {m.bestAdDays ?? '—'}d · {m.bestAdVersions ?? '—'} ver.
                              </span>
                            ) : (
                              <span className="text-gray-400">não coletado</span>
                            )}
                          </td>
                          <td className="px-2 text-xs">{ncLabel(m.distinctPlatforms)}</td>
                          <td className="px-2 text-xs">{ncLabel(m.distinctCountries)}</td>
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
          )}

          {!isPagina && (
          <h2 className="text-lg font-semibold">
            {isAnunciante ? 'Anúncios escalados desta empresa' : 'Concorrentes selecionados'}
          </h2>
          )}
          {!isPagina && (cands.length === 0 ? (
            <div className="card text-sm text-gray-500">
              {running
                ? 'Processando… os anúncios campeões aparecem aqui ao final do pipeline.'
                : isAnunciante
                  ? 'Nenhum anúncio próprio foi encontrado para esta empresa.'
                  : 'Nenhum concorrente com evidência forte foi selecionado.'}
            </div>
          ) : (
            cands.map((c) => {
              const rank: Record<string, number> = { alto: 3, medio: 2, baixo: 1 };
              // Criativos ordenados pelo nível de evidência do anúncio (vencedores primeiro).
              const ccrs = crs
                .filter((x) => x.candidate_id === c.id)
                .sort(
                  (a, b) =>
                    (rank[adById.get(b.ad_id)?.nivel_evidencia] ?? 0) -
                    (rank[adById.get(a.ad_id)?.nivel_evidencia] ?? 0),
                );
              const ev = c.evidence ?? {};
              return (
                <div key={c.id} className="card">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">{c.name}</h3>
                      {c.domain && <p className="text-sm text-gray-500">{c.domain}</p>}
                    </div>
                    <div className="text-right">
                      <span className="badge bg-brand-soft text-brand">
                        Evidência {EVIDENCE_PT[c.evidence_level] ?? c.evidence_level}
                      </span>
                      <div className="mt-2">
                        <a
                          className="btn-ghost text-xs"
                          href={`/api/investigations/${params.id}/media.zip?candidate=${c.id}`}
                        >
                          Baixar todas as mídias (.zip)
                        </a>
                      </div>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-2 text-xs text-gray-600">
                    <Evi label="Dias no ar" value={ev.daysLive} />
                    <Evi label="Plataformas" value={zeroAsNC(ev.distinctPlatforms)} />
                    <Evi label="Variações" value={ev.maxVariations} />
                    <Evi label="Países" value={zeroAsNC(ev.distinctCountries)} />
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
                      const a = adById.get(cr.ad_id);
                      return (
                        <div key={cr.id} className="rounded-lg border border-gray-200 p-3">
                          <div className="mb-2 flex items-center justify-between text-xs">
                            <span className="badge bg-gray-100 text-gray-700">{cr.media_type}</span>
                            <span className="text-gray-400">{cr.status}</span>
                          </div>

                          {/* Selo de evidência + motivo + rótulos informativos do anúncio */}
                          <div className="mb-2">
                            <EvidenceSelo nivel={a?.nivel_evidencia ?? null} ativo={a?.is_active} />
                            {a?.motivo && <p className="mt-1 text-xs text-gray-600">{a.motivo}</p>}
                            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-gray-500">
                              {/* 0 plataformas/países = não medido → "não coletado" */}
                              <AdLabel label="plataformas" value={a?.platforms?.length || undefined} />
                              <AdLabel label="países" value={a?.countries?.length || undefined} />
                              <AdLabel label="formato" value={cr.media_type} />
                              <AdLabel label="CTA" value={a?.cta_text || undefined} />
                            </div>
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

                          {/* Download individual */}
                          <div className="mt-2">
                            {cr.storage_path ? (
                              <a
                                className="btn-ghost w-full text-center text-xs"
                                href={`/api/creatives/${cr.id}/download`}
                              >
                                {cr.media_type === 'video' ? 'Baixar vídeo' : 'Baixar imagem'}
                              </a>
                            ) : (
                              <span className="block w-full cursor-not-allowed rounded border border-gray-200 py-1 text-center text-xs text-gray-400">
                                mídia indisponível
                              </span>
                            )}
                          </div>

                          <div className="mt-2 space-y-2">
                            {cr.media_type === 'video' && (
                              <Expandable title="Transcrição">
                                {temNarracao(cr.transcription) ? (
                                  <p className="whitespace-pre-wrap">{cr.transcription}</p>
                                ) : (
                                  <p className="text-gray-500">{SEM_NARRACAO_MSG}</p>
                                )}
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
          ))}

          {/* ── Funil: captura e análise de páginas ── */}
          <div className="card">
            <h2 className="mb-1 text-lg font-semibold">Funil ({funnels.length})</h2>
            <p className="mb-3 text-xs text-gray-500">
              Páginas de destino capturadas como visitante de celular no Brasil (só conteúdo
              público; paramos no checkout, sem comprar nem preencher dados).
            </p>
            {funnels.length === 0 ? (
              <p className="text-sm text-gray-500">
                {running
                  ? 'Processando… o funil aparece ao final da captura.'
                  : 'Nenhum funil capturado ainda.'}
              </p>
            ) : (
              funnels.map((f) => (
                <FunnelCard
                  key={f.id}
                  funnel={f}
                  steps={funnelSteps.filter((s) => s.funnel_id === f.id)}
                  vsls={vsls.filter((v) => v.funnel_id === f.id)}
                  signed={signed}
                  candidateName={f.candidate_id ? candNameById.get(f.candidate_id) ?? null : null}
                />
              ))
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MODO PÁGINA — abas: Resumo · Páginas do funil · VSL · Exportar
// ─────────────────────────────────────────────────────────────
function PageModeView({
  investigationId,
  funnels,
  funnelSteps,
  vsls,
  signed,
  modeSteps,
  job,
  events,
  jobStatus,
  running,
  noResult,
  noticeMotivo,
}: {
  investigationId: string;
  funnels: any[];
  funnelSteps: any[];
  vsls: any[];
  signed: Map<string, string>;
  modeSteps: any[];
  job: any;
  events: any[];
  jobStatus: string;
  running: boolean;
  noResult: boolean;
  noticeMotivo: string | null;
}) {
  const primary = funnels.find((f) => f.status === 'concluida') ?? funnels[0] ?? null;
  const tech = primary?.tech ?? {};
  const pixels: { tipo: string; id: string | null }[] = primary?.pixels ?? tech.pixels ?? [];
  const videosDetectados = (primary?.manifests ?? tech.manifests ?? []).length;
  const vslResumo = (vsls.find((v) => v.analysis?.resumo)?.analysis?.resumo) ?? {};
  const NC = () => <span className="text-gray-400">não coletado</span>;

  const resumo = (
    <div className="space-y-5">
      {noResult && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ Concluída sem resultado — {noticeMotivo ?? 'nenhuma página do funil foi capturada.'}
        </div>
      )}
      <div className="card">
        <h2 className="mb-3 text-lg font-semibold">Resumo</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Item label="Checkout" value={primary?.checkout_platform} />
          <Item label="Player de vídeo" value={primary?.video_player} />
          <Item label="Vídeos detectados" value={videosDetectados || undefined} />
          <Item label="Pixels" value={pixels.length || undefined} />
          <Item label="Preço" value={vslResumo.preco} />
          <Item label="Garantia" value={vslResumo.garantia} />
        </dl>
        <div className="mt-3 border-t border-gray-100 pt-3 text-sm">
          <span className="font-medium">Promessa: </span>
          {vslResumo.bigIdea || vslResumo.diferencial ? (
            <span>{vslResumo.bigIdea ?? vslResumo.diferencial}</span>
          ) : (
            <NC />
          )}
        </div>
      </div>

      <StepBar
        investigationId={investigationId}
        steps={modeSteps}
        completed={(job?.completed_steps ?? []) as string[]}
        current={job?.current_step ?? null}
        jobStatus={jobStatus}
        lastError={job?.last_error ?? null}
        events={events}
      />
    </div>
  );

  const paginas = (
    <div className="space-y-3">
      {funnelSteps.length === 0 ? (
        <div className="card text-sm text-gray-500">
          {running ? 'Processando… as páginas aparecem ao final da captura.' : 'Nenhuma página capturada.'}
        </div>
      ) : (
        funnelSteps.map((s) => <FunnelStepCard key={s.id} step={s} signed={signed} />)
      )}
    </div>
  );

  const vslTab = (
    <div className="space-y-4">
      {vsls.length === 0 ? (
        <div className="card text-sm text-gray-500">
          {running ? 'Processando… a VSL aparece após o download e a transcrição.' : 'Nenhuma VSL encontrada no funil.'}
        </div>
      ) : (
        vsls.map((v) => <VslBlock key={v.id} vsl={v} signed={signed} investigationId={investigationId} />)
      )}
    </div>
  );

  const exportar = (
    <div className="card space-y-3 text-sm">
      <h2 className="text-lg font-semibold">Exportar</h2>
      <ExportRow
        href={`/api/investigations/${investigationId}/export?format=md`}
        label="Exportar .md"
        desc="Relatório em texto (Markdown): resumo, páginas do funil e mapeamento da VSL em 11 blocos."
      />
      <ExportRow
        href={`/api/investigations/${investigationId}/export?format=csv`}
        label="Exportar .csv"
        desc="Planilha com uma linha por página/VSL e seus campos (tipo, preço, checkout, player, etc.)."
      />
      <ExportRow
        href={`/api/investigations/${investigationId}/media.zip`}
        label="Baixar tudo (.zip)"
        desc="Prints, HTML e texto limpo de cada página (pasta paginas/), análise de cada passo e áudio/vídeo da VSL (pasta vsl/)."
      />
    </div>
  );

  return (
    <Tabs
      tabs={[
        { id: 'resumo', label: 'Resumo', content: resumo },
        { id: 'paginas', label: 'Páginas do funil', content: paginas },
        { id: 'vsl', label: 'VSL', content: vslTab },
        { id: 'exportar', label: 'Exportar', content: exportar },
      ]}
    />
  );
}

function Item({ label, value }: { label: string; value: unknown }) {
  const empty = value == null || value === '';
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={empty ? 'text-gray-400' : 'font-medium'}>{empty ? 'não coletado' : String(value)}</dd>
    </div>
  );
}

function ExportRow({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gray-100 pb-3 last:border-0 last:pb-0">
      <p className="text-gray-600">{desc}</p>
      <a className="btn-ghost shrink-0" href={href}>
        {label}
      </a>
    </div>
  );
}

// Um cartão por passo do funil: tipo, URL, miniatura pequena (clique abre o
// print inteiro) e a "Análise da página" aberta por padrão. Técnicos recolhidos.
function FunnelStepCard({ step, signed }: { step: any; signed: Map<string, string> }) {
  const shot = step.screenshot_path ? signed.get(step.screenshot_path) : null;
  const a = step.analysis ?? {};
  const tipo = a.tipo ?? step.step_type;
  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="badge bg-gray-100 text-gray-700">
          {step.step_order + 1}. {tipo ? STEP_TYPE_PT[tipo] ?? tipo : 'não coletado'}
        </span>
        {step.blocked && <span className="badge bg-amber-100 text-amber-800">possível bloqueio</span>}
      </div>
      <p className="mb-2 break-all text-[11px] text-gray-400">{step.url}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_1fr]">
        {shot ? (
          // Miniatura de altura fixa; abre o print inteiro em tela cheia.
          // eslint-disable-next-line @next/next/no-img-element
          <a href={shot} target="_blank" rel="noreferrer" className="block">
            <img alt="print do passo" className="h-28 w-full rounded border border-gray-200 object-cover object-top" src={shot} />
            <span className="mt-1 block text-center text-[11px] text-gray-400">abrir print</span>
          </a>
        ) : (
          <div className="flex h-28 items-center justify-center rounded border border-gray-200 bg-gray-50 text-[11px] text-gray-400">
            sem print
          </div>
        )}
        <div className="space-y-2">
          <Expandable title="Análise da página" defaultOpen>
            <dl className="space-y-1 text-xs">
              {(
                [
                  ['Headline', a.headline],
                  ['Promessa', a.promessa],
                  ['Mecanismo', a.mecanismo],
                  ['Prova', a.prova],
                  ['Oferta', a.oferta],
                  ['Preço', a.preco],
                  ['Bônus', a.bonus],
                  ['Garantia', a.garantia],
                  ['Urgência', a.urgencia],
                  ['CTA', a.cta],
                ] as [string, unknown][]
              ).map(([k, v]) => (
                <div key={k}>
                  <span className="font-medium">{k}:</span>{' '}
                  {v == null || v === '' ? <span className="text-gray-400">não coletado</span> : String(v)}
                </div>
              ))}
            </dl>
          </Expandable>
          <Expandable title="Detalhes técnicos">
            <div className="text-xs text-gray-500">
              {step.load_ms != null && <div>Tempo de carga: {step.load_ms} ms</div>}
              {step.html_path && <div className="break-all">HTML salvo: {step.html_path}</div>}
              {step.text_path && <div className="break-all">Texto limpo salvo: {step.text_path}</div>}
            </div>
          </Expandable>
        </div>
      </div>
    </div>
  );
}

const STEP_TYPE_PT: Record<string, string> = {
  pre_sell: 'Pré-sell',
  lp: 'Landing page',
  quiz: 'Quiz',
  vsl: 'VSL',
  checkout: 'Checkout',
  upsell: 'Upsell',
  obrigado: 'Obrigado',
  outro: 'Outro',
};

function FunnelCard({
  funnel,
  steps,
  vsls,
  signed,
  candidateName,
}: {
  funnel: any;
  steps: any[];
  vsls: any[];
  signed: Map<string, string>;
  candidateName: string | null;
}) {
  const tech = funnel.tech ?? {};
  const pixels: { tipo: string; id: string | null }[] = funnel.pixels ?? tech.pixels ?? [];
  const manifests: string[] = funnel.manifests ?? tech.manifests ?? [];
  const samePixel: { id: string; domain: string }[] = tech.samePixelOtherDomain ?? [];
  return (
    <div className="mb-4 rounded-lg border border-gray-200 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {candidateName ? `${candidateName} · ` : ''}
            <span className="break-all text-gray-600">{funnel.entry_url}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-gray-500">
            <AdLabel label="checkout" value={funnel.checkout_platform || undefined} />
            <AdLabel label="player" value={funnel.video_player || undefined} />
            <AdLabel label="pixels" value={pixels.length || undefined} />
          </div>
        </div>
        {funnel.blocked && (
          <span className="badge bg-amber-100 text-amber-800">possível bloqueio</span>
        )}
      </div>

      {(pixels.length > 0 || manifests.length > 0 || samePixel.length > 0) && (
        <div className="mb-3 space-y-1 text-xs text-gray-600">
          {pixels.length > 0 && (
            <div>
              <span className="font-medium">Pixels:</span>{' '}
              {pixels.map((p) => `${p.tipo}${p.id ? ` (${p.id})` : ''}`).join(', ')}
            </div>
          )}
          {samePixel.length > 0 && (
            <div className="text-amber-700">
              ⚠️ Mesmo pixel em outro domínio: {samePixel.map((x) => `${x.id} → ${x.domain}`).join(', ')}
            </div>
          )}
          {manifests.length > 0 && (
            <div>
              <span className="font-medium">Vídeos detectados:</span> {manifests.length}
            </div>
          )}
        </div>
      )}

      {/* Timeline de passos */}
      <ol className="space-y-3">
        {steps.map((s) => {
          const shot = s.screenshot_path ? signed.get(s.screenshot_path) : null;
          const a = s.analysis ?? {};
          const tipo = a.tipo ?? s.step_type;
          return (
            <li key={s.id} className="rounded border border-gray-100 p-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="badge bg-gray-100 text-gray-700">
                  {s.step_order + 1}. {tipo ? STEP_TYPE_PT[tipo] ?? tipo : 'não coletado'}
                </span>
                <span className="text-gray-400">{s.load_ms != null ? `${s.load_ms} ms` : ''}</span>
              </div>
              <p className="mb-2 break-all text-[11px] text-gray-400">{s.url}</p>
              {s.blocked && (
                <span className="badge mb-2 bg-amber-100 text-amber-800">possível bloqueio</span>
              )}
              {shot && (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="print do passo" className="mb-2 w-full rounded border border-gray-200" src={shot} />
              )}
              <Expandable title="Análise da página">
                <dl className="space-y-1 text-xs">
                  {(
                    [
                      ['Headline', a.headline],
                      ['Promessa', a.promessa],
                      ['Mecanismo', a.mecanismo],
                      ['Prova', a.prova],
                      ['Oferta', a.oferta],
                      ['Preço', a.preco],
                      ['Bônus', a.bonus],
                      ['Garantia', a.garantia],
                      ['Urgência', a.urgencia],
                      ['CTA', a.cta],
                    ] as [string, unknown][]
                  ).map(([k, v]) => (
                    <div key={k}>
                      <span className="font-medium">{k}:</span>{' '}
                      {v == null || v === '' ? (
                        <span className="text-gray-400">não coletado</span>
                      ) : (
                        String(v)
                      )}
                    </div>
                  ))}
                </dl>
              </Expandable>
            </li>
          );
        })}
      </ol>

      {/* VSLs do funil */}
      {vsls.map((v) => (
        <VslBlock key={v.id} vsl={v} signed={signed} />
      ))}
    </div>
  );
}

const VSL_STATUS_PT: Record<string, string> = {
  concluida: 'Concluída',
  concluida_com_problemas: 'Concluída com problemas',
  parcial: 'Transcrição parcial',
  midia_indisponivel: 'Mídia indisponível',
  longa_demais: 'VSL longa demais',
  falhou: 'Falhou',
  rodando: 'Processando…',
  pendente: 'Pendente',
};

const VSL_STATUS_STYLE: Record<string, string> = {
  concluida: 'bg-green-100 text-green-700',
  concluida_com_problemas: 'bg-amber-100 text-amber-800',
  parcial: 'bg-amber-100 text-amber-800',
  midia_indisponivel: 'bg-gray-100 text-gray-600',
  longa_demais: 'bg-amber-100 text-amber-800',
  falhou: 'bg-red-100 text-red-700',
  rodando: 'bg-blue-100 text-blue-700',
  pendente: 'bg-gray-100 text-gray-600',
};

function fmtSec(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function VslBlock({
  vsl,
  signed,
  investigationId,
}: {
  vsl: any;
  signed: Map<string, string>;
  investigationId?: string;
}) {
  const audio = vsl.audio_path ? signed.get(vsl.audio_path) : null;
  const video = vsl.video_path ? signed.get(vsl.video_path) : null;
  const a = vsl.analysis ?? {};
  const resumo = a.resumo ?? {};
  const blocos: any[] = a.blocos ?? [];
  const ok = vsl.status === 'concluida' || vsl.status === 'parcial' || vsl.status === 'concluida_com_problemas';
  const substeps: VslSubstep[] = vsl.substeps ?? [];
  // "Refazer só o mapeamento" só faz sentido se há transcrição salva.
  const canRemap = !!investigationId && !!vsl.transcription;
  const NC = () => <span className="text-gray-400">não coletado</span>;
  return (
    <div className="mt-3 rounded-lg border border-brand/30 bg-brand-soft/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="badge bg-brand-soft text-brand">VSL</span>
        <span className={`badge ${VSL_STATUS_STYLE[vsl.status] ?? 'bg-gray-100 text-gray-600'}`}>
          {VSL_STATUS_PT[vsl.status] ?? vsl.status}
        </span>
        {vsl.duration_seconds != null && (
          <span className="text-xs text-gray-400">· {fmtSec(Number(vsl.duration_seconds))}</span>
        )}
        {canRemap && (
          <span className="ml-auto">
            <RemapVslButton investigationId={investigationId!} />
          </span>
        )}
      </div>

      {/* Status por sub-etapa: download, áudio, transcrição, mapeamento. */}
      {substeps.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2 text-[11px]">
          {substeps.map((s) => (
            <li
              key={s.etapa}
              className={`rounded px-1.5 py-0.5 ${s.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
              title={s.motivo ?? undefined}
            >
              {s.ok ? '✓' : '✕'} {VSL_SUBSTEP_PT[s.etapa] ?? s.etapa}
              {s.motivo ? <span className="text-gray-500"> · {s.motivo}</span> : ''}
            </li>
          ))}
        </ul>
      )}
      {vsl.status === 'falhou' && vsl.fail_reason && (
        <p className="mb-2 text-xs text-red-600">{vsl.fail_reason}</p>
      )}

      {/* Avisos */}
      <div className="mb-2 flex flex-wrap gap-1">
        {vsl.status === 'midia_indisponivel' && (
          <span className="badge bg-gray-100 text-gray-600">mídia indisponível{vsl.fail_reason ? `: ${vsl.fail_reason}` : ''}</span>
        )}
        {vsl.status === 'longa_demais' && (
          <span className="badge bg-amber-100 text-amber-800">VSL longa demais para o limite</span>
        )}
        {vsl.partial && <span className="badge bg-amber-100 text-amber-800">transcrição parcial</span>}
        {vsl.approx_timestamps && ok && (
          <span className="badge bg-gray-100 text-gray-600">timestamps aproximados</span>
        )}
      </div>

      {/* Player */}
      {video ? (
        <video controls className="mb-3 w-full rounded" src={video} />
      ) : audio ? (
        <audio controls className="mb-3 w-full" src={audio} />
      ) : null}

      {ok && (
        <>
          {/* Resumo executivo */}
          <h4 className="mb-1 text-sm font-semibold text-gray-600">Resumo executivo</h4>
          <dl className="mb-3 space-y-1 text-xs">
            {(
              [
                ['Big Idea', resumo.bigIdea],
                ['Mecanismo', resumo.mecanismo],
                ['Oferta', resumo.oferta],
                ['Preço', resumo.preco],
                ['Garantia', resumo.garantia],
                ['Emoção dominante', resumo.emocaoDominante],
                ['Vilão', resumo.vilao],
                ['Diferencial', resumo.diferencial],
              ] as [string, unknown][]
            ).map(([k, val]) => (
              <div key={k}>
                <span className="font-medium">{k}:</span> {val == null || val === '' ? <NC /> : String(val)}
              </div>
            ))}
            {resumo.stack && (
              <div>
                <span className="font-medium">Stack:</span> itens: {resumo.stack.itens?.join(', ') || '—'}; bônus:{' '}
                {resumo.stack.bonus?.join(', ') || '—'}; valor alegado: {resumo.stack.valorAlegado ?? '—'}
              </div>
            )}
          </dl>

          {a.parcialAviso && <p className="mb-2 text-xs text-amber-700">⚠️ {a.parcialAviso}</p>}

          {/* Tabela dos 11 blocos */}
          {blocos.length > 0 && (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-gray-500">
                    <th className="py-1 pr-2">Bloco</th>
                    <th className="px-2">Tempo</th>
                    <th className="px-2">Nota</th>
                    <th className="px-2">Análise / citações</th>
                  </tr>
                </thead>
                <tbody>
                  {blocos.map((b) => (
                    <tr key={b.bloco} className="border-b border-gray-100 align-top">
                      <td className="py-1 pr-2">
                        {b.bloco} {b.nome} {b.presente ? '' : '—'}
                      </td>
                      <td className="px-2 tabular-nums">
                        {b.presente ? `${b.inicio ?? '—'}–${b.fim ?? '—'}` : '—'}
                      </td>
                      <td className="px-2 tabular-nums">{b.nota ?? '—'}</td>
                      <td className="px-2 text-gray-600">
                        {b.presente ? (
                          <>
                            {b.analise ?? <NC />}
                            {(b.citacoes ?? []).length > 0 && (
                              <ul className="mt-1 list-disc pl-4 text-gray-500">
                                {b.citacoes.map((c: string, i: number) => (
                                  <li key={i}>“{c}”</li>
                                ))}
                              </ul>
                            )}
                          </>
                        ) : (
                          <NC />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {vsl.transcription && (
            <Expandable title="Transcrição completa">
              <p className="whitespace-pre-wrap text-xs">{vsl.transcription}</p>
            </Expandable>
          )}
        </>
      )}
    </div>
  );
}

// Exibe número; 0/ausente vira "não coletado" (0 só quando medido de fato).
function zeroAsNC(v: number | null | undefined): string {
  return v == null || v === 0 ? 'não coletado' : String(v);
}
function ncLabel(v: number | null | undefined) {
  return v == null || v === 0 ? (
    <span className="text-gray-400">não coletado</span>
  ) : (
    <span className="tabular-nums">{v}</span>
  );
}

function EvidenceSelo({ nivel, ativo }: { nivel: string | null; ativo?: boolean }) {
  const style: Record<string, string> = {
    alto: 'bg-green-100 text-green-800',
    medio: 'bg-amber-100 text-amber-800',
    baixo: 'bg-gray-100 text-gray-600',
  };
  const labelPt: Record<string, string> = { alto: 'Alto', medio: 'Médio', baixo: 'Baixo' };
  if (!nivel) return <span className="badge bg-gray-100 text-gray-400">evidência não coletada</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`badge ${style[nivel] ?? 'bg-gray-100 text-gray-600'}`}>
        Evidência {labelPt[nivel] ?? nivel}
      </span>
      {ativo === false && <span className="badge bg-gray-100 text-gray-500">parado</span>}
    </span>
  );
}

function AdLabel({ label, value }: { label: string; value: unknown }) {
  const txt =
    value == null || value === '' ? 'não coletado' : typeof value === 'number' ? String(value) : String(value);
  return (
    <span className="rounded bg-gray-100 px-1.5 py-0.5">
      {label}: <span className={value == null || value === '' ? 'text-gray-400' : 'text-gray-700'}>{txt}</span>
    </span>
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
