// Interfaces de dependências do pipeline. Permitem rodar com
// implementações reais (worker) ou mocks (smoke test).

import type {
  AdEvidence,
  Candidate,
  CandidateMetrics,
  CostEntry,
  CreativeAnalysis,
  EvidenceBreakdown,
  FunnelStepAnalysis,
  FunnelTech,
  InvestigationConfig,
  InvestigationInput,
  MediaType,
  NormalizedAd,
  RequestLog,
  StepName,
} from '@espiao/shared';

// ── Persistência ─────────────────────────────────────────────
export interface InvestigationRow extends InvestigationInput {
  id: string;
  /** Overrides de escopo/custo escolhidos na criação (coluna jsonb `config`). */
  config?: InvestigationConfig | null;
}

export interface CandidateRow extends Candidate {
  investigationId: string;
}

export interface AdRow {
  id: string;
  candidateId: string;
  ad: NormalizedAd;
}

export interface CreativeRow {
  id: string;
  adId: string;
  candidateId: string;
  mediaType: MediaType;
  sourceUrl: string;
  previewUrl: string | null;
}

export interface CreativeFull {
  id: string;
  adId: string;
  candidateId: string;
  mediaType: MediaType;
  sourceUrl: string;
  previewUrl: string | null;
  storagePath: string | null;
  transcription: string | null;
  analysis: CreativeAnalysis | null;
  durationSeconds: number | null;
  status: string;
  // Texto do anúncio ao qual pertence, para a análise.
  adBodyText: string | null;
  adTitle: string | null;
  adCtaText: string | null;
  adLinkUrl: string | null;
  // Contexto do candidato (dica de grafia de marca nos prompts).
  candidateName: string | null;
  candidateDomain: string | null;
}

export interface CandidateScorePatch {
  score: number;
  level: 'alto' | 'medio' | 'baixo';
  reasons: string[];
  evidence: EvidenceBreakdown;
  selected: boolean;
  selectionReason: string | null;
  /** Métricas de avaliação (persistidas na coluna jsonb `metrics`). */
  metrics?: CandidateMetrics;
}

export interface Db {
  getInvestigation(id: string): Promise<InvestigationRow>;
  addEvent(
    investigationId: string,
    step: StepName,
    status: 'rodando' | 'concluida' | 'falhou',
    message?: string,
    meta?: unknown,
  ): Promise<void>;
  setInvestigationStatus(
    investigationId: string,
    status: 'rodando' | 'concluida' | 'falhou',
    patch?: { notice?: string | null },
  ): Promise<void>;

  getCompletedSteps(investigationId: string): Promise<StepName[]>;
  markStepCompleted(investigationId: string, step: StepName): Promise<void>;
  setCurrentStep(investigationId: string, step: StepName): Promise<void>;

  insertCandidates(investigationId: string, candidates: Candidate[]): Promise<CandidateRow[]>;
  updateCandidateScore(candidateId: string, patch: CandidateScorePatch): Promise<void>;
  /** Persiste a evidência calculada por anúncio (colunas em `ads`). */
  updateAdEvidence(adId: string, ev: AdEvidence): Promise<void>;

  insertAds(
    investigationId: string,
    candidateId: string,
    ads: NormalizedAd[],
  ): Promise<AdRow[]>;
  markChampionAds(adIds: string[]): Promise<void>;

  insertCreative(input: {
    investigationId: string;
    adId: string;
    candidateId: string;
    mediaType: MediaType;
    sourceUrl: string;
    previewUrl?: string | null;
  }): Promise<CreativeRow>;
  updateCreative(
    creativeId: string,
    patch: Partial<{
      storagePath: string | null;
      previewPath: string | null;
      transcription: string | null;
      transcriptionProvider: string | null;
      analysis: CreativeAnalysis | null;
      durationSeconds: number | null;
      status: string;
      error: string | null;
    }>,
  ): Promise<void>;

  addCost(investigationId: string, entry: CostEntry): Promise<void>;
  getCostTotal(investigationId: string): Promise<number>;
  setFinalCost(investigationId: string, usd: number): Promise<void>;

  // Read-backs para retomar etapas sem repetir as já concluídas.
  getCandidates(investigationId: string): Promise<CandidateRow[]>;
  getAdsGrouped(investigationId: string): Promise<{ candidate: CandidateRow; ads: AdRow[] }[]>;
  getSelectedCandidatesWithAds(
    investigationId: string,
  ): Promise<{ candidate: CandidateRow; ads: AdRow[] }[]>;
  getChampionAds(investigationId: string): Promise<AdRow[]>;
  getCreatives(investigationId: string): Promise<CreativeFull[]>;

  saveCandidateSummary(
    candidateId: string,
    summary: { summary: string; hookPatterns: string[]; anglePatterns: string[] },
  ): Promise<void>;

  // ── Funil (fase 05) ──
  /** Sobe um arquivo arbitrário ao bucket privado `creatives`. */
  uploadMedia(storagePath: string, data: Buffer | string, contentType: string): Promise<void>;
  insertFunnel(input: {
    investigationId: string;
    candidateId: string | null;
    adId: string | null;
    entryUrl: string;
    domain: string | null;
  }): Promise<{ id: string }>;
  updateFunnel(
    funnelId: string,
    patch: {
      status?: string;
      checkoutPlatform?: string | null;
      videoPlayer?: string | null;
      pixels?: FunnelTech['pixels'];
      manifests?: string[];
      tech?: FunnelTech;
      blocked?: boolean;
    },
  ): Promise<void>;
  insertFunnelStep(input: {
    funnelId: string;
    investigationId: string;
    order: number;
    stepType: string | null;
    url: string;
    screenshotPath: string | null;
    htmlPath: string | null;
    textPath: string | null;
    requests: RequestLog[];
    analysis: FunnelStepAnalysis | null;
    blocked: boolean;
    loadMs: number | null;
  }): Promise<{ id: string }>;
  /** Índice de pixels já vistos (id + domínio) para sinalizar "mesmo pixel em outro domínio". */
  getFunnelPixelIndex(): Promise<{ id: string; domain: string }[]>;
}

// ── Provedores externos ──────────────────────────────────────
export interface Discovery {
  /** Busca candidatos (EXA + LLM). Deve deduplicar. */
  discover(input: InvestigationInput, limit: { min: number; max: number }): Promise<{
    candidates: Candidate[];
    cost: CostEntry[];
  }>;
}

export interface AdsProvider {
  /** Busca anúncios de um candidato na Meta Ad Library (busca por marca). */
  fetchAds(
    candidate: Candidate,
    opts: { country: string; onlyActive: boolean; limit: number },
  ): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }>;
  /** Busca anúncios por página (search_type=page & view_all_page_id). */
  fetchAdsByPage(
    pageId: string,
    opts: { country: string; onlyActive: boolean; limit: number },
  ): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }>;
}

export interface DownloadResult {
  storagePath: string | null;
  previewPath: string | null;
  localAudioPath?: string | null; // vídeo: caminho do áudio extraído
  durationSeconds?: number | null;
  ok: boolean;
  error?: string;
}

export interface MediaPipeline {
  /** Baixa a mídia e (p/ vídeo) extrai áudio. Envia ao storage. */
  download(input: {
    investigationId: string;
    creativeId: string;
    mediaType: MediaType;
    url: string;
    previewUrl?: string | null;
  }): Promise<DownloadResult>;
}

export interface TranscribeResult {
  text: string;
  provider: 'openrouter' | 'openai';
  cost: CostEntry[];
}

export interface Transcriber {
  transcribe(input: {
    audioPath: string;
    durationSeconds: number | null;
    /** Dica de contexto p/ grafia correta de marcas. */
    context?: { brand?: string | null; domain?: string | null };
  }): Promise<TranscribeResult>;
}

export interface AnalyzeResult {
  analysis: CreativeAnalysis;
  cost: CostEntry[];
}

export interface Analyzer {
  analyze(input: {
    mediaType: MediaType;
    bodyText: string | null;
    title: string | null;
    ctaText: string | null;
    transcription: string | null;
    imageUrl?: string | null;
    /** URL de destino do anúncio — base preferencial para o campo `cta`. */
    linkUrl?: string | null;
    /** Dica de contexto p/ grafia correta de marcas. */
    context?: { brand?: string | null; domain?: string | null };
  }): Promise<AnalyzeResult>;
  /** Analisa UM passo de funil (classifica tipo + extrai campos). */
  analyzeFunnelStep(input: {
    url: string;
    text: string | null;
    stepTypeGuess?: string | null;
  }): Promise<{ analysis: FunnelStepAnalysis; cost: CostEntry[] }>;
}

// ── Captura de funil (Playwright) ────────────────────────────
export interface CapturedStep {
  order: number;
  url: string;
  stepTypeGuess: string | null;
  screenshot: Buffer | null;
  html: string | null;
  text: string | null;
  requests: RequestLog[];
  blocked: boolean;
  loadMs: number;
}

export interface FunnelCapturer {
  /** Captura a página e segue o CTA até estabilizar/checkout (máx. maxSteps). */
  capture(
    entryUrl: string,
    opts: { maxSteps: number; country: string },
  ): Promise<{ steps: CapturedStep[] }>;
}

export interface Clock {
  now(): number;
}

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface Deps {
  db: Db;
  discovery: Discovery;
  ads: AdsProvider;
  media: MediaPipeline;
  transcriber: Transcriber;
  analyzer: Analyzer;
  funnel: FunnelCapturer;
  clock: Clock;
  log: Logger;
}
