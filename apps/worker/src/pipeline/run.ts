import {
  resolveLimits,
  STEP_ORDER,
  scoreCandidate,
  selectScaled,
  isActionCta,
  adDaysLive,
  round,
  type InvestigationLimits,
  type NormalizedAd,
  type StepName,
} from '@espiao/shared';
import type { AdRow, CandidateRow, Deps } from '../interfaces.js';
import { filterOwnAds, mostFrequentPageId } from './normalize.js';

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

interface Ctx {
  investigationId: string;
  limits: InvestigationLimits;
  country: string;
  onlyActive: boolean;
  competitors: number;
  // caminhos de áudio extraídos nesta execução (efêmero).
  audioPaths: Map<string, string>;
}

/**
 * Executa a investigação de ponta a ponta. Pula etapas já concluídas
 * (completed_steps) para suportar "refazer etapa" sem repetir trabalho.
 */
export async function runInvestigation(deps: Deps, investigationId: string): Promise<void> {
  const { db, log } = deps;
  const inv = await db.getInvestigation(investigationId);
  // Limites efetivos: config da investigação com fallback para DEFAULT_LIMITS.
  const limits = resolveLimits(inv.config);

  const ctx: Ctx = {
    investigationId,
    limits,
    country: inv.country,
    onlyActive: inv.onlyActive,
    competitors: inv.competitors,
    audioPaths: new Map(),
  };

  const done = new Set<StepName>(await db.getCompletedSteps(investigationId));
  log.info(`Investigação ${investigationId}: etapas já concluídas`, [...done]);

  const impls: Record<StepName, (d: Deps, c: Ctx) => Promise<unknown>> = {
    descobrir: stepDescobrir,
    buscar_ads: stepBuscarAds,
    pontuar: stepPontuar,
    escolher_criativos: stepEscolherCriativos,
    baixar_midia: stepBaixarMidia,
    transcrever: stepTranscrever,
    analisar: stepAnalisar,
    consolidar: stepConsolidar,
  };

  for (const step of STEP_ORDER) {
    if (done.has(step)) {
      log.info(`Pulando etapa já concluída: ${step}`);
      continue;
    }
    await runStep(deps, investigationId, step, () => impls[step](deps, ctx));
  }

  await db.setInvestigationStatus(investigationId, 'concluida');
  log.info(`Investigação ${investigationId} concluída.`);
}

async function runStep(
  deps: Deps,
  investigationId: string,
  step: StepName,
  fn: () => Promise<unknown>,
): Promise<void> {
  const { db, log } = deps;
  await db.setCurrentStep(investigationId, step);
  await db.addEvent(investigationId, step, 'rodando');
  log.info(`→ etapa ${step}`);
  try {
    const meta = await fn();
    await db.addEvent(investigationId, step, 'concluida', undefined, meta);
    await db.markStepCompleted(investigationId, step);
  } catch (e) {
    const msg = errMessage(e);
    log.error(`Etapa ${step} falhou`, msg);
    await db.addEvent(investigationId, step, 'falhou', msg);
    await db.setInvestigationStatus(investigationId, 'falhou');
    throw e;
  }
}

// ── 1. Descobrir candidatos ──────────────────────────────────
async function stepDescobrir(deps: Deps, ctx: Ctx): Promise<unknown> {
  const inv = await deps.db.getInvestigation(ctx.investigationId);
  const { candidates, cost } = await deps.discovery.discover(inv, {
    min: ctx.limits.minCandidates,
    max: ctx.limits.maxCandidates,
  });
  await deps.db.insertCandidates(ctx.investigationId, candidates);
  for (const c of cost) await deps.db.addCost(ctx.investigationId, c);
  return { candidatos: candidates.length };
}

// ── 2. Buscar anúncios (Apify / Meta Ad Library) ─────────────
async function stepBuscarAds(deps: Deps, ctx: Ctx): Promise<unknown> {
  const candidates = await deps.db.getCandidates(ctx.investigationId);
  let totalAds = 0;
  let totalDescartados = 0;
  let semAnunciosProprios = 0;
  let falhas = 0;
  for (const candidate of candidates) {
    try {
      const { ads, cost } = await deps.ads.fetchAds(candidate, {
        country: ctx.country,
        onlyActive: ctx.onlyActive,
        limit: ctx.limits.adsPerCandidate,
      });
      // Mantém só os anúncios DO candidato; descarta menções de terceiros.
      const { kept, discarded, matches } = filterOwnAds(ads, candidate);
      totalDescartados += discarded.length;

      if (kept.length === 0) {
        semAnunciosProprios++;
        const msg =
          `Candidato "${candidate.name}": nenhum anúncio próprio encontrado ` +
          `(${discarded.length} de terceiros descartados) — marcado como ` +
          `"sem anúncios próprios encontrados".`;
        await deps.db.addEvent(ctx.investigationId, 'buscar_ads', 'rodando', msg, {
          candidateId: candidate.id,
          kept: 0,
          discarded: discarded.length,
          status: 'sem_anuncios_proprios',
        });
        // Marca persistente no próprio candidato (não é selecionado depois).
        await deps.db.saveCandidateSummary(candidate.id, {
          summary: 'Sem anúncios próprios encontrados (apenas menções de terceiros na busca).',
          hookPatterns: [],
          anglePatterns: [],
        });
        deps.log.warn(`Sem anúncios próprios para ${candidate.name}`, {
          descartados: discarded.length,
        });
      } else {
        // 2ª chamada: busca pela PÁGINA dona. O pageId é votado dando prioridade
        // aos anúncios casados por nome/pageId (domínio só como fallback).
        const vote = mostFrequentPageId(matches);
        const pageId = vote.pageId;
        let base = kept;
        let segundaInfo = '';

        if (vote.split) {
          // Votos divididos: não faz a 2ª chamada; registra os candidatos.
          segundaInfo = `; 2ª chamada pulada — votos de pageId divididos (${vote.candidates.join(', ')})`;
          await deps.db.addEvent(
            ctx.investigationId,
            'buscar_ads',
            'rodando',
            `⚠️ "${candidate.name}": pageId indefinido (nenhum com >50% dos votos ` +
              `entre os mantidos por ${vote.from ?? 'n/d'}); 2ª chamada pulada. ` +
              `Candidatos: ${vote.candidates.join(', ')}. Mantidos os ${kept.length} da busca por marca.`,
            { candidateId: candidate.id, pageIdCandidates: vote.candidates, voteFrom: vote.from },
          );
          deps.log.warn(`pageId dividido para ${candidate.name}`, { candidates: vote.candidates });
        } else if (pageId) {
          try {
            const { ads: pageAds, cost: cost2 } = await deps.ads.fetchAdsByPage(pageId, {
              country: ctx.country,
              onlyActive: ctx.onlyActive,
              limit: ctx.limits.adsPerCandidate,
            });
            // Conta o custo das DUAS chamadas.
            for (const c of cost2) await deps.db.addCost(ctx.investigationId, c);
            if (pageAds.length > 0) {
              base = pageAds; // substitui a base de pontuação pela 2ª chamada.
              segundaInfo = `; 2ª chamada (página ${pageId}, voto por ${vote.from}): ${pageAds.length} anúncios (base de pontuação)`;
            } else {
              segundaInfo = `; 2ª chamada (página ${pageId}) sem anúncios — mantidos os ${kept.length} da busca por marca`;
              await deps.db.addEvent(
                ctx.investigationId,
                'buscar_ads',
                'rodando',
                `⚠️ "${candidate.name}": busca por página ${pageId} não retornou anúncios; mantendo ${kept.length} da busca por marca.`,
                { candidateId: candidate.id, pageId, segunda: 0 },
              );
            }
          } catch (e) {
            segundaInfo = `; 2ª chamada (página ${pageId}) falhou — mantidos os ${kept.length} da busca por marca`;
            await deps.db.addEvent(
              ctx.investigationId,
              'buscar_ads',
              'rodando',
              `⚠️ "${candidate.name}": busca por página ${pageId} falhou: ${errMessage(e)}; mantendo ${kept.length} da busca por marca.`,
              { candidateId: candidate.id, pageId },
            );
            deps.log.warn(`2ª chamada (página ${pageId}) falhou para ${candidate.name}`, errMessage(e));
          }
        }

        await deps.db.insertAds(ctx.investigationId, candidate.id, base);
        totalAds += base.length;
        await deps.db.addEvent(
          ctx.investigationId,
          'buscar_ads',
          'rodando',
          `Candidato "${candidate.name}": ${kept.length} próprios mantidos, ` +
            `${discarded.length} descartados (terceiros)${segundaInfo}.`,
          {
            candidateId: candidate.id,
            kept: kept.length,
            discarded: discarded.length,
            pageId: pageId ?? null,
            pageIdSplit: vote.split,
            scoringBase: base.length,
          },
        );
      }
      // Custo da 1ª chamada (busca por marca). O da 2ª é somado acima.
      for (const c of cost) await deps.db.addCost(ctx.investigationId, c);
    } catch (e) {
      falhas++;
      // Uma falha de candidato NÃO derruba a investigação.
      await deps.db.addEvent(
        ctx.investigationId,
        'buscar_ads',
        'rodando',
        `⚠️ Candidato "${candidate.name}" falhou: ${errMessage(e)}`,
      );
      deps.log.warn(`Apify falhou para ${candidate.name}`, errMessage(e));
    }
    await sleep(ctx.limits.apifyPauseMs);
  }
  return {
    candidatos: candidates.length,
    anuncios: totalAds,
    descartados: totalDescartados,
    semAnunciosProprios,
    falhas,
  };
}

// ── 3. Pontuar e filtrar escalados ───────────────────────────
async function stepPontuar(deps: Deps, ctx: Ctx): Promise<unknown> {
  const now = deps.clock.now();
  const grouped = await deps.db.getAdsGrouped(ctx.investigationId);

  const ranked = grouped.map((g) => {
    const ads: NormalizedAd[] = g.ads.map((a) => a.ad);
    return { candidate: g.candidate, ads: g.ads, score: scoreCandidate(ads, now) };
  });

  // Persiste score + métricas de avaliação de TODOS (selected=false por ora).
  for (const r of ranked) {
    const adsCollected = r.ads.length;
    await deps.db.updateCandidateScore(r.candidate.id, {
      score: r.score.score,
      level: r.score.level,
      reasons: r.score.reasons,
      evidence: r.score.evidence,
      selected: false,
      selectionReason: null,
      metrics: {
        ...r.score.evidence,
        adsCollected,
        noOwnAds: adsCollected === 0,
        adsPerCandidateLimit: ctx.limits.adsPerCandidate,
      },
    });
  }

  const sel = selectScaled(
    ranked.map((r) => ({ candidate: r.candidate, ads: r.ads.map((a) => a.ad), score: r.score })),
    ctx.competitors,
    now,
  );

  for (const s of sel.selected) {
    await deps.db.updateCandidateScore(s.candidate.id, {
      score: s.score.score,
      level: s.score.level,
      reasons: s.score.reasons,
      evidence: s.score.evidence,
      selected: true,
      selectionReason: `Evidência ${s.score.level}. ${s.score.reasons.join('; ')}`,
    });
  }

  await deps.db.setInvestigationStatus(ctx.investigationId, 'rodando', { notice: sel.notice });
  return {
    pedidos: sel.requested,
    qualificados: sel.qualified,
    faltaram: sel.shortBy,
    aviso: sel.notice,
  };
}

// ── 4. Escolher criativos campeões ───────────────────────────
async function stepEscolherCriativos(deps: Deps, ctx: Ctx): Promise<unknown> {
  const selected = await deps.db.getSelectedCandidatesWithAds(ctx.investigationId);
  const now = deps.clock.now();
  let videoBudget = ctx.limits.maxVideosPerInvestigation;
  let criativos = 0;

  for (const { ads } of selected) {
    const champions = pickChampions(ads, ctx.limits, now);
    await deps.db.markChampionAds(champions.map((a) => a.id));

    for (const adRow of champions) {
      const ad = adRow.ad;
      for (const v of ad.videos) {
        if (videoBudget <= 0) break;
        await deps.db.insertCreative({
          investigationId: ctx.investigationId,
          adId: adRow.id,
          candidateId: adRow.candidateId,
          mediaType: 'video',
          sourceUrl: v.url,
          previewUrl: v.previewUrl ?? null,
        });
        videoBudget--;
        criativos++;
      }
      for (const img of ad.images) {
        await deps.db.insertCreative({
          investigationId: ctx.investigationId,
          adId: adRow.id,
          candidateId: adRow.candidateId,
          mediaType: 'image',
          sourceUrl: img.url,
          previewUrl: img.previewUrl ?? null,
        });
        criativos++;
      }
    }
  }
  return { criativos, limiteVideos: ctx.limits.maxVideosPerInvestigation };
}

function pickChampions(ads: AdRow[], limits: InvestigationLimits, now: number): AdRow[] {
  const scored = ads
    .map((a) => ({ a, s: adChampionScore(a.ad, now) }))
    .sort((x, y) => {
      if (y.s !== x.s) return y.s - x.s;
      // desempate: mais antigo primeiro
      return (x.a.ad.startDate ?? Infinity) - (y.a.ad.startDate ?? Infinity);
    });
  const take = Math.min(limits.championCreativesMax, Math.max(limits.championCreativesMin, 0));
  return scored.slice(0, Math.min(take, scored.length)).map((x) => x.a);
}

function adChampionScore(ad: NormalizedAd, now: number): number {
  const days = adDaysLive(ad, now) ?? 0;
  return (
    (ad.variations || 0) * 2 +
    Math.min(days / 30, 6) +
    (ad.videos.length > 0 ? 2 : 0) +
    (isActionCta(ad.ctaText) ? 1 : 0)
  );
}

// ── 5. Baixar mídia ──────────────────────────────────────────
async function stepBaixarMidia(deps: Deps, ctx: Ctx): Promise<unknown> {
  const creatives = await deps.db.getCreatives(ctx.investigationId);
  let ok = 0;
  let indisponivel = 0;
  for (const cr of creatives) {
    if (cr.status !== 'pendente') continue;
    try {
      const r = await deps.media.download({
        investigationId: ctx.investigationId,
        creativeId: cr.id,
        mediaType: cr.mediaType,
        url: cr.sourceUrl,
        previewUrl: cr.previewUrl,
      });
      if (r.ok) {
        await deps.db.updateCreative(cr.id, {
          status: 'baixado',
          storagePath: r.storagePath,
          previewPath: r.previewPath,
          durationSeconds: r.durationSeconds ?? null,
          error: null,
        });
        if (r.localAudioPath) ctx.audioPaths.set(cr.id, r.localAudioPath);
        ok++;
      } else {
        await deps.db.updateCreative(cr.id, { status: 'midia_indisponivel', error: r.error ?? 'falha' });
        indisponivel++;
      }
    } catch (e) {
      await deps.db.updateCreative(cr.id, { status: 'midia_indisponivel', error: errMessage(e) });
      indisponivel++;
      deps.log.warn(`Download falhou (creative ${cr.id})`, errMessage(e));
    }
  }
  return { baixados: ok, indisponivel };
}

// ── 6. Transcrever vídeos ────────────────────────────────────
async function stepTranscrever(deps: Deps, ctx: Ctx): Promise<unknown> {
  const creatives = await deps.db.getCreatives(ctx.investigationId);
  let minuteBudget = ctx.limits.maxTranscribedMinutes;
  let transcritos = 0;
  let pulados = 0;
  let providerUsado: string | null = null;

  for (const cr of creatives) {
    if (cr.mediaType !== 'video') continue;
    if (cr.status === 'midia_indisponivel') continue;
    if (cr.transcription) continue;

    let audioPath = ctx.audioPaths.get(cr.id) ?? null;
    if (!audioPath) {
      // Retomada em processo novo: regerar o áudio baixando de novo.
      const r = await deps.media.download({
        investigationId: ctx.investigationId,
        creativeId: cr.id,
        mediaType: 'video',
        url: cr.sourceUrl,
        previewUrl: cr.previewUrl,
      });
      audioPath = r.localAudioPath ?? null;
    }
    if (!audioPath) {
      await deps.db.updateCreative(cr.id, { error: 'áudio indisponível para transcrição' });
      pulados++;
      continue;
    }

    const durMin = (cr.durationSeconds ?? 0) / 60;
    if (minuteBudget - durMin < 0) {
      await deps.db.updateCreative(cr.id, { status: 'transcricao_pulada_limite' });
      pulados++;
      continue;
    }

    try {
      const r = await deps.transcriber.transcribe({
        audioPath,
        durationSeconds: cr.durationSeconds,
        context: { brand: cr.candidateName, domain: cr.candidateDomain },
      });
      await deps.db.updateCreative(cr.id, {
        transcription: r.text,
        transcriptionProvider: r.provider,
        status: 'transcrito',
        error: null,
      });
      for (const c of r.cost) await deps.db.addCost(ctx.investigationId, c);
      minuteBudget -= durMin;
      transcritos++;
      providerUsado = r.provider;
    } catch (e) {
      await deps.db.updateCreative(cr.id, { error: `transcrição: ${errMessage(e)}` });
      deps.log.warn(`Transcrição falhou (creative ${cr.id})`, errMessage(e));
    }
  }
  return { transcritos, pulados, provider: providerUsado };
}

// ── 7. Analisar com IA ───────────────────────────────────────
async function stepAnalisar(deps: Deps, ctx: Ctx): Promise<unknown> {
  const creatives = await deps.db.getCreatives(ctx.investigationId);
  let analisados = 0;
  for (const cr of creatives) {
    if (cr.status === 'midia_indisponivel') continue;
    try {
      const r = await deps.analyzer.analyze({
        mediaType: cr.mediaType,
        bodyText: cr.adBodyText,
        title: cr.adTitle,
        ctaText: cr.adCtaText,
        transcription: cr.transcription,
        imageUrl: cr.mediaType === 'image' ? cr.sourceUrl : null,
        linkUrl: cr.adLinkUrl,
        context: { brand: cr.candidateName, domain: cr.candidateDomain },
      });
      await deps.db.updateCreative(cr.id, { analysis: r.analysis, status: 'analisado' });
      for (const c of r.cost) await deps.db.addCost(ctx.investigationId, c);
      analisados++;
    } catch (e) {
      await deps.db.updateCreative(cr.id, { error: `análise: ${errMessage(e)}` });
      deps.log.warn(`Análise falhou (creative ${cr.id})`, errMessage(e));
    }
  }
  return { analisados };
}

// ── 8. Consolidar ────────────────────────────────────────────
async function stepConsolidar(deps: Deps, ctx: Ctx): Promise<unknown> {
  const selected = await deps.db.getSelectedCandidatesWithAds(ctx.investigationId);
  const creatives = await deps.db.getCreatives(ctx.investigationId);

  for (const { candidate, ads } of selected) {
    const crs = creatives.filter((c) => c.candidateId === candidate.id);
    const hooks = unique(
      crs.map((c) => c.analysis?.hook ?? null).filter((x): x is string => !!x),
    );
    const angles = unique(
      crs.map((c) => (c.analysis?.angulo ?? null) as string | null).filter((x): x is string => !!x),
    );
    const daysLive = Math.max(0, ...ads.map((a) => adDaysLive(a.ad, deps.clock.now()) ?? 0));
    const maxVar = Math.max(0, ...ads.map((a) => a.ad.variations || 0));

    const summary =
      `${candidate.name}${candidate.domain ? ` (${candidate.domain})` : ''}: ` +
      `${ads.length} anúncios analisados, melhor tempo no ar ~${daysLive} dias, ` +
      `até ${maxVar} variações. Criativos com mídia: ${crs.length}. ` +
      (hooks.length ? `Hooks recorrentes: ${hooks.slice(0, 5).join(' | ')}. ` : '') +
      (angles.length ? `Ângulos: ${angles.join(', ')}.` : '');

    await deps.db.saveCandidateSummary(candidate.id, {
      summary,
      hookPatterns: hooks.slice(0, 10),
      anglePatterns: angles,
    });
  }

  const total = await deps.db.getCostTotal(ctx.investigationId);
  await deps.db.setFinalCost(ctx.investigationId, round(total));
  return { concorrentes: selected.length, custoUsd: round(total) };
}

// ── helpers ──────────────────────────────────────────────────
function unique(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
