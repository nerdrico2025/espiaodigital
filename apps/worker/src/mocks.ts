// Implementações em memória para smoke test e desenvolvimento sem chaves.
// NÃO chamam nenhum serviço externo.

import type {
  Candidate,
  CostEntry,
  CreativeAnalysis,
  FunnelStepAnalysis,
  NormalizedAd,
  StepName,
} from '@espiao/shared';
import type {
  AdRow,
  AdsProvider,
  Analyzer,
  CandidateRow,
  CandidateScorePatch,
  CapturedStep,
  Clock,
  CreativeFull,
  CreativeRow,
  Db,
  Deps,
  Discovery,
  FunnelCapturer,
  Logger,
  MediaPipeline,
  Transcriber,
} from './interfaces.js';

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const id = (p: string) => `${p}_${(++seq).toString(36)}`;

interface CreativeState extends CreativeFull {
  previewPath: string | null;
  transcriptionProvider: string | null;
  error: string | null;
}

export class MemoryDb implements Db {
  investigation: { id: string; query: string; country: string; competitors: number; onlyActive: boolean };
  candidates = new Map<string, CandidateRow & Partial<CandidateScorePatch> & {
    summary?: string;
    hookPatterns?: string[];
    anglePatterns?: string[];
  }>();
  ads = new Map<string, AdRow & { champion: boolean }>();
  creatives = new Map<string, CreativeState>();
  events: { step: StepName; status: string; message?: string; meta?: unknown }[] = [];
  costs: CostEntry[] = [];
  completed: StepName[] = [];
  currentStep: StepName | null = null;
  status: string = 'pendente';
  notice: string | null = null;
  finalCost: number | null = null;

  constructor(inv: {
    id: string;
    query: string;
    country: string;
    competitors: number;
    onlyActive: boolean;
  }) {
    this.investigation = inv;
  }

  async getInvestigation(): Promise<any> {
    return this.investigation;
  }
  async addEvent(_inv: string, step: StepName, status: any, message?: string, meta?: unknown) {
    this.events.push({ step, status, message, meta });
  }
  async setInvestigationStatus(_inv: string, status: any, patch?: { notice?: string | null }) {
    this.status = status;
    if (patch && 'notice' in patch) this.notice = patch.notice ?? null;
  }
  async getCompletedSteps(): Promise<StepName[]> {
    return [...this.completed];
  }
  async markStepCompleted(_inv: string, step: StepName) {
    if (!this.completed.includes(step)) this.completed.push(step);
  }
  async setCurrentStep(_inv: string, step: StepName) {
    this.currentStep = step;
  }
  async insertCandidates(investigationId: string, candidates: Candidate[]): Promise<CandidateRow[]> {
    const rows: CandidateRow[] = [];
    for (const c of candidates) {
      const row: CandidateRow = { ...c, investigationId };
      this.candidates.set(row.id, row);
      rows.push(row);
    }
    return rows;
  }
  async updateCandidateScore(candidateId: string, patch: CandidateScorePatch) {
    const c = this.candidates.get(candidateId);
    if (c) Object.assign(c, patch);
  }
  async insertAds(_inv: string, candidateId: string, ads: NormalizedAd[]): Promise<AdRow[]> {
    const rows: AdRow[] = [];
    for (const ad of ads) {
      const row = { id: id('ad'), candidateId, ad, champion: false };
      this.ads.set(row.id, row);
      rows.push({ id: row.id, candidateId, ad });
    }
    return rows;
  }
  async markChampionAds(adIds: string[]) {
    for (const a of adIds) {
      const row = this.ads.get(a);
      if (row) row.champion = true;
    }
  }
  async updateAdEvidence(adId: string, ev: unknown) {
    const row = this.ads.get(adId);
    if (row) (row as any).evidence = ev; // só para inspeção; o smoke recomputa
  }
  async insertCreative(input: {
    investigationId: string;
    adId: string;
    candidateId: string;
    mediaType: 'image' | 'video';
    sourceUrl: string;
    previewUrl?: string | null;
  }): Promise<CreativeRow> {
    const ad = this.ads.get(input.adId);
    const cand = this.candidates.get(input.candidateId);
    const cr: CreativeState = {
      id: id('cr'),
      adId: input.adId,
      candidateId: input.candidateId,
      mediaType: input.mediaType,
      sourceUrl: input.sourceUrl,
      previewUrl: input.previewUrl ?? null,
      storagePath: null,
      previewPath: null,
      transcription: null,
      transcriptionProvider: null,
      analysis: null,
      durationSeconds: null,
      status: 'pendente',
      error: null,
      adBodyText: ad?.ad.bodyText ?? null,
      adTitle: ad?.ad.title ?? null,
      adCtaText: ad?.ad.ctaText ?? null,
      adLinkUrl: ad?.ad.linkUrl ?? null,
      candidateName: cand?.name ?? null,
      candidateDomain: cand?.domain ?? null,
    };
    this.creatives.set(cr.id, cr);
    return { id: cr.id, adId: cr.adId, candidateId: cr.candidateId, mediaType: cr.mediaType, sourceUrl: cr.sourceUrl, previewUrl: cr.previewUrl };
  }
  async updateCreative(creativeId: string, patch: any) {
    const c = this.creatives.get(creativeId);
    if (c) Object.assign(c, patch);
  }
  async addCost(_inv: string, entry: CostEntry) {
    this.costs.push(entry);
  }
  async getCostTotal(): Promise<number> {
    return this.costs.reduce((s, c) => s + c.estimatedUsd, 0);
  }
  async setFinalCost(_inv: string, usd: number) {
    this.finalCost = usd;
  }
  async getCandidates(): Promise<CandidateRow[]> {
    return [...this.candidates.values()];
  }
  async getAdsGrouped(): Promise<{ candidate: CandidateRow; ads: AdRow[] }[]> {
    return [...this.candidates.values()].map((candidate) => ({
      candidate,
      ads: [...this.ads.values()]
        .filter((a) => a.candidateId === candidate.id)
        .map((a) => ({ id: a.id, candidateId: a.candidateId, ad: a.ad })),
    }));
  }
  async getSelectedCandidatesWithAds(): Promise<{ candidate: CandidateRow; ads: AdRow[] }[]> {
    return (await this.getAdsGrouped()).filter((g) => (this.candidates.get(g.candidate.id) as any)?.selected);
  }
  async getChampionAds(): Promise<AdRow[]> {
    return [...this.ads.values()].filter((a) => a.champion).map((a) => ({ id: a.id, candidateId: a.candidateId, ad: a.ad }));
  }
  async getCreatives(): Promise<CreativeFull[]> {
    return [...this.creatives.values()];
  }
  async saveCandidateSummary(candidateId: string, s: { summary: string; hookPatterns: string[]; anglePatterns: string[] }) {
    const c = this.candidates.get(candidateId);
    if (c) Object.assign(c, s);
  }

  // ── Funil ──
  funnels = new Map<string, any>();
  funnelSteps: any[] = [];
  async uploadMedia() {
    /* no-op em memória */
  }
  async insertFunnel(input: any): Promise<{ id: string }> {
    const fid = id('funnel');
    this.funnels.set(fid, { id: fid, ...input, pixels: [], steps: 0 });
    return { id: fid };
  }
  async updateFunnel(funnelId: string, patch: any) {
    const f = this.funnels.get(funnelId);
    if (f) Object.assign(f, patch);
  }
  async insertFunnelStep(input: any): Promise<{ id: string }> {
    const sid = id('fstep');
    this.funnelSteps.push({ id: sid, ...input });
    return { id: sid };
  }
  async getFunnelPixelIndex(): Promise<{ id: string; domain: string }[]> {
    const out: { id: string; domain: string }[] = [];
    for (const f of this.funnels.values()) {
      for (const px of f.pixels ?? []) if (px?.id && f.domain) out.push({ id: String(px.id), domain: f.domain });
    }
    return out;
  }
}

// ── Mock providers ───────────────────────────────────────────
export class MockDiscovery implements Discovery {
  constructor(private count = 14) {}
  async discover(): Promise<{ candidates: Candidate[]; cost: CostEntry[] }> {
    const candidates: Candidate[] = [];
    for (let i = 1; i <= this.count; i++) {
      candidates.push({
        id: id('cand'),
        name: `Concorrente ${String(i).padStart(2, '0')}`,
        domain: `concorrente${i}.com.br`,
        facebookPage: `https://facebook.com/concorrente${i}`,
        offerType: i % 2 === 0 ? 'assinatura' : 'curso',
        source: 'mock:exa',
      });
    }
    return { candidates, cost: [{ provider: 'exa', unit: 'busca', quantity: 4, estimatedUsd: 0.02 }] };
  }
}

/** Gera ads determinísticos: os primeiros `strong` candidatos são escalados. */
export class MockAdsProvider implements AdsProvider {
  private seen = 0;
  private byPage = new Map<string, NormalizedAd[]>();
  constructor(private strong = 3, private now = Date.now()) {}
  async fetchAds(candidate: Candidate): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }> {
    const idx = this.seen++;
    const isStrong = idx < this.strong;
    const pageId = `pg-${candidate.id}`;
    const ads: NormalizedAd[] = [];
    const n = isStrong ? 6 : 2;
    for (let i = 0; i < n; i++) {
      const daysAgo = isStrong ? 80 : 10;
      ads.push({
        adArchiveId: `${candidate.id}-ad-${i}`,
        pageName: candidate.name,
        bodyText: isStrong
          ? `Descubra como ${candidate.name} resolve seu problema em 7 dias. Método comprovado.`
          : `Conheça ${candidate.name}.`,
        title: `${candidate.name} — oferta ${i}`,
        ctaText: isStrong ? 'Saiba mais' : 'Ver página',
        ctaType: 'LEARN_MORE',
        linkUrl: `https://${candidate.domain}/oferta`,
        startDate: this.now - daysAgo * DAY,
        endDate: null,
        isActive: true,
        platforms: isStrong
          ? ['FACEBOOK', 'INSTAGRAM', 'MESSENGER', 'AUDIENCE_NETWORK']
          : ['FACEBOOK'],
        countries: isStrong ? ['BR', 'PT'] : ['BR'],
        variations: isStrong ? 6 : 1,
        images: [{ url: `https://cdn.mock/${candidate.id}-${i}.jpg`, previewUrl: null }],
        videos: isStrong && i === 0 ? [{ url: `https://cdn.mock/${candidate.id}-${i}.mp4`, previewUrl: null }] : [],
        raw: { pageId },
      });
    }
    this.byPage.set(pageId, ads);
    return { ads, cost: [{ provider: 'apify', unit: 'ad', quantity: n, estimatedUsd: n * 0.0058 }] };
  }
  async fetchAdsByPage(pageId: string): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }> {
    // Simula a busca por página devolvendo o mesmo conjunto da marca.
    const ads = this.byPage.get(pageId) ?? [];
    return {
      ads,
      cost: [{ provider: 'apify', unit: 'ad', quantity: ads.length, estimatedUsd: ads.length * 0.0058 }],
    };
  }
}

export class MockMedia implements MediaPipeline {
  async download(input: { investigationId: string; creativeId: string; mediaType: 'image' | 'video'; url: string }) {
    return {
      ok: true,
      storagePath: `${input.investigationId}/${input.creativeId}.${input.mediaType === 'video' ? 'mp4' : 'jpg'}`,
      previewPath: null,
      localAudioPath: input.mediaType === 'video' ? `/tmp/mock-${input.creativeId}.wav` : null,
      durationSeconds: input.mediaType === 'video' ? 45 : null,
    };
  }
}

export class MockTranscriber implements Transcriber {
  constructor(private provider: 'openrouter' | 'openai' = 'openai') {}
  async transcribe(input: { durationSeconds: number | null }) {
    return {
      text: 'Olá! Se você quer resultados rápidos, esse método foi feito pra você. Clique no link e comece agora.',
      provider: this.provider,
      cost: [
        {
          provider: `transcription:${this.provider}`,
          unit: 'minuto',
          quantity: (input.durationSeconds ?? 0) / 60,
          estimatedUsd: ((input.durationSeconds ?? 0) / 60) * 0.006,
        },
      ] as CostEntry[],
    };
  }
}

export class MockAnalyzer implements Analyzer {
  async analyze(input: { mediaType: 'image' | 'video' }) {
    const analysis: CreativeAnalysis = {
      hook: 'Resultados rápidos em 7 dias',
      angulo: 'promessa',
      mecanismo: 'Método passo a passo',
      prova: 'Depoimentos',
      cta: 'Saiba mais',
      twist: null,
      blocos: input.mediaType === 'video' ? [{ timestamp: '00:00', descricao: 'Abertura com promessa' }] : null,
      imagem:
        input.mediaType === 'image'
          ? { formato: 'quadrado', textoNaImagem: 'OFERTA', estilo: 'chamativo', paleta: 'quente' }
          : null,
    };
    return { analysis, cost: [{ provider: 'openrouter', unit: 'analise-criativo', quantity: 1, estimatedUsd: 0.01 }] };
  }

  async analyzeFunnelStep(input: { url: string; text: string | null; stepTypeGuess?: string | null }) {
    const isCheckout = input.stepTypeGuess === 'checkout';
    const analysis: FunnelStepAnalysis = {
      tipo: isCheckout ? 'checkout' : 'lp',
      headline: isCheckout ? null : 'Oferta incrível',
      promessa: isCheckout ? null : 'Resultado em 7 dias',
      mecanismo: null,
      prova: null,
      oferta: isCheckout ? 'Produto principal' : null,
      preco: isCheckout ? 'R$ 97' : null,
      bonus: null,
      garantia: null,
      urgencia: null,
      cta: isCheckout ? 'Finalizar compra' : 'Comprar agora',
    };
    return { analysis, cost: [{ provider: 'openrouter', unit: 'analise-passo-funil', quantity: 1, estimatedUsd: 0.01 }] as CostEntry[] };
  }
}

export class MockFunnel implements FunnelCapturer {
  async capture(entryUrl: string, opts: { maxSteps: number; country: string }) {
    void opts;
    const steps: CapturedStep[] = [
      {
        order: 0,
        url: entryUrl,
        stepTypeGuess: null,
        screenshot: Buffer.from('mock-png'),
        html: '<html><body><h1>Oferta</h1><a href="https://pay.hotmart.com/x">Comprar agora</a></body></html>',
        text: '# Oferta incrível\nMétodo comprovado. Clique em comprar agora.',
        requests: [
          { url: 'https://connect.facebook.net/en_US/fbevents.js', resourceType: 'script' },
          { url: 'https://scripts.converteai.net/player.js', resourceType: 'script' },
        ],
        blocked: false,
        loadMs: 1200,
      },
      {
        order: 1,
        url: 'https://pay.hotmart.com/x',
        stepTypeGuess: 'checkout',
        screenshot: Buffer.from('mock-png-2'),
        html: '<html><body>Checkout Hotmart</body></html>',
        text: 'Finalizar compra — R$ 97',
        requests: [{ url: 'https://pay.hotmart.com/checkout.js', resourceType: 'script' }],
        blocked: false,
        loadMs: 900,
      },
    ];
    return { steps };
  }
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(`ℹ️  ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`⚠️  ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`❌ ${m}`, meta ?? ''),
};

export const fixedClock = (t = Date.now()): Clock => ({ now: () => t });

export function makeMockDeps(opts?: {
  candidates?: number;
  strong?: number;
  provider?: 'openrouter' | 'openai';
  now?: number;
  db?: MemoryDb;
  inv?: { id: string; query: string; country: string; competitors: number; onlyActive: boolean };
}): { deps: Deps; db: MemoryDb } {
  const now = opts?.now ?? Date.now();
  const inv =
    opts?.inv ??
    { id: id('inv'), query: 'app de finanças', country: 'BR', competitors: 5, onlyActive: true };
  const db = opts?.db ?? new MemoryDb(inv);
  const deps: Deps = {
    db,
    discovery: new MockDiscovery(opts?.candidates ?? 14),
    ads: new MockAdsProvider(opts?.strong ?? 3, now),
    media: new MockMedia(),
    transcriber: new MockTranscriber(opts?.provider ?? 'openai'),
    analyzer: new MockAnalyzer(),
    funnel: new MockFunnel(),
    clock: fixedClock(now),
    log: consoleLogger,
  };
  return { deps, db };
}
