import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Candidate,
  CostEntry,
  NormalizedAd,
  StepName,
} from '@espiao/shared';
import type {
  AdRow,
  CandidateRow,
  CandidateScorePatch,
  CreativeFull,
  CreativeRow,
  Db,
  InvestigationRow,
} from '../interfaces.js';

const toTs = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const toMs = (ts: string | null) => (ts == null ? null : Date.parse(ts));

export interface ClaimedJob {
  id: string;
  investigation_id: string;
  [k: string]: unknown;
}

// A função claim_job tem `returns public.jobs`. Quando não há job, o `return null`
// do plpgsql chega pelo PostgREST como UMA LINHA com todos os campos null
// (ex.: { id: null, investigation_id: null, ... }) — não como `null` puro.
// Também pode vir como array (SETOF) ou objeto único dependendo do cliente.
// Normalizamos todos esses casos para `null` = "sem job", e só devolvemos um
// job quando ele tem id E investigation_id, para nunca chamar getInvestigation
// com id nulo.
export function normalizeClaimedJob(data: unknown): ClaimedJob | null {
  if (data == null) return null;
  const row = Array.isArray(data) ? (data[0] ?? null) : data;
  if (row == null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.id == null || r.investigation_id == null) return null;
  return r as ClaimedJob;
}

export class SupabaseDb implements Db {
  private sb: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  get client(): SupabaseClient {
    return this.sb;
  }

  private async must<T>(res: { data: T | null; error: { message: string } | null }, ctx: string): Promise<T> {
    if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
    if (res.data == null) throw new Error(`${ctx}: sem dados`);
    return res.data;
  }

  async getInvestigation(id: string): Promise<InvestigationRow> {
    const data = (await this.must(
      await this.sb.from('investigations').select('*').eq('id', id).single(),
      'getInvestigation',
    )) as any;
    return {
      id: data.id,
      query: data.query,
      country: data.country,
      competitors: data.competitors,
      onlyActive: data.only_active,
      config: data.config ?? null,
      mode: data.mode === 'anunciante' ? 'anunciante' : 'concorrentes',
    };
  }

  async addEvent(
    investigationId: string,
    step: StepName,
    status: 'rodando' | 'concluida' | 'falhou',
    message?: string,
    meta?: unknown,
  ): Promise<void> {
    const { error } = await this.sb.from('job_events').insert({
      investigation_id: investigationId,
      step,
      status,
      message: message ?? null,
      meta: meta ?? null,
    });
    if (error) throw new Error(`addEvent: ${error.message}`);
  }

  async setInvestigationStatus(
    investigationId: string,
    status: 'rodando' | 'concluida' | 'falhou',
    patch?: { notice?: string | null },
  ): Promise<void> {
    const upd: Record<string, unknown> = { status };
    if (patch && 'notice' in patch) upd.notice = patch.notice ?? null;
    const { error } = await this.sb.from('investigations').update(upd).eq('id', investigationId);
    if (error) throw new Error(`setInvestigationStatus: ${error.message}`);
  }

  async getCompletedSteps(investigationId: string): Promise<StepName[]> {
    const { data, error } = await this.sb
      .from('jobs')
      .select('completed_steps')
      .eq('investigation_id', investigationId)
      .single();
    if (error) throw new Error(`getCompletedSteps: ${error.message}`);
    return (data?.completed_steps ?? []) as StepName[];
  }

  async markStepCompleted(investigationId: string, step: StepName): Promise<void> {
    const current = await this.getCompletedSteps(investigationId);
    if (current.includes(step)) return;
    const { error } = await this.sb
      .from('jobs')
      .update({ completed_steps: [...current, step] })
      .eq('investigation_id', investigationId);
    if (error) throw new Error(`markStepCompleted: ${error.message}`);
  }

  async setCurrentStep(investigationId: string, step: StepName): Promise<void> {
    const { error } = await this.sb
      .from('jobs')
      .update({ current_step: step })
      .eq('investigation_id', investigationId);
    if (error) throw new Error(`setCurrentStep: ${error.message}`);
  }

  async insertCandidates(investigationId: string, candidates: Candidate[]): Promise<CandidateRow[]> {
    if (candidates.length === 0) return [];
    const rows = candidates.map((c) => ({
      investigation_id: investigationId,
      name: c.name,
      domain: c.domain,
      facebook_page: c.facebookPage,
      offer_type: c.offerType,
      source: c.source,
    }));
    const data = await this.must(
      await this.sb.from('candidates').insert(rows).select('*'),
      'insertCandidates',
    );
    return (data as any[]).map(this.mapCandidate);
  }

  private mapCandidate = (d: any): CandidateRow => ({
    id: d.id,
    investigationId: d.investigation_id,
    name: d.name,
    domain: d.domain,
    facebookPage: d.facebook_page,
    offerType: d.offer_type,
    source: d.source,
  });

  async updateCandidateScore(candidateId: string, patch: CandidateScorePatch): Promise<void> {
    const upd: Record<string, unknown> = {
      score: patch.score,
      evidence_level: patch.level,
      reasons: patch.reasons,
      evidence: patch.evidence,
      selected: patch.selected,
      selection_reason: patch.selectionReason,
    };
    // Só grava `metrics` quando informado (o 2º update de seleção não reescreve).
    if (patch.metrics !== undefined) upd.metrics = patch.metrics;
    const { error } = await this.sb.from('candidates').update(upd).eq('id', candidateId);
    if (error) throw new Error(`updateCandidateScore: ${error.message}`);
  }

  async insertAds(
    investigationId: string,
    candidateId: string,
    ads: NormalizedAd[],
  ): Promise<AdRow[]> {
    if (ads.length === 0) return [];
    const rows = ads.map((ad) => ({
      investigation_id: investigationId,
      candidate_id: candidateId,
      ad_archive_id: ad.adArchiveId,
      page_name: ad.pageName,
      body_text: ad.bodyText,
      title: ad.title,
      cta_text: ad.ctaText,
      cta_type: ad.ctaType,
      link_url: ad.linkUrl,
      start_date: toTs(ad.startDate),
      end_date: toTs(ad.endDate),
      is_active: ad.isActive,
      platforms: ad.platforms,
      countries: ad.countries,
      variations: ad.variations,
      images: ad.images,
      videos: ad.videos,
      raw: ad.raw ?? null,
    }));
    const data = await this.must(await this.sb.from('ads').insert(rows).select('*'), 'insertAds');
    return (data as any[]).map((d) => ({ id: d.id, candidateId: d.candidate_id, ad: this.mapAd(d) }));
  }

  private mapAd = (d: any): NormalizedAd => ({
    adArchiveId: d.ad_archive_id,
    pageName: d.page_name,
    bodyText: d.body_text,
    title: d.title,
    ctaText: d.cta_text,
    ctaType: d.cta_type,
    linkUrl: d.link_url,
    startDate: toMs(d.start_date),
    endDate: toMs(d.end_date),
    isActive: d.is_active,
    platforms: d.platforms ?? [],
    countries: d.countries ?? [],
    variations: d.variations ?? 0,
    images: d.images ?? [],
    videos: d.videos ?? [],
  });

  async updateAdEvidence(adId: string, ev: {
    diasNoAr: number | null;
    versoes: number;
    ativo: boolean;
    nivel: 'alto' | 'medio' | 'baixo';
    motivo: string;
    clusterId: string;
  }): Promise<void> {
    const { error } = await this.sb
      .from('ads')
      .update({
        dias_no_ar: ev.diasNoAr,
        versoes: ev.versoes,
        nivel_evidencia: ev.nivel,
        motivo: ev.motivo,
        cluster_id: ev.clusterId,
        is_active: ev.ativo,
      })
      .eq('id', adId);
    if (error) throw new Error(`updateAdEvidence: ${error.message}`);
  }

  async markChampionAds(adIds: string[]): Promise<void> {
    if (adIds.length === 0) return;
    const { error } = await this.sb.from('ads').update({ is_champion: true }).in('id', adIds);
    if (error) throw new Error(`markChampionAds: ${error.message}`);
  }

  async insertCreative(input: {
    investigationId: string;
    adId: string;
    candidateId: string;
    mediaType: 'image' | 'video';
    sourceUrl: string;
    previewUrl?: string | null;
  }): Promise<CreativeRow> {
    const data = (await this.must(
      await this.sb
        .from('creatives')
        .insert({
          investigation_id: input.investigationId,
          ad_id: input.adId,
          candidate_id: input.candidateId,
          media_type: input.mediaType,
          source_url: input.sourceUrl,
          preview_path: null,
          status: 'pendente',
        })
        .select('*')
        .single(),
      'insertCreative',
    )) as any;
    return {
      id: data.id,
      adId: data.ad_id,
      candidateId: data.candidate_id,
      mediaType: data.media_type,
      sourceUrl: data.source_url,
      previewUrl: input.previewUrl ?? null,
    };
  }

  async updateCreative(creativeId: string, patch: any): Promise<void> {
    const upd: Record<string, unknown> = {};
    if ('storagePath' in patch) upd.storage_path = patch.storagePath;
    if ('previewPath' in patch) upd.preview_path = patch.previewPath;
    if ('transcription' in patch) upd.transcription = patch.transcription;
    if ('transcriptionProvider' in patch) upd.transcription_provider = patch.transcriptionProvider;
    if ('analysis' in patch) upd.analysis = patch.analysis;
    if ('durationSeconds' in patch) upd.duration_seconds = patch.durationSeconds;
    if ('status' in patch) upd.status = patch.status;
    if ('error' in patch) upd.error = patch.error;
    const { error } = await this.sb.from('creatives').update(upd).eq('id', creativeId);
    if (error) throw new Error(`updateCreative: ${error.message}`);
  }

  async addCost(investigationId: string, entry: CostEntry): Promise<void> {
    const { error } = await this.sb.from('cost_log').insert({
      investigation_id: investigationId,
      provider: entry.provider,
      unit: entry.unit,
      quantity: entry.quantity,
      estimated_usd: entry.estimatedUsd,
      note: entry.note ?? null,
    });
    if (error) throw new Error(`addCost: ${error.message}`);
  }

  async getCostTotal(investigationId: string): Promise<number> {
    const { data, error } = await this.sb
      .from('cost_log')
      .select('estimated_usd')
      .eq('investigation_id', investigationId);
    if (error) throw new Error(`getCostTotal: ${error.message}`);
    return (data ?? []).reduce((s: number, r: any) => s + Number(r.estimated_usd), 0);
  }

  async setFinalCost(investigationId: string, usd: number): Promise<void> {
    const { error } = await this.sb
      .from('investigations')
      .update({ final_cost_usd: usd })
      .eq('id', investigationId);
    if (error) throw new Error(`setFinalCost: ${error.message}`);
  }

  async getCandidates(investigationId: string): Promise<CandidateRow[]> {
    const { data, error } = await this.sb
      .from('candidates')
      .select('*')
      .eq('investigation_id', investigationId);
    if (error) throw new Error(`getCandidates: ${error.message}`);
    return (data as any[]).map(this.mapCandidate);
  }

  private async groupedAds(
    investigationId: string,
    onlySelected: boolean,
  ): Promise<{ candidate: CandidateRow; ads: AdRow[] }[]> {
    let q = this.sb.from('candidates').select('*').eq('investigation_id', investigationId);
    if (onlySelected) q = q.eq('selected', true);
    const { data: cands, error: e1 } = await q;
    if (e1) throw new Error(`groupedAds candidates: ${e1.message}`);
    const { data: ads, error: e2 } = await this.sb
      .from('ads')
      .select('*')
      .eq('investigation_id', investigationId);
    if (e2) throw new Error(`groupedAds ads: ${e2.message}`);

    const byCand = new Map<string, AdRow[]>();
    for (const d of ads as any[]) {
      const row: AdRow = { id: d.id, candidateId: d.candidate_id, ad: this.mapAd(d) };
      const list = byCand.get(d.candidate_id) ?? [];
      list.push(row);
      byCand.set(d.candidate_id, list);
    }
    return (cands as any[]).map((c) => ({
      candidate: this.mapCandidate(c),
      ads: byCand.get(c.id) ?? [],
    }));
  }

  getAdsGrouped(investigationId: string) {
    return this.groupedAds(investigationId, false);
  }
  getSelectedCandidatesWithAds(investigationId: string) {
    return this.groupedAds(investigationId, true);
  }

  async getChampionAds(investigationId: string): Promise<AdRow[]> {
    const { data, error } = await this.sb
      .from('ads')
      .select('*')
      .eq('investigation_id', investigationId)
      .eq('is_champion', true);
    if (error) throw new Error(`getChampionAds: ${error.message}`);
    return (data as any[]).map((d) => ({ id: d.id, candidateId: d.candidate_id, ad: this.mapAd(d) }));
  }

  async getCreatives(investigationId: string): Promise<CreativeFull[]> {
    const { data, error } = await this.sb
      .from('creatives')
      .select('*, ads(body_text, title, cta_text, link_url), candidates(name, domain)')
      .eq('investigation_id', investigationId);
    if (error) throw new Error(`getCreatives: ${error.message}`);
    return (data as any[]).map((d) => ({
      id: d.id,
      adId: d.ad_id,
      candidateId: d.candidate_id,
      mediaType: d.media_type,
      sourceUrl: d.source_url,
      previewUrl: d.preview_path,
      storagePath: d.storage_path,
      transcription: d.transcription,
      analysis: d.analysis ?? null,
      durationSeconds: d.duration_seconds == null ? null : Number(d.duration_seconds),
      status: d.status,
      adBodyText: d.ads?.body_text ?? null,
      adTitle: d.ads?.title ?? null,
      adCtaText: d.ads?.cta_text ?? null,
      adLinkUrl: d.ads?.link_url ?? null,
      candidateName: d.candidates?.name ?? null,
      candidateDomain: d.candidates?.domain ?? null,
    }));
  }

  // ── Funil (fase 05) ──
  async uploadMedia(storagePath: string, data: Buffer | string, contentType: string): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const { error } = await this.sb.storage
      .from('creatives')
      .upload(storagePath, body, { contentType, upsert: true });
    if (error) throw new Error(`uploadMedia ${storagePath}: ${error.message}`);
  }

  async uploadMediaFromPath(storagePath: string, localPath: string, contentType: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(localPath);
    await this.uploadMedia(storagePath, buf, contentType);
  }

  async insertFunnel(input: {
    investigationId: string;
    candidateId: string | null;
    adId: string | null;
    entryUrl: string;
    domain: string | null;
  }): Promise<{ id: string }> {
    const data = (await this.must(
      await this.sb
        .from('funnels')
        .insert({
          investigation_id: input.investigationId,
          candidate_id: input.candidateId,
          ad_id: input.adId,
          entry_url: input.entryUrl,
          domain: input.domain,
          status: 'rodando',
        })
        .select('id')
        .single(),
      'insertFunnel',
    )) as any;
    return { id: data.id };
  }

  async updateFunnel(funnelId: string, patch: Record<string, any>): Promise<void> {
    const upd: Record<string, unknown> = {};
    if ('status' in patch) upd.status = patch.status;
    if ('checkoutPlatform' in patch) upd.checkout_platform = patch.checkoutPlatform;
    if ('videoPlayer' in patch) upd.video_player = patch.videoPlayer;
    if ('pixels' in patch) upd.pixels = patch.pixels;
    if ('manifests' in patch) upd.manifests = patch.manifests;
    if ('tech' in patch) upd.tech = patch.tech;
    if ('blocked' in patch) upd.blocked = patch.blocked;
    const { error } = await this.sb.from('funnels').update(upd).eq('id', funnelId);
    if (error) throw new Error(`updateFunnel: ${error.message}`);
  }

  async insertFunnelStep(input: {
    funnelId: string;
    investigationId: string;
    order: number;
    stepType: string | null;
    url: string;
    screenshotPath: string | null;
    htmlPath: string | null;
    textPath: string | null;
    requests: unknown[];
    analysis: unknown;
    blocked: boolean;
    loadMs: number | null;
  }): Promise<{ id: string }> {
    const data = (await this.must(
      await this.sb
        .from('funnel_steps')
        .insert({
          funnel_id: input.funnelId,
          investigation_id: input.investigationId,
          step_order: input.order,
          step_type: input.stepType,
          url: input.url,
          screenshot_path: input.screenshotPath,
          html_path: input.htmlPath,
          text_path: input.textPath,
          requests: input.requests,
          analysis: input.analysis,
          blocked: input.blocked,
          load_ms: input.loadMs,
        })
        .select('id')
        .single(),
      'insertFunnelStep',
    )) as any;
    return { id: data.id };
  }

  async getFunnelPixelIndex(): Promise<{ id: string; domain: string }[]> {
    const { data, error } = await this.sb.from('funnels').select('domain, pixels');
    if (error) throw new Error(`getFunnelPixelIndex: ${error.message}`);
    const out: { id: string; domain: string }[] = [];
    for (const row of (data as any[]) ?? []) {
      const domain = row.domain as string | null;
      if (!domain) continue;
      for (const px of (row.pixels as any[]) ?? []) {
        if (px?.id) out.push({ id: String(px.id), domain });
      }
    }
    return out;
  }

  // ── VSL (fase 06) ──
  async getVslTargets(investigationId: string): Promise<
    { funnelId: string | null; funnelStepId: string | null; url: string; player: string | null; manifestUrl: string | null }[]
  > {
    const [{ data: funnels, error: e1 }, { data: steps, error: e2 }] = await Promise.all([
      this.sb.from('funnels').select('id, entry_url, player:video_player, manifests').eq('investigation_id', investigationId),
      this.sb.from('funnel_steps').select('id, funnel_id, url, step_type').eq('investigation_id', investigationId),
    ]);
    if (e1) throw new Error(`getVslTargets funnels: ${e1.message}`);
    if (e2) throw new Error(`getVslTargets steps: ${e2.message}`);
    const funnelById = new Map((funnels as any[] ?? []).map((f) => [f.id, f]));
    const out: { funnelId: string | null; funnelStepId: string | null; url: string; player: string | null; manifestUrl: string | null }[] = [];
    const seen = new Set<string>();
    const push = (funnelId: string | null, stepId: string | null, url: string | null, f: any) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({
        funnelId,
        funnelStepId: stepId,
        url,
        player: f?.player ?? null,
        manifestUrl: (f?.manifests as string[] | null)?.[0] ?? null,
      });
    };
    // 1) Passos marcados como VSL.
    for (const s of (steps as any[]) ?? []) {
      if (s.step_type === 'vsl') push(s.funnel_id, s.id, s.url, funnelById.get(s.funnel_id));
    }
    // 2) Funis com player/manifest detectado (usa o passo VSL se houver, senão a entrada).
    for (const f of (funnels as any[]) ?? []) {
      const hasPlayer = !!f.player || ((f.manifests as any[]) ?? []).length > 0;
      if (!hasPlayer) continue;
      const vslStep = ((steps as any[]) ?? []).find((s) => s.funnel_id === f.id && s.step_type === 'vsl');
      push(f.id, vslStep?.id ?? null, vslStep?.url ?? f.entry_url, f);
    }
    return out;
  }

  async insertVsl(input: {
    investigationId: string;
    funnelId: string | null;
    funnelStepId: string | null;
    sourceUrl: string;
    player: string | null;
    manifestUrl: string | null;
  }): Promise<{ id: string }> {
    const data = (await this.must(
      await this.sb
        .from('vsls')
        .insert({
          investigation_id: input.investigationId,
          funnel_id: input.funnelId,
          funnel_step_id: input.funnelStepId,
          source_url: input.sourceUrl,
          player: input.player,
          manifest_url: input.manifestUrl,
          status: 'rodando',
        })
        .select('id')
        .single(),
      'insertVsl',
    )) as any;
    return { id: data.id };
  }

  async updateVsl(vslId: string, patch: Record<string, unknown>): Promise<void> {
    const map: Record<string, string> = {
      status: 'status',
      failReason: 'fail_reason',
      durationSeconds: 'duration_seconds',
      audioPath: 'audio_path',
      videoPath: 'video_path',
      videoBytes: 'video_bytes',
      transcription: 'transcription',
      segments: 'segments',
      approxTimestamps: 'approx_timestamps',
      partial: 'partial',
      missingChunks: 'missing_chunks',
      transcriptionProvider: 'transcription_provider',
      analysis: 'analysis',
      manifestUrl: 'manifest_url',
    };
    const upd: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (map[k]) upd[map[k]] = v;
    const { error } = await this.sb.from('vsls').update(upd).eq('id', vslId);
    if (error) throw new Error(`updateVsl: ${error.message}`);
  }

  async saveCandidateSummary(
    candidateId: string,
    s: { summary: string; hookPatterns: string[]; anglePatterns: string[] },
  ): Promise<void> {
    const { error } = await this.sb
      .from('candidates')
      .update({ summary: s.summary, hook_patterns: s.hookPatterns, angle_patterns: s.anglePatterns })
      .eq('id', candidateId);
    if (error) throw new Error(`saveCandidateSummary: ${error.message}`);
  }
}
