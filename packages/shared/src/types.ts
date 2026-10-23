// Tipos compartilhados entre web e worker.

export type StepName =
  | 'descobrir'
  | 'buscar_ads'
  | 'pontuar'
  | 'escolher_criativos'
  | 'baixar_midia'
  | 'transcrever'
  | 'analisar'
  | 'consolidar';

export const STEP_ORDER: StepName[] = [
  'descobrir',
  'buscar_ads',
  'pontuar',
  'escolher_criativos',
  'baixar_midia',
  'transcrever',
  'analisar',
  'consolidar',
];

export const STEP_LABELS: Record<StepName, string> = {
  descobrir: 'Descobrir candidatos',
  buscar_ads: 'Buscar anúncios (Meta Ad Library)',
  pontuar: 'Pontuar e filtrar escalados',
  escolher_criativos: 'Escolher criativos campeões',
  baixar_midia: 'Baixar mídia',
  transcrever: 'Transcrever vídeos',
  analisar: 'Analisar com IA',
  consolidar: 'Consolidar resumo',
};

export type JobStatus = 'pendente' | 'rodando' | 'concluida' | 'falhou';

export type EvidenceLevel = 'alto' | 'medio' | 'baixo';

/**
 * Modo da investigação:
 * - 'concorrentes': descobre concorrentes da referência informada (padrão).
 * - 'anunciante': analisa só a empresa informada (sem descoberta).
 */
export type InvestigationMode = 'concorrentes' | 'anunciante';

export interface InvestigationInput {
  /** Nome do app/nicho OU URL do concorrente de referência. */
  query: string;
  /** Código de país (ISO-2). Padrão BR. */
  country: string;
  /** Quantidade de concorrentes a selecionar. Padrão 5. */
  competitors: number;
  /** Só anúncios ativos (padrão true). */
  onlyActive: boolean;
  /** Modo de operação (padrão 'concorrentes'). */
  mode: InvestigationMode;
}

export interface Candidate {
  id: string;
  name: string;
  domain: string | null;
  facebookPage: string | null;
  offerType: string | null;
  /** Origem (query EXA que o trouxe). */
  source: string | null;
}

/** Anúncio normalizado — independente do formato bruto do actor do Apify. */
export interface NormalizedAd {
  adArchiveId: string;
  pageName: string | null;
  bodyText: string | null;
  title: string | null;
  ctaText: string | null;
  ctaType: string | null;
  linkUrl: string | null;
  /** Unix ms. */
  startDate: number | null;
  endDate: number | null;
  isActive: boolean;
  platforms: string[];
  countries: string[];
  /** Nº de variações agrupadas (collationCount) quando disponível. */
  variations: number;
  images: MediaRef[];
  videos: MediaRef[];
  /** Objeto bruto, preservado para depuração. */
  raw?: unknown;
}

export interface MediaRef {
  url: string;
  previewUrl?: string | null;
}

export interface EvidenceBreakdown {
  daysLive: number | null;
  distinctPlatforms: number;
  maxVariations: number;
  distinctCountries: number;
  hasVideo: boolean;
  hasActionCta: boolean;
}

export interface CandidateScore {
  score: number;
  reasons: string[];
  level: EvidenceLevel;
  /** Passou no critério de evidência forte (30+ dias E 3+ variações). */
  passesStrong: boolean;
  evidence: EvidenceBreakdown;
}

/** Evidência calculada POR ANÚNCIO (nível do anúncio, não do anunciante). */
export interface AdEvidence {
  /** Dias no ar: do início até hoje (ativo) ou até o fim (parado). */
  diasNoAr: number | null;
  /** Tamanho do cluster do anúncio (anúncios muito parecidos do mesmo anunciante). */
  versoes: number;
  /** Está ativo agora. */
  ativo: boolean;
  /** Nível de evidência do anúncio. */
  nivel: EvidenceLevel;
  /** Motivo em PT simples (ex.: "ativo há 132 dias, 4 versões parecidas, 5 plataformas, 1 país"). */
  motivo: string;
  /** Chave do cluster (destino + texto-base). */
  clusterId: string;
}

/**
 * Métricas de avaliação persistidas por candidato (coluna jsonb `metrics`).
 * Alimentam a seção "Candidatos avaliados" na tela e nas exportações, para
 * explicar em PT simples por que cada um foi ou não selecionado.
 */
export interface CandidateMetrics extends EvidenceBreakdown {
  /** Anúncios PRÓPRIOS coletados (base de pontuação). */
  adsCollected: number;
  /** Nenhum anúncio próprio encontrado (só menções de terceiros). */
  noOwnAds: boolean;
  /** Limite de anúncios por candidato usado nesta investigação. */
  adsPerCandidateLimit: number;
  // ── Roll-up por anúncio (nível do anúncio) ──
  /** Tem ao menos 1 anúncio de evidência ALTA. */
  hasHigh?: boolean;
  /** Tem ao menos 1 anúncio de evidência MÉDIA. */
  hasMedium?: boolean;
  /** Nível do melhor anúncio. */
  bestAdLevel?: EvidenceLevel | null;
  /** Dias no ar do melhor anúncio. */
  bestAdDays?: number | null;
  /** Versões do melhor anúncio. */
  bestAdVersions?: number | null;
  /** Motivo do melhor anúncio (texto pronto). */
  bestAdReason?: string;
  /** Coletou até o limite por candidato (versões podem estar subestimadas). */
  sampleAtLimit?: boolean;
}

export type CandidateStatus = 'selecionado' | 'quase' | 'nao';

export interface CandidateVerdict {
  status: CandidateStatus;
  /** Rótulo em PT: "Selecionado" | "Quase lá" | "Não selecionado". */
  label: string;
  /** Motivo em PT simples (ex.: "só 12 dias no ar", "apenas 2 variações"). */
  reason: string;
  /** true quando a amostra foi pequena (coletados ≤ limite) → dica na tela. */
  smallSample: boolean;
}

export type MediaType = 'image' | 'video';

export interface CreativeAnalysis {
  hook: string | null;
  angulo: 'curiosidade' | 'dor' | 'promessa' | 'autoridade' | 'contradicao' | null;
  mecanismo: string | null;
  prova: string | null;
  cta: string | null;
  twist: string | null;
  /** Para VSL / vídeos longos. */
  blocos?: { timestamp: string; descricao: string }[] | null;
  /** Para imagens. */
  imagem?: {
    formato: string | null;
    textoNaImagem: string | null;
    estilo: string | null;
    paleta: string | null;
  } | null;
}

export interface CostEntry {
  provider: string;
  unit: string;
  quantity: number;
  estimatedUsd: number;
  note?: string;
}

export interface ConsolidatedCompetitor {
  candidate: Candidate;
  score: CandidateScore;
  summary: string;
  hookPatterns: string[];
  anglePatterns: string[];
  creativeCount: number;
}
