import {
  resolveLimits,
  STEP_ORDER,
  selectScaled,
  buildEvidence,
  computeAdEvidences,
  summarizeCandidateAds,
  adDaysLive,
  temNarracao,
  SEM_NARRACAO_MSG,
  detectFunnelTech,
  funnelDestKey,
  funnelDomain,
  parseInvestigationMode,
  stepsForMode,
  round,
  type InvestigationLimits,
  type InvestigationMode,
  type NormalizedAd,
  type RequestLog,
  type StepName,
  type VslSegment,
} from '@espiao/shared';
import type { AdRow, CandidateRow, Deps } from '../interfaces.js';
import { filterOwnAds, mostFrequentPageId } from './normalize.js';

/** Normaliza uma referência (URL ou nome) para comparação: host sem www, minúsculo. */
function normalizeRef(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

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
  mode: InvestigationMode;
  /** Texto de referência (query) — usado para excluir a própria empresa dos candidatos. */
  reference: string;
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
    mode: parseInvestigationMode(inv.mode), // erro explícito se vier modo inválido
    reference: inv.query,
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
    capturar_funil: stepCapturarFunil,
    processar_vsl: stepProcessarVsl,
  };

  // Só as etapas que se aplicam ao modo (página pula descoberta/ads).
  const steps = stepsForMode(ctx.mode);

  try {
    for (const step of steps) {
      await ensureActive(deps, investigationId); // cancelamento entre etapas
      if (done.has(step)) {
        log.info(`Pulando etapa já concluída: ${step}`);
        continue;
      }
      await runStep(deps, investigationId, step, () => impls[step](deps, ctx));
    }
  } catch (e) {
    if (e instanceof CancelledError) {
      log.info(`Investigação ${investigationId} cancelada — mantendo o que já foi coletado.`);
      return; // não marca concluída nem falhou; status já é 'cancelada'
    }
    throw e;
  }

  await db.setInvestigationStatus(investigationId, 'concluida');
  log.info(`Investigação ${investigationId} concluída.`);
}

/** Erro sinalizando cancelamento — não deve marcar a etapa como "falhou". */
export class CancelledError extends Error {
  constructor() {
    super('investigação cancelada');
    this.name = 'CancelledError';
  }
}

/** Lança CancelledError se a investigação foi marcada como 'cancelada'. */
async function ensureActive(deps: Deps, investigationId: string): Promise<void> {
  if (await deps.db.isCancelled(investigationId)) throw new CancelledError();
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
    if (e instanceof CancelledError) throw e; // cancelamento: não marca falhou
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

  // Modo "pagina": análise direta de uma página/VSL — sem candidatos/anúncios.
  // As etapas de ads ficam vazias naturalmente; só "capturar_funil" trabalha.
  if (ctx.mode === 'pagina') {
    await deps.db.addEvent(
      ctx.investigationId,
      'descobrir',
      'rodando',
      `Modo "analisar página": sem descoberta; captura direta de ${inv.query.trim()}.`,
    );
    return { modo: 'pagina', candidatos: 0 };
  }

  // Modo "anunciante": NÃO há descoberta. A empresa informada é o único candidato.
  if (ctx.mode === 'anunciante') {
    const raw = inv.query.trim();
    const isUrl = /^https?:\/\//i.test(raw) || /\.[a-z]{2,}($|\/)/i.test(raw);
    const domain = isUrl ? normalizeRef(raw) : null;
    const name = domain ? domain.replace(/\.[a-z.]+$/i, '') : raw;
    await deps.db.insertCandidates(ctx.investigationId, [
      {
        id: 'anunciante',
        name: name || raw,
        domain,
        facebookPage: null,
        offerType: null,
        source: 'anunciante (empresa informada)',
      },
    ]);
    await deps.db.addEvent(
      ctx.investigationId,
      'descobrir',
      'rodando',
      `Modo "analisar anunciante": sem descoberta; analisando "${name || raw}" como empresa única.`,
    );
    return { modo: 'anunciante', candidatos: 1 };
  }

  const { candidates, cost } = await deps.discovery.discover(inv, {
    min: ctx.limits.minCandidates,
    max: ctx.limits.maxCandidates,
  });

  // Exclui a própria referência da lista de concorrentes (best-effort por
  // domínio/nome); ela aparece na tela só como "Referência".
  const ref = normalizeRef(inv.query);
  const refRoot = ref.split('.')[0];
  const filtered = candidates.filter((c) => {
    const cd = normalizeRef(c.domain);
    const cn = (c.name ?? '').trim().toLowerCase();
    if (ref && (cd === ref || cn === ref)) return false;
    if (ref.includes('.') && cd && cd.split('.')[0] === refRoot) return false;
    return true;
  });
  const excluidos = candidates.length - filtered.length;

  await deps.db.insertCandidates(ctx.investigationId, filtered);
  for (const c of cost) await deps.db.addCost(ctx.investigationId, c);
  if (excluidos > 0) {
    await deps.db.addEvent(
      ctx.investigationId,
      'descobrir',
      'rodando',
      `Referência "${inv.query}" excluída da lista de concorrentes (${excluidos} removido(s)).`,
    );
  }
  return { modo: 'concorrentes', candidatos: filtered.length, referenciaExcluida: excluidos };
}

// ── 2. Buscar anúncios (Apify / Meta Ad Library) ─────────────
async function stepBuscarAds(deps: Deps, ctx: Ctx): Promise<unknown> {
  const candidates = await deps.db.getCandidates(ctx.investigationId);
  let totalAds = 0;
  let totalDescartados = 0;
  let semAnunciosProprios = 0;
  let falhas = 0;
  for (const candidate of candidates) {
    await ensureActive(deps, ctx.investigationId);
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

// ── 3. Pontuar (evidência POR ANÚNCIO) ───────────────────────
async function stepPontuar(deps: Deps, ctx: Ctx): Promise<unknown> {
  const now = deps.clock.now();
  const grouped = await deps.db.getAdsGrouped(ctx.investigationId);

  // Para cada candidato: evidência por anúncio (mesma ordem das linhas) +
  // resumo (melhor anúncio, tem alto/médio) + evidência agregada (rótulos).
  const ranked = grouped.map((g) => {
    const adsN: NormalizedAd[] = g.ads.map((a) => a.ad);
    const evid = computeAdEvidences(adsN, now); // mesma ordem de g.ads
    const summary = summarizeCandidateAds(adsN, now);
    const evidence = buildEvidence(adsN, now);
    const adsCollected = g.ads.length;
    const score = summary.highCount * 100 + summary.mediumCount * 10 + summary.lowCount;
    const level: 'alto' | 'medio' | 'baixo' = summary.best ? summary.best.ev.nivel : 'baixo';
    return { candidate: g.candidate, adRows: g.ads, evid, summary, evidence, adsCollected, score, level };
  });

  // Persiste evidência por anúncio + score/métricas de TODOS (selected=false).
  for (const r of ranked) {
    for (let i = 0; i < r.adRows.length; i++) {
      const row = r.adRows[i];
      const e = r.evid[i];
      if (row && e) await deps.db.updateAdEvidence(row.id, e.ev);
    }
    const best = r.summary.best;
    await deps.db.updateCandidateScore(r.candidate.id, {
      score: r.score,
      level: r.level,
      reasons: best ? [best.ev.motivo] : [],
      evidence: r.evidence,
      selected: false,
      selectionReason: null,
      metrics: {
        ...r.evidence,
        adsCollected: r.adsCollected,
        noOwnAds: r.adsCollected === 0,
        adsPerCandidateLimit: ctx.limits.adsPerCandidate,
        hasHigh: r.summary.hasHigh,
        hasMedium: r.summary.hasMedium,
        bestAdLevel: best ? best.ev.nivel : null,
        bestAdDays: best ? best.ev.diasNoAr : null,
        bestAdVersions: best ? best.ev.versoes : null,
        bestAdReason: best ? best.ev.motivo : '',
        sampleAtLimit: r.adsCollected > 0 && r.adsCollected >= ctx.limits.adsPerCandidate,
      },
    });
  }

  // Modo "anunciante": a empresa é sempre analisada (gera campeões/mídia).
  if (ctx.mode === 'anunciante') {
    for (const r of ranked) {
      if (r.adRows.length === 0) continue;
      const best = r.summary.best;
      await deps.db.updateCandidateScore(r.candidate.id, {
        score: r.score,
        level: r.level,
        reasons: best ? [best.ev.motivo] : [],
        evidence: r.evidence,
        selected: true,
        selectionReason: `Empresa analisada (modo anunciante). Melhor anúncio: ${best?.ev.motivo ?? 'não coletado'}.`,
      });
    }
    const analisados = ranked.filter((r) => r.adRows.length > 0).length;
    const notice = analisados === 0 ? 'Nenhum anúncio próprio encontrado para a empresa informada.' : null;
    await deps.db.setInvestigationStatus(ctx.investigationId, 'rodando', { notice });
    return { modo: 'anunciante', analisados, aviso: notice };
  }

  // Modo "concorrentes": Selecionado = tem ≥1 anúncio de evidência ALTA.
  const sel = selectScaled(
    ranked.map((r) => ({
      candidate: r.candidate,
      ads: r.adRows.map((a) => a.ad),
      score: {
        score: r.score,
        reasons: r.summary.best ? [r.summary.best.ev.motivo] : [],
        level: r.level,
        passesStrong: r.summary.hasHigh, // "forte" = tem anúncio de evidência alta
        evidence: r.evidence,
      },
    })),
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
      selectionReason: `Tem anúncio de evidência ALTA. Melhor anúncio: ${s.score.reasons[0] ?? 'não coletado'}.`,
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
// Campeões = top anúncios de evidência ALTA do anunciante, na ordem do nível →
// dias no ar → versões. No modo "anunciante", se houver menos de
// championCreativesMin de nível alto, completa com os melhores seguintes
// (médio/baixo). Os limites de vídeos/minutos são respeitados adiante.
async function stepEscolherCriativos(deps: Deps, ctx: Ctx): Promise<unknown> {
  const selected = await deps.db.getSelectedCandidatesWithAds(ctx.investigationId);
  const now = deps.clock.now();
  let videoBudget = ctx.limits.maxVideosPerInvestigation;
  let criativos = 0;

  for (const { ads } of selected) {
    const champions = pickChampions(ads, ctx.limits, ctx.mode, now);
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

function pickChampions(
  ads: AdRow[],
  limits: InvestigationLimits,
  mode: InvestigationMode,
  now: number,
): AdRow[] {
  const byArchive = new Map(ads.map((a) => [a.ad.adArchiveId, a]));
  const summary = summarizeCandidateAds(ads.map((a) => a.ad), now);

  // Prioridade: anúncios de evidência ALTA (já na ordem nível→dias→versões).
  let chosen = summary.evidences.filter((e) => e.ev.nivel === 'alto');

  // Modo anunciante: se faltam altos, completa com os melhores seguintes.
  if (mode === 'anunciante' && chosen.length < limits.championCreativesMin) {
    for (const e of summary.evidences) {
      if (chosen.length >= limits.championCreativesMin) break;
      if (!chosen.includes(e)) chosen.push(e);
    }
  }

  const take = Math.max(limits.championCreativesMax, 0);
  return chosen
    .slice(0, take)
    .map((e) => byArchive.get(e.ad.adArchiveId))
    .filter((a): a is AdRow => Boolean(a));
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
      // Vídeo sem fala: registra na análise (sem inventar narração).
      const analysis = { ...r.analysis } as typeof r.analysis & {
        semNarracao?: boolean;
        narracaoObs?: string;
      };
      if (cr.mediaType === 'video' && !temNarracao(cr.transcription)) {
        analysis.semNarracao = true;
        analysis.narracaoObs = SEM_NARRACAO_MSG;
      }
      await deps.db.updateCreative(cr.id, { analysis, status: 'analisado' });
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

// ── 9. Capturar funil (páginas de destino) ───────────────────
async function stepCapturarFunil(deps: Deps, ctx: Ctx): Promise<unknown> {
  const inv = await deps.db.getInvestigation(ctx.investigationId);
  const maxSteps = ctx.limits.funnelMaxSteps;
  const pageCap = ctx.limits.funnelPagesPerInvestigation;

  // Monta a lista de alvos (url + candidato + anúncio), deduplicada por destino.
  type Target = { url: string; candidateId: string | null; adId: string | null };
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (url: string | null, candidateId: string | null, adId: string | null) => {
    if (!url) return;
    const key = funnelDestKey(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    targets.push({ url, candidateId, adId });
  };

  if (ctx.mode === 'pagina') {
    add(inv.query.trim(), null, null);
  } else {
    const champions = await deps.db.getChampionAds(ctx.investigationId);
    for (const a of champions) {
      if (targets.length >= pageCap) break;
      add(a.ad.linkUrl, a.candidateId, a.id);
    }
  }
  const limited = targets.slice(0, pageCap);

  let capturados = 0;
  let falhas = 0;
  let capIndex = 0;
  const pixelIndex = await deps.db.getFunnelPixelIndex();

  for (const t of limited) {
    await ensureActive(deps, ctx.investigationId);
    capIndex++;
    const domain = funnelDomain(t.url);
    // Progresso visível na tela (polling lê o último job_event desta etapa).
    await deps.db.addEvent(
      ctx.investigationId,
      'capturar_funil',
      'rodando',
      `Capturando página ${capIndex} de ${limited.length}${domain ? ` (${domain})` : ''}…`,
    );
    const { id: funnelId } = await deps.db.insertFunnel({
      investigationId: ctx.investigationId,
      candidateId: t.candidateId,
      adId: t.adId,
      entryUrl: t.url,
      domain,
    });

    try {
      const { steps } = await deps.funnel.capture(t.url, { maxSteps, country: ctx.country });
      const allReq: RequestLog[] = [];
      const htmlParts: string[] = [];
      let anyBlocked = false;

      for (const s of steps) {
        const base = `${ctx.investigationId}/funnel/${funnelId}/${s.order}`;
        let screenshotPath: string | null = null;
        let htmlPath: string | null = null;
        let textPath: string | null = null;
        if (s.screenshot) {
          screenshotPath = `${base}.png`;
          await deps.db.uploadMedia(screenshotPath, s.screenshot, 'image/png');
        }
        if (s.html) {
          htmlPath = `${base}.html`;
          await deps.db.uploadMedia(htmlPath, s.html, 'text/html; charset=utf-8');
          htmlParts.push(s.html);
        }
        if (s.text) {
          textPath = `${base}.md`;
          await deps.db.uploadMedia(textPath, s.text, 'text/markdown; charset=utf-8');
        }
        for (const r of s.requests) allReq.push(r);
        if (s.blocked) anyBlocked = true;

        // Análise LLM do passo (dado ausente = null; não inventa).
        let analysis = null;
        try {
          const a = await deps.analyzer.analyzeFunnelStep({
            url: s.url,
            text: s.text,
            stepTypeGuess: s.stepTypeGuess,
          });
          analysis = a.analysis;
          for (const c of a.cost) await deps.db.addCost(ctx.investigationId, c);
        } catch (e) {
          deps.log.warn(`Análise de passo falhou (funil ${funnelId})`, errMessage(e));
        }

        await deps.db.insertFunnelStep({
          funnelId,
          investigationId: ctx.investigationId,
          order: s.order,
          stepType: analysis?.tipo ?? s.stepTypeGuess ?? null,
          url: s.url,
          screenshotPath,
          htmlPath,
          textPath,
          requests: s.requests.slice(0, 200),
          analysis,
          blocked: s.blocked,
          loadMs: s.loadMs,
        });
      }

      // Detecção técnica (determinística) + flag de pixel em outro domínio.
      const tech = detectFunnelTech(allReq, htmlParts.join('\n'));
      const otherDomain = tech.pixels
        .filter((p) => p.id)
        .flatMap((p) =>
          pixelIndex
            .filter((x) => x.id === p.id && x.domain !== domain)
            .map((x) => ({ id: p.id!, domain: x.domain })),
        );
      if (otherDomain.length) tech.samePixelOtherDomain = otherDomain;
      // Alimenta o índice para os próximos funis desta mesma execução.
      for (const p of tech.pixels) if (p.id && domain) pixelIndex.push({ id: p.id, domain });

      await deps.db.updateFunnel(funnelId, {
        status: 'concluida',
        checkoutPlatform: tech.checkoutPlatform,
        videoPlayer: tech.videoPlayer,
        pixels: tech.pixels,
        manifests: tech.manifests,
        tech,
        blocked: anyBlocked,
      });
      capturados++;
    } catch (e) {
      falhas++;
      await deps.db.updateFunnel(funnelId, { status: 'falhou', blocked: true });
      await deps.db.addEvent(
        ctx.investigationId,
        'capturar_funil',
        'rodando',
        `⚠️ Funil "${t.url}" falhou: ${errMessage(e)}`,
      );
      deps.log.warn(`Captura de funil falhou (${t.url})`, errMessage(e));
    }
    await sleep(1200); // pausa curta entre capturas
  }

  // Atualiza o custo final incluindo os passos de funil (consolidar roda antes).
  const total = await deps.db.getCostTotal(ctx.investigationId);
  await deps.db.setFinalCost(ctx.investigationId, round(total));

  return { funis: limited.length, capturados, falhas };
}

// ── 10. Processar VSL (download + transcrição + mapeamento) ──
async function stepProcessarVsl(deps: Deps, ctx: Ctx): Promise<unknown> {
  const targets = await deps.db.getVslTargets(ctx.investigationId);
  const list = targets.slice(0, ctx.limits.vslPerInvestigation);
  let minuteBudget = ctx.limits.vslTranscribedMinutes;
  let processadas = 0;
  let falhas = 0;
  let longas = 0;
  let vslIndex = 0;

  for (const t of list) {
    await ensureActive(deps, ctx.investigationId);
    vslIndex++;
    // Progresso visível na tela.
    await deps.db.addEvent(
      ctx.investigationId,
      'processar_vsl',
      'rodando',
      `Baixando VSL ${vslIndex} de ${list.length}…`,
    );
    const { id: vslId } = await deps.db.insertVsl({
      investigationId: ctx.investigationId,
      funnelId: t.funnelId,
      funnelStepId: t.funnelStepId,
      sourceUrl: t.url,
      player: t.player,
      manifestUrl: t.manifestUrl,
    });

    try {
      const r = await deps.vsl.extract({
        pageUrl: t.url,
        manifestUrl: t.manifestUrl,
        player: t.player,
        maxMinutes: ctx.limits.vslMaxMinutes,
      });

      if (r.tooLong) {
        longas++;
        await deps.db.updateVsl(vslId, {
          status: 'longa_demais',
          failReason: r.failReason ?? 'VSL longa demais para o limite',
          durationSeconds: r.durationSeconds,
          manifestUrl: r.manifestUrl,
        });
        continue;
      }
      if (!r.ok || !r.audioPath) {
        falhas++;
        await deps.db.updateVsl(vslId, {
          status: 'midia_indisponivel',
          failReason: r.failReason ?? 'mídia indisponível',
          manifestUrl: r.manifestUrl,
        });
        continue;
      }

      // Sobe o áudio (sempre) e o vídeo reduzido (quando ≤150MB).
      const audioStorage = `${ctx.investigationId}/vsl/${vslId}.mp3`;
      await deps.db.uploadMediaFromPath(audioStorage, r.audioPath, 'audio/mpeg');
      let videoStorage: string | null = null;
      if (r.videoPath) {
        videoStorage = `${ctx.investigationId}/vsl/${vslId}.mp4`;
        await deps.db.uploadMediaFromPath(videoStorage, r.videoPath, 'video/mp4');
      }

      // Transcreve trecho a trecho, respeitando o teto de minutos de VSL.
      const segments: VslSegment[] = [];
      const missing: number[] = [];
      let provider: string | null = null;
      let partial = false;
      let chIndex = 0;
      for (const ch of r.chunks) {
        // Cancelamento entre trechos: salva o parcial já transcrito e para.
        if (await deps.db.isCancelled(ctx.investigationId)) {
          partial = true;
          break;
        }
        chIndex++;
        const chMin = ch.durationSec / 60;
        if (minuteBudget - chMin < 0) {
          partial = true;
          missing.push(ch.offsetSec);
          continue;
        }
        // Progresso visível na tela.
        await deps.db.addEvent(
          ctx.investigationId,
          'processar_vsl',
          'rodando',
          `Transcrevendo trecho ${chIndex} de ${r.chunks.length}…`,
        );
        try {
          const tr = await deps.transcriber.transcribe({ audioPath: ch.path, durationSeconds: ch.durationSec });
          provider = tr.provider;
          for (const c of tr.cost) {
            await deps.db.addCost(ctx.investigationId, { ...c, unit: 'minuto-vsl' });
          }
          segments.push({
            start: ch.offsetSec,
            end: ch.offsetSec + ch.durationSec,
            text: tr.text,
            approx: true, // tempo estimado pelo deslocamento do trecho
          });
          minuteBudget -= chMin;
        } catch (e) {
          partial = true;
          missing.push(ch.offsetSec);
          deps.log.warn(`Trecho de VSL falhou (vsl ${vslId}, offset ${ch.offsetSec}s)`, errMessage(e));
        }
      }

      const transcription = segments.map((s) => s.text).join('\n').trim();
      if (!transcription) {
        falhas++;
        await deps.db.updateVsl(vslId, {
          status: 'midia_indisponivel',
          failReason: 'não foi possível transcrever nenhum trecho',
          audioPath: audioStorage,
          videoPath: videoStorage,
          videoBytes: r.videoBytes,
          durationSeconds: r.durationSeconds,
          manifestUrl: r.manifestUrl,
        });
        continue;
      }

      // Mapeia a VSL em 11 blocos + resumo (citações validadas na transcrição).
      let analysis: unknown = null;
      try {
        const a = await deps.analyzer.analyzeVsl({ transcription, segments, parcial: partial });
        analysis = a.analysis;
        for (const c of a.cost) await deps.db.addCost(ctx.investigationId, c);
      } catch (e) {
        deps.log.warn(`Mapeamento de VSL falhou (vsl ${vslId})`, errMessage(e));
      }

      await deps.db.updateVsl(vslId, {
        status: partial ? 'parcial' : 'concluida',
        durationSeconds: r.durationSeconds,
        audioPath: audioStorage,
        videoPath: videoStorage,
        videoBytes: r.videoBytes,
        transcription,
        segments,
        approxTimestamps: true,
        partial,
        missingChunks: missing,
        transcriptionProvider: provider,
        analysis,
        manifestUrl: r.manifestUrl,
      });
      processadas++;
    } catch (e) {
      falhas++;
      await deps.db.updateVsl(vslId, { status: 'falhou', failReason: errMessage(e) });
      await deps.db.addEvent(
        ctx.investigationId,
        'processar_vsl',
        'rodando',
        `⚠️ VSL "${t.url}" falhou: ${errMessage(e)}`,
      );
      deps.log.warn(`VSL falhou (${t.url})`, errMessage(e));
    }
    await sleep(1500); // uma VSL por vez, pausa curta entre downloads
  }

  const total = await deps.db.getCostTotal(ctx.investigationId);
  await deps.db.setFinalCost(ctx.investigationId, round(total));
  return { alvos: list.length, processadas, falhas, longas };
}

// ── helpers ──────────────────────────────────────────────────
function unique(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
