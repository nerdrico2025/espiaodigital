// Tipos compartilhados entre web e worker.

export type StepName =
  | 'descobrir'
  | 'buscar_ads'
  | 'pontuar'
  | 'escolher_criativos'
  | 'baixar_midia'
  | 'transcrever'
  | 'analisar'
  | 'consolidar'
  | 'capturar_funil'
  | 'processar_vsl';

export const STEP_ORDER: StepName[] = [
  'descobrir',
  'buscar_ads',
  'pontuar',
  'escolher_criativos',
  'baixar_midia',
  'transcrever',
  'analisar',
  'consolidar',
  'capturar_funil',
  'processar_vsl',
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
  capturar_funil: 'Capturar funil (páginas)',
  processar_vsl: 'Processar VSL (download + transcrição)',
};

export type JobStatus = 'pendente' | 'rodando' | 'concluida' | 'falhou';

export type EvidenceLevel = 'alto' | 'medio' | 'baixo';

/**
 * Modo da investigação (fonte única — nunca duplicar as strings):
 * - 'concorrentes': descobre concorrentes da referência informada (padrão).
 * - 'anunciante': analisa só a empresa informada (sem descoberta).
 * - 'pagina': analisa só uma página/VSL informada (captura de funil direta).
 */
export const INVESTIGATION_MODES = ['concorrentes', 'anunciante', 'pagina'] as const;
export type InvestigationMode = (typeof INVESTIGATION_MODES)[number];

export const DEFAULT_INVESTIGATION_MODE: InvestigationMode = 'concorrentes';

/** true se `v` é um modo válido. */
export function isInvestigationMode(v: unknown): v is InvestigationMode {
  return typeof v === 'string' && (INVESTIGATION_MODES as readonly string[]).includes(v);
}

/**
 * Converte um valor em modo válido. `null`/`undefined` → padrão; qualquer outro
 * valor inválido LANÇA erro explícito (nunca cai no padrão silenciosamente).
 */
export function parseInvestigationMode(v: unknown): InvestigationMode {
  if (v == null || v === '') return DEFAULT_INVESTIGATION_MODE;
  if (isInvestigationMode(v)) return v;
  throw new Error(`Modo de investigação inválido: ${JSON.stringify(v)}`);
}

/** Etapas que SE APLICAM a cada modo (worker e barra de etapas usam a mesma lista). */
export function stepsForMode(mode: InvestigationMode): StepName[] {
  if (mode === 'pagina') {
    // Página/VSL: sem descoberta/ads. Captura a página, processa a VSL e consolida.
    return ['capturar_funil', 'processar_vsl', 'consolidar'];
  }
  return STEP_ORDER;
}

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

// ── Funil: captura e análise de páginas (fase 05) ────────────

export type FunnelStepType =
  | 'pre_sell'
  | 'lp'
  | 'quiz'
  | 'vsl'
  | 'checkout'
  | 'upsell'
  | 'obrigado'
  | 'outro';

/** Análise por passo (LLM). Dado ausente = null; nunca inventar. */
export interface FunnelStepAnalysis {
  tipo: FunnelStepType | null;
  headline: string | null;
  promessa: string | null;
  mecanismo: string | null;
  prova: string | null;
  oferta: string | null;
  preco: string | null;
  bonus: string | null;
  garantia: string | null;
  urgencia: string | null;
  cta: string | null;
}

/** Um pixel detectado (plataforma + id quando houver). */
export interface PixelHit {
  tipo: string; // meta | gtm | ga4 | tiktok | hotjar | clarity | email | outro
  id: string | null;
}

/** Detecção técnica por funil (a partir de requisições + HTML). */
export interface FunnelTech {
  checkoutPlatform: string | null;
  videoPlayer: string | null;
  pixels: PixelHit[];
  /** URLs de manifest de vídeo (.m3u8/.mpd) — guardadas, não baixadas aqui. */
  manifests: string[];
  /** IDs de pixel já vistos em OUTRO domínio (sinal de mesmo dono/operação). */
  samePixelOtherDomain?: { id: string; domain: string }[];
}

// ── VSL: download, transcrição e mapeamento (fase 06) ────────

/** Trecho da transcrição com deslocamento de tempo (segundos). */
export interface VslSegment {
  start: number; // seg
  end: number; // seg
  text: string;
  /** true = tempo estimado pelo deslocamento do trecho (não veio do provedor). */
  approx: boolean;
}

export const VSL_BLOCKS: { key: string; nome: string }[] = [
  { key: '01', nome: 'Hook / open loop' },
  { key: '02', nome: 'Agitação / dor' },
  { key: '03', nome: 'História do expert' },
  { key: '04', nome: 'Mecanismo único' },
  { key: '05', nome: 'Prova' },
  { key: '06', nome: 'Produto / oferta' },
  { key: '07', nome: 'Stack de valor' },
  { key: '08', nome: 'Escassez / urgência' },
  { key: '09', nome: 'Garantia' },
  { key: '10', nome: 'CTA e fechamento' },
  { key: '11', nome: 'P.S. / FAQ' },
];

export interface VslBlock {
  bloco: string; // '01'..'11'
  nome: string;
  presente: boolean;
  inicio: string | null; // timestamp "mm:ss"
  fim: string | null;
  citacoes: string[]; // literais da transcrição (2 a 3)
  analise: string | null;
  nota: number | null; // 1..10
}

export interface VslSummary {
  bigIdea: string | null;
  mecanismo: string | null; // nome literal exato
  oferta: string | null;
  preco: string | null;
  stack: { itens: string[]; bonus: string[]; valorAlegado: string | null } | null;
  garantia: string | null;
  emocaoDominante: string | null;
  vilao: string | null;
  diferencial: string | null;
}

export interface VslAnalysis {
  resumo: VslSummary;
  blocos: VslBlock[];
  /** "CTA e quando aparece o botão" — só se a captura tiver o tempo; senão null. */
  ctaButtons: { cta: string; aparecemSeg: number | null }[] | null;
  /** Aviso quando a transcrição é parcial. */
  parcialAviso: string | null;
}

/** Sub-etapas do processamento de uma VSL, cada uma com ok/falhou + motivo. */
export type VslSubstepName = 'download' | 'audio' | 'transcricao' | 'mapeamento';
export interface VslSubstep {
  etapa: VslSubstepName;
  ok: boolean;
  motivo: string | null;
}
export const VSL_SUBSTEP_PT: Record<VslSubstepName, string> = {
  download: 'Download do vídeo',
  audio: 'Extração de áudio',
  transcricao: 'Transcrição',
  mapeamento: 'Mapeamento (IA)',
};

/**
 * Status final de uma VSL:
 * - 'concluida': transcrição + mapeamento OK.
 * - 'concluida_com_problemas': transcrição OK, mas mapeamento vazio/falhou ou parcial.
 * - 'falhou' / 'midia_indisponivel' / 'longa_demais': não há transcrição utilizável.
 */
export const VSL_STATUS = {
  concluida: 'concluida',
  concluidaComProblemas: 'concluida_com_problemas',
  parcial: 'parcial',
  falhou: 'falhou',
  midiaIndisponivel: 'midia_indisponivel',
  longaDemais: 'longa_demais',
} as const;
