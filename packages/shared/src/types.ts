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

export interface InvestigationInput {
  /** Nome do app/nicho OU URL do concorrente de referência. */
  query: string;
  /** Código de país (ISO-2). Padrão BR. */
  country: string;
  /** Quantidade de concorrentes a selecionar. Padrão 5. */
  competitors: number;
  /** Só anúncios ativos (padrão true). */
  onlyActive: boolean;
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
