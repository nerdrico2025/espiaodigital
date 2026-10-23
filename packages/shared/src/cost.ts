import { DEFAULT_LIMITS, PRICE_REFERENCE, type InvestigationLimits } from './config';
import type { CostEntry, InvestigationMode } from './types';

/**
 * Estimativa de custo ANTES de iniciar (mostrada na tela).
 * Usa os limites para projetar o pior caso razoável.
 *
 * - 'concorrentes': descoberta (EXA + LLM) + Apify para N candidatos.
 * - 'anunciante': SEM descoberta; Apify só para a empresa informada (1 candidato).
 */
export function estimateInvestigationCost(
  competitors: number,
  limits: InvestigationLimits = DEFAULT_LIMITS,
  mode: InvestigationMode = 'concorrentes',
): { total: number; entries: CostEntry[] } {
  const p = PRICE_REFERENCE;
  const entries: CostEntry[] = [];

  // Nº de empresas pesquisadas no Apify e analisadas.
  const alvos = mode === 'anunciante' ? 1 : limits.maxCandidates;
  const analisados = mode === 'anunciante' ? 1 : competitors;

  if (mode === 'concorrentes') {
    // EXA: ~4 buscas de intenção comercial (só na descoberta).
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
  }

  // Apify: 2 chamadas por alvo (busca por marca + busca pela página dona),
  // cada uma até adsPerCandidate anúncios.
  const apifyCallsPerCandidate = 2;
  const apifyAds = alvos * limits.adsPerCandidate * apifyCallsPerCandidate;
  entries.push({
    provider: 'apify',
    unit: 'ad',
    quantity: apifyAds,
    estimatedUsd: apifyAds * p.apifyPerAdUsd,
    note: mode === 'anunciante'
      ? '2 chamadas (marca + página) para a empresa'
      : '2 chamadas/candidato (marca + página)',
  });

  // Transcrição: limite de minutos.
  entries.push({
    provider: 'transcription',
    unit: 'minuto',
    quantity: limits.maxTranscribedMinutes,
    estimatedUsd: limits.maxTranscribedMinutes * p.whisperPerMinuteUsd,
  });

  // Análise LLM: criativos campeões por alvo analisado.
  const analyzed = analisados * limits.championCreativesMax;
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
