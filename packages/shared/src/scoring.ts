import {
  ACTION_CTAS,
  AD_EVIDENCE_THRESHOLDS,
  EVIDENCE_LEVEL_CUTOFFS,
  NEARLY_THRESHOLDS,
  SCORING_THRESHOLDS,
  SCORING_WEIGHTS,
} from './config';
import type {
  AdEvidence,
  CandidateMetrics,
  CandidateScore,
  CandidateVerdict,
  EvidenceBreakdown,
  EvidenceLevel,
  NormalizedAd,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export const LEVEL_RANK: Record<EvidenceLevel, number> = { alto: 3, medio: 2, baixo: 1 };

export function isActionCta(cta: string | null | undefined): boolean {
  if (!cta) return false;
  const norm = stripAccents(cta.trim().toLowerCase());
  return ACTION_CTAS.some((c) => norm === c || norm.includes(c));
}

/** Dias no ar de um anúncio (usa endDate quando inativo, senão agora). */
export function adDaysLive(ad: NormalizedAd, now = Date.now()): number | null {
  if (!ad.startDate) return null;
  const end = ad.endDate ?? now;
  const days = Math.floor((end - ad.startDate) / DAY_MS);
  return days >= 0 ? days : 0;
}

// ── Evidência POR ANÚNCIO ────────────────────────────────────

/** Destino normalizado (domínio + path) do linkUrl, para clusterizar por oferta. */
function normDest(linkUrl: string | null | undefined): string | null {
  if (!linkUrl) return null;
  try {
    const raw = /^https?:\/\//i.test(linkUrl) ? linkUrl : `https://${linkUrl}`;
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return host + path;
  } catch {
    return null;
  }
}

/** Texto-base normalizado (minúsculo, sem acento/pontuação), truncado — proxy de similaridade. */
function normText(t: string | null | undefined): string {
  if (!t) return '';
  return stripAccents(t.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/** Chave de cluster: destino (domínio+path) ou, na falta, texto-base muito parecido. */
function clusterKeyOf(ad: NormalizedAd): string {
  const d = normDest(ad.linkUrl);
  if (d) return `dest:${d}`;
  const tx = normText(ad.bodyText);
  if (tx) return `text:${tx}`;
  return `ad:${ad.adArchiveId}`;
}

/** Nível de evidência de um anúncio a partir de dias no ar e versões. */
export function adEvidenceLevel(diasNoAr: number | null, versoes: number): EvidenceLevel {
  const th = AD_EVIDENCE_THRESHOLDS;
  const d = diasNoAr ?? 0;
  if (d >= th.highMinDays && versoes >= th.highMinVersions) return 'alto';
  if (
    (d >= th.highMinDays && versoes >= 1 && versoes < th.highMinVersions) ||
    (d >= th.midMinDays && d < th.highMinDays && versoes >= th.highMinVersions)
  ) {
    return 'medio';
  }
  return 'baixo';
}

/** Motivo em PT simples. Dado ausente aparece como "não coletado", nunca suposto. */
function adMotivo(ad: NormalizedAd, dias: number | null, versoes: number, ativo: boolean): string {
  const parts: string[] = [];
  if (dias == null) parts.push('dias no ar não coletado');
  else parts.push(ativo ? `ativo há ${dias} dias` : `parado (${dias} dias no ar)`);
  parts.push(`${versoes} ${versoes === 1 ? 'versão' : 'versões parecidas'}`);
  if (ad.platforms?.length)
    parts.push(`${ad.platforms.length} plataforma${ad.platforms.length === 1 ? '' : 's'}`);
  if (ad.countries?.length)
    parts.push(`${ad.countries.length} ${ad.countries.length === 1 ? 'país' : 'países'}`);
  return parts.join(', ');
}

export interface AdWithEvidence {
  ad: NormalizedAd;
  ev: AdEvidence;
}

/**
 * Calcula a evidência de cada anúncio de UM anunciante. As versões vêm de
 * clusters por destino (domínio+path) e/ou texto-base muito parecido.
 * Mantém a ordem de entrada (para casar com as linhas persistidas).
 */
export function computeAdEvidences(ads: NormalizedAd[], now = Date.now()): AdWithEvidence[] {
  const keyById = new Map<string, string>();
  const sizeByKey = new Map<string, number>();
  for (const ad of ads) {
    const k = clusterKeyOf(ad);
    keyById.set(ad.adArchiveId, k);
    sizeByKey.set(k, (sizeByKey.get(k) ?? 0) + 1);
  }
  return ads.map((ad) => {
    const clusterId = keyById.get(ad.adArchiveId) ?? `ad:${ad.adArchiveId}`;
    const versoes = sizeByKey.get(clusterId) ?? 1;
    const diasNoAr = adDaysLive(ad, now);
    const ativo = !!ad.isActive;
    const nivel = adEvidenceLevel(diasNoAr, versoes);
    return { ad, ev: { diasNoAr, versoes, ativo, nivel, motivo: adMotivo(ad, diasNoAr, versoes, ativo), clusterId } };
  });
}

/** Ordena anúncios por nível, depois dias no ar, depois versões (melhor primeiro). */
export function compareAdEvidence(a: AdEvidence, b: AdEvidence): number {
  if (LEVEL_RANK[b.nivel] !== LEVEL_RANK[a.nivel]) return LEVEL_RANK[b.nivel] - LEVEL_RANK[a.nivel];
  const da = a.diasNoAr ?? -1;
  const db = b.diasNoAr ?? -1;
  if (db !== da) return db - da;
  return b.versoes - a.versoes;
}

export interface CandidateAdSummary {
  /** Anúncios com evidência, ordenados (melhor primeiro). */
  evidences: AdWithEvidence[];
  hasHigh: boolean;
  hasMedium: boolean;
  best: AdWithEvidence | null;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

/** Resume os anúncios de um anunciante no nível do anúncio. */
export function summarizeCandidateAds(ads: NormalizedAd[], now = Date.now()): CandidateAdSummary {
  const evidences = computeAdEvidences(ads, now).sort((a, b) => compareAdEvidence(a.ev, b.ev));
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  for (const e of evidences) {
    if (e.ev.nivel === 'alto') highCount++;
    else if (e.ev.nivel === 'medio') mediumCount++;
    else lowCount++;
  }
  return {
    evidences,
    hasHigh: highCount > 0,
    hasMedium: mediumCount > 0,
    best: evidences[0] ?? null,
    highCount,
    mediumCount,
    lowCount,
  };
}

/**
 * Agrega evidência de todos os anúncios de um candidato.
 * - daysLive: maior tempo no ar entre os anúncios
 * - distinctPlatforms: máximo de plataformas simultâneas num anúncio
 * - maxVariations: maior nº de variações
 * - distinctCountries: total de países distintos
 */
export function buildEvidence(ads: NormalizedAd[], now = Date.now()): EvidenceBreakdown {
  let daysLive: number | null = null;
  let distinctPlatforms = 0;
  let maxVariations = 0;
  const countries = new Set<string>();
  let hasVideo = false;
  let hasActionCta = false;

  for (const ad of ads) {
    const d = adDaysLive(ad, now);
    if (d !== null) daysLive = daysLive === null ? d : Math.max(daysLive, d);

    distinctPlatforms = Math.max(distinctPlatforms, new Set(ad.platforms).size);
    maxVariations = Math.max(maxVariations, ad.variations || 0);
    for (const c of ad.countries) countries.add(c.toUpperCase());
    if (ad.videos.length > 0) hasVideo = true;
    if (isActionCta(ad.ctaText)) hasActionCta = true;
  }

  return {
    daysLive,
    distinctPlatforms,
    maxVariations,
    distinctCountries: countries.size,
    hasVideo,
    hasActionCta,
  };
}

export function levelForScore(score: number): EvidenceLevel {
  if (score >= EVIDENCE_LEVEL_CUTOFFS.alto) return 'alto';
  if (score >= EVIDENCE_LEVEL_CUTOFFS.medio) return 'medio';
  return 'baixo';
}

/** Pontua um candidato a partir dos seus anúncios. Lógica da seção 3. */
export function scoreCandidate(ads: NormalizedAd[], now = Date.now()): CandidateScore {
  const ev = buildEvidence(ads, now);
  const w = SCORING_WEIGHTS;
  const t = SCORING_THRESHOLDS;
  let score = 0;
  const reasons: string[] = [];

  if (ev.daysLive !== null) {
    if (ev.daysLive > 60) {
      score += w.daysOver60;
      reasons.push(`No ar há mais de 60 dias (${ev.daysLive}d) [+${w.daysOver60}]`);
    } else if (ev.daysLive >= 30) {
      score += w.days30to60;
      reasons.push(`No ar entre 30 e 60 dias (${ev.daysLive}d) [+${w.days30to60}]`);
    }
  }

  if (ev.distinctPlatforms >= 4) {
    score += w.platforms4plus;
    reasons.push(`${ev.distinctPlatforms} plataformas simultâneas [+${w.platforms4plus}]`);
  }

  if (ev.maxVariations >= t.variationsForPoints) {
    score += w.variations3plus;
    const scaled = ev.maxVariations >= t.scaledVariations ? ' — escalado' : '';
    reasons.push(`${ev.maxVariations} variações de texto${scaled} [+${w.variations3plus}]`);
  }

  if (ev.distinctCountries >= 2) {
    score += w.countries2plus;
    reasons.push(`${ev.distinctCountries} países [+${w.countries2plus}]`);
  }

  if (ev.hasVideo) {
    score += w.video;
    reasons.push(`Usa formato vídeo [+${w.video}]`);
  }

  if (ev.hasActionCta) {
    score += w.actionCta;
    reasons.push(`CTA de ação [+${w.actionCta}]`);
  }

  const passesStrong =
    ev.daysLive !== null &&
    ev.daysLive >= t.strongMinDays &&
    ev.maxVariations >= t.strongMinVariations;

  return { score, reasons, level: levelForScore(score), passesStrong, evidence: ev };
}

/**
 * Classifica um candidato para a seção "Candidatos avaliados" (tela/export).
 * Critério NO NÍVEL DO ANÚNCIO:
 * - "Selecionado": tem ≥1 anúncio de evidência ALTA.
 * - "Quase lá": sem alto, mas com ≥1 de evidência MÉDIA.
 * - "Não selecionado": o resto.
 * Investigações antigas (sem evidência por anúncio) caem no fallback por
 * dias/variações agregados; dado ausente nunca vira suposição.
 */
export function classifyCandidate(
  m: Partial<CandidateMetrics>,
  selected: boolean,
): CandidateVerdict {
  const t = SCORING_THRESHOLDS;
  const n = NEARLY_THRESHOLDS;
  const adsCollected = m.adsCollected;
  const days = m.daysLive ?? null;
  const variations = m.maxVariations ?? 0;
  const limit = m.adsPerCandidateLimit ?? 0;

  // Sem anúncios próprios: só sabemos quando a métrica foi persistida.
  if (m.noOwnAds === true || adsCollected === 0) {
    return {
      status: 'nao',
      label: 'Não selecionado',
      reason: 'nenhum anúncio próprio encontrado',
      smallSample: false,
    };
  }

  // Caminho novo: níveis por anúncio (quando a evidência por anúncio existe).
  if (m.bestAdLevel != null) {
    const best = m.bestAdReason ? `melhor anúncio: ${m.bestAdReason}` : 'melhor anúncio avaliado';
    const atLimit = m.sampleAtLimit === true;
    if (m.hasHigh) return { status: 'selecionado', label: 'Selecionado', reason: best, smallSample: atLimit };
    if (m.hasMedium) return { status: 'quase', label: 'Quase lá', reason: best, smallSample: atLimit };
    return { status: 'nao', label: 'Não selecionado', reason: best, smallSample: atLimit };
  }

  // ── Fallback (investigações antigas, sem evidência por anúncio) ──
  // Amostra pequena: coletou algo, porém ≤ o limite por candidato.
  const smallSample =
    limit > 0 && typeof adsCollected === 'number' && adsCollected > 0 && adsCollected <= limit;

  if (selected) {
    const parts: string[] = [];
    if (days != null) parts.push(`${days} dia${days === 1 ? '' : 's'} no ar`);
    parts.push(`${variations} variaç${variations === 1 ? 'ão' : 'ões'}`);
    return {
      status: 'selecionado',
      label: 'Selecionado',
      reason: `evidência forte: ${parts.join(' e ')}`,
      smallSample: false,
    };
  }

  // Caso especial: muito tempo no ar, mas poucas variações (1–2).
  // Costuma ser amostra pequena — vale subir "Anúncios por candidato".
  const longRunningFewVar =
    days != null && days >= 60 && variations >= 1 && variations < t.strongMinVariations;
  if (longRunningFewVar) {
    return {
      status: 'quase',
      label: 'Quase lá',
      reason: 'muito tempo no ar, poucas variações (pode ser amostra pequena)',
      smallSample,
    };
  }

  // Motivos de não atingir evidência forte (30+ dias E 3+ variações).
  const faltas: string[] = [];
  if (days == null) faltas.push('sem data de veiculação');
  else if (days < t.strongMinDays) faltas.push(`só ${days} dia${days === 1 ? '' : 's'} no ar`);
  if (variations < t.strongMinVariations)
    faltas.push(`apenas ${variations} variaç${variations === 1 ? 'ão' : 'ões'}`);

  let reason = faltas.join(' e ') || 'evidência insuficiente';
  if (smallSample) {
    reason += `; amostra pequena: só ${adsCollected} anúncio${adsCollected === 1 ? '' : 's'} coletado${adsCollected === 1 ? '' : 's'}`;
  }

  const nearly = days != null && days >= n.minDays && variations >= n.minVariations;
  return {
    status: nearly ? 'quase' : 'nao',
    label: nearly ? 'Quase lá' : 'Não selecionado',
    reason,
    smallSample,
  };
}

export interface RankedCandidate<T> {
  candidate: T;
  ads: NormalizedAd[];
  score: CandidateScore;
}

export interface SelectionResult<T> {
  selected: RankedCandidate<T>[];
  /** Quantos candidatos foram pedidos. */
  requested: number;
  /** Quantos realmente passaram no critério de evidência forte. */
  qualified: number;
  /** Quantos faltaram para atingir o pedido. */
  shortBy: number;
  /** Mensagem honesta para a tela. */
  notice: string | null;
}

/**
 * Seleciona os N melhores que também passam no critério de evidência forte.
 * NUNCA completa a lista com candidatos fracos; avisa quantos faltaram.
 */
export function selectScaled<T>(
  ranked: RankedCandidate<T>[],
  requested: number,
  now = Date.now(),
): SelectionResult<T> {
  void now;
  const qualifiedList = ranked
    .filter((r) => r.score.passesStrong)
    .sort((a, b) => b.score.score - a.score.score);

  const selected = qualifiedList.slice(0, requested);
  const qualified = qualifiedList.length;
  const shortBy = Math.max(0, requested - qualified);

  let notice: string | null = null;
  if (shortBy > 0) {
    notice =
      `Apenas ${qualified} de ${requested} anunciantes têm anúncio de evidência ALTA ` +
      `(30+ dias no ar E 3+ versões). Faltaram ${shortBy}. ` +
      `Mostrando só os que passaram — a lista NÃO foi completada com candidatos fracos.`;
  }

  return { selected, requested, qualified, shortBy, notice };
}
