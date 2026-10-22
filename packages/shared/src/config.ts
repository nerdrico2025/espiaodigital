// ─────────────────────────────────────────────────────────────
// Config de pontuação e limites. Fácil de editar num só lugar.
// Regras conforme a seção 3 do briefing.
// ─────────────────────────────────────────────────────────────

export interface ScoringWeights {
  daysOver60: number; // > 60 dias no ar
  days30to60: number; // entre 30 e 60 dias
  platforms4plus: number; // 4+ plataformas simultâneas
  variations3plus: number; // 3+ variações de texto para o mesmo destino
  countries2plus: number; // 2+ países
  video: number; // formato vídeo
  actionCta: number; // CTA de ação
}

export const SCORING_WEIGHTS: ScoringWeights = {
  daysOver60: 5,
  days30to60: 3,
  platforms4plus: 4,
  variations3plus: 3,
  countries2plus: 4,
  video: 2,
  actionCta: 2,
};

export const SCORING_THRESHOLDS = {
  /** "Escalado" de verdade a partir de 5+ variações. */
  scaledVariations: 5,
  /** Variações mínimas para a regra de pontuação de variações. */
  variationsForPoints: 3,
  /** Dias mínimos para evidência forte. */
  strongMinDays: 30,
  /** Variações mínimas para evidência forte. */
  strongMinVariations: 3,
};

/** Níveis de evidência por faixa de score. */
export const EVIDENCE_LEVEL_CUTOFFS = {
  alto: 12,
  medio: 7,
};

/** CTAs considerados "de ação". Normalizados (lowercase, sem acento). */
export const ACTION_CTAS = [
  'saiba mais',
  'comprar',
  'comprar agora',
  'instalar',
  'instalar agora',
  'baixar',
  'cadastre-se',
  'inscreva-se',
  'assine',
  'assine ja',
  'experimente',
  'comece agora',
  'solicitar',
  'fale conosco',
  'enviar mensagem',
  'reserve',
  'contratar',
  // Variantes EN que a Ad Library às vezes retorna:
  'shop now',
  'learn more',
  'sign up',
  'install now',
  'download',
  'subscribe',
  'get offer',
  'order now',
  'book now',
  'contact us',
  'send message',
  'get started',
  'apply now',
];

// ─────────────────────────────────────────────────────────────
// Limites de custo / escopo (configuráveis). Seção 3, itens 2 e 4.
// ─────────────────────────────────────────────────────────────
export interface InvestigationLimits {
  minCandidates: number;
  maxCandidates: number;
  adsPerCandidate: number;
  championCreativesMin: number;
  championCreativesMax: number;
  maxVideosPerInvestigation: number;
  maxTranscribedMinutes: number;
  /** Pausa entre chamadas Apify (ms), para respeitar rate limit. */
  apifyPauseMs: number;
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  minCandidates: 12,
  maxCandidates: 20,
  adsPerCandidate: 60,
  championCreativesMin: 3,
  championCreativesMax: 5,
  maxVideosPerInvestigation: 15,
  maxTranscribedMinutes: 90,
  apifyPauseMs: 1500,
};

// ─────────────────────────────────────────────────────────────
// Preços de referência para ESTIMATIVA de custo (USD). Aproximados.
// Apify: confirmado pay-per-event ~US$0,0058/ad (tier FREE) para o
// actor apify/facebook-ads-scraper.
// ─────────────────────────────────────────────────────────────
export const PRICE_REFERENCE = {
  apifyPerAdUsd: 0.0058,
  // Transcrição Whisper (openai) por minuto.
  whisperPerMinuteUsd: 0.006,
  // Estimativa grosseira por análise de criativo (tokens LLM).
  llmPerCreativeUsd: 0.01,
  // Estimativa por extração de candidatos (uma chamada LLM).
  llmDiscoveryUsd: 0.02,
  // EXA busca por query.
  exaPerSearchUsd: 0.005,
};
