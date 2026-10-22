import { DEFAULT_LIMITS, PRICE_REFERENCE, type InvestigationLimits } from './config';
import type { CostEntry } from './types';

/**
 * Estimativa de custo ANTES de iniciar (mostrada na tela).
 * Usa os limites para projetar o pior caso razoável.
 */
export function estimateInvestigationCost(
  competitors: number,
  limits: InvestigationLimits = DEFAULT_LIMITS,
): { total: number; entries: CostEntry[] } {
  const p = PRICE_REFERENCE;
  const entries: CostEntry[] = [];

  // EXA: ~4 buscas de intenção comercial.
  const exaSearches = 4;
  entries.push({
    provider: 'exa',
    unit: 'busca',
    quantity: exaSearches,
    estimatedUsd: exaSearches * p.exaPerSearchUsd,
  });

  // LLM descoberta: 1 chamada de extração.
  entries.push({
    provider: 'openrouter',
    unit: 'extracao-candidatos',
    quantity: 1,
    estimatedUsd: p.llmDiscoveryUsd,
  });

  // Apify: 2 chamadas por candidato (busca por marca + busca pela página dona),
  // cada uma até adsPerCandidate anúncios.
  const apifyCallsPerCandidate = 2;
  const apifyAds = limits.maxCandidates * limits.adsPerCandidate * apifyCallsPerCandidate;
  entries.push({
    provider: 'apify',
    unit: 'ad',
    quantity: apifyAds,
    estimatedUsd: apifyAds * p.apifyPerAdUsd,
    note: '2 chamadas/candidato (marca + página)',
  });

  // Transcrição: limite de minutos.
  entries.push({
    provider: 'transcription',
    unit: 'minuto',
    quantity: limits.maxTranscribedMinutes,
    estimatedUsd: limits.maxTranscribedMinutes * p.whisperPerMinuteUsd,
  });

  // Análise LLM: criativos campeões por concorrente selecionado.
  const analyzed = competitors * limits.championCreativesMax;
  entries.push({
    provider: 'openrouter',
    unit: 'analise-criativo',
    quantity: analyzed,
    estimatedUsd: analyzed * p.llmPerCreativeUsd,
  });

  const total = entries.reduce((s, e) => s + e.estimatedUsd, 0);
  return { total: round(total), entries };
}

export function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function sumCost(entries: CostEntry[]): number {
  return round(entries.reduce((s, e) => s + e.estimatedUsd, 0));
}
