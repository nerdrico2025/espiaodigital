import type { Candidate, MediaRef, NormalizedAd } from '@espiao/shared';

// Mapeia a saída BRUTA do actor apify/facebook-ads-scraper para NormalizedAd.
//
// O schema de ENTRADA foi confirmado via Apify (startUrls, resultsLimit,
// activeStatus, sorting, onlyAdsNewerThan/OlderThan, isDetailsPerAd...).
// A SAÍDA do actor é baseada em `snapshot`; como os nomes exatos de campo
// podem variar entre versões, este normalizador é defensivo e tenta
// múltiplos nomes. Revalide contra um run real na primeira execução.

type Raw = Record<string, any>;

function asMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    // segundos (10 dígitos) → ms
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== '') return asMs(n);
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

function toArray<T = any>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v == null) return [];
  return [v as T];
}

function pickStr(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function extractImages(snapshot: Raw): MediaRef[] {
  const out: MediaRef[] = [];
  // O actor usa camelCase (originalImageUrl…); snake_case fica como fallback.
  for (const im of [...toArray(snapshot?.images), ...toArray(snapshot?.extraImages)]) {
    const url = pickStr(
      im?.originalImageUrl,
      im?.resizedImageUrl,
      im?.watermarkedResizedImageUrl,
      im?.original_image_url,
      im?.resized_image_url,
      im?.url,
      im,
    );
    if (url)
      out.push({ url, previewUrl: pickStr(im?.resizedImageUrl, im?.resized_image_url) });
  }
  for (const card of toArray(snapshot?.cards)) {
    const url = pickStr(
      card?.originalImageUrl,
      card?.resizedImageUrl,
      card?.original_image_url,
      card?.resized_image_url,
      card?.image_url,
    );
    if (url)
      out.push({ url, previewUrl: pickStr(card?.resizedImageUrl, card?.resized_image_url) });
  }
  return dedupeMedia(out);
}

function extractVideos(snapshot: Raw): MediaRef[] {
  const out: MediaRef[] = [];
  for (const v of [...toArray(snapshot?.videos), ...toArray(snapshot?.extraVideos)]) {
    const url = pickStr(v?.videoHdUrl, v?.videoSdUrl, v?.video_hd_url, v?.video_sd_url, v?.url);
    if (url)
      out.push({
        url,
        previewUrl: pickStr(
          v?.videoPreviewImageUrl,
          v?.video_preview_image_url,
          v?.thumbnailUrl,
          v?.thumbnail_url,
        ),
      });
  }
  for (const card of toArray(snapshot?.cards)) {
    const url = pickStr(card?.videoHdUrl, card?.videoSdUrl, card?.video_hd_url, card?.video_sd_url);
    if (url)
      out.push({ url, previewUrl: pickStr(card?.videoPreviewImageUrl, card?.video_preview_image_url) });
  }
  return dedupeMedia(out);
}

// Extrai o país (ISO) da URL da Ad Library usada como startUrl (ex.: country=BR).
function countryFromInputUrl(raw: Raw): string | null {
  const u = pickStr(raw?.inputUrl, raw?.url);
  if (!u) return null;
  const m = /[?&]country=([a-zA-Z]{2})\b/.exec(u);
  return m && m[1] ? m[1].toUpperCase() : null;
}

function dedupeMedia(arr: MediaRef[]): MediaRef[] {
  const seen = new Set<string>();
  const out: MediaRef[] = [];
  for (const m of arr) {
    if (seen.has(m.url)) continue;
    seen.add(m.url);
    out.push(m);
  }
  return out;
}

function normalizePlatforms(v: unknown): string[] {
  return toArray<string>(v)
    .map((p) => String(p).toUpperCase().trim())
    .filter(Boolean);
}

export function normalizeAd(raw: Raw): NormalizedAd | null {
  const snapshot: Raw = raw?.snapshot ?? raw?.snapshot_json ?? raw ?? {};

  const adArchiveId = pickStr(
    raw?.adArchiveID,
    raw?.ad_archive_id,
    raw?.adArchiveId,
    raw?.adid,
    snapshot?.ad_archive_id,
  );
  if (!adArchiveId) return null;

  const bodyText = pickStr(
    snapshot?.body?.text,
    snapshot?.body,
    raw?.bodyText,
    raw?.ad_creative_body,
  );

  const variations =
    firstNumber(raw?.collationCount, raw?.collation_count, raw?.variationsCount, raw?.totalAds) ??
    1;

  const platforms = normalizePlatforms(
    raw?.publisherPlatform ?? raw?.publisher_platform ?? raw?.publisherPlatforms,
  );

  let countries = toArray<string>(
    raw?.targetedOrReachedCountries ??
      raw?.reachedCountries ??
      raw?.countries ??
      snapshot?.countryIsoCode ??
      snapshot?.country,
  )
    .map((c) => String(c).toUpperCase().trim())
    .filter(Boolean);
  // Fallback: o actor costuma deixar os países vazios; usa o país da busca (URL).
  if (countries.length === 0) {
    const fromUrl = countryFromInputUrl(raw);
    if (fromUrl) countries = [fromUrl];
  }

  return {
    adArchiveId,
    pageName: pickStr(raw?.pageName, snapshot?.pageName, snapshot?.page_name, raw?.page_name),
    bodyText,
    title: pickStr(snapshot?.title, raw?.title),
    ctaText: pickStr(snapshot?.ctaText, snapshot?.cta_text, raw?.ctaText, raw?.cta_text),
    ctaType: pickStr(snapshot?.ctaType, snapshot?.cta_type, raw?.ctaType),
    linkUrl: pickStr(snapshot?.linkUrl, snapshot?.link_url, raw?.linkUrl, snapshot?.caption),
    startDate: asMs(raw?.startDate ?? raw?.start_date ?? raw?.ad_delivery_start_time),
    endDate: asMs(raw?.endDate ?? raw?.end_date ?? raw?.ad_delivery_stop_time),
    isActive: Boolean(raw?.isActive ?? raw?.is_active ?? (raw?.endDate == null)),
    platforms,
    countries,
    variations: Math.max(1, variations),
    images: extractImages(snapshot),
    videos: extractVideos(snapshot),
    raw,
  };
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

export function normalizeAds(items: Raw[]): NormalizedAd[] {
  const out: NormalizedAd[] = [];
  for (const it of items) {
    const n = normalizeAd(it);
    if (n) out.push(n);
  }
  return out;
}

// ── Filtro de "anúncios próprios" ───────────────────────────────
// A busca por palavra-chave na Ad Library traz anúncios de terceiros que só
// mencionam a marca. Aqui mantemos apenas os que são, de fato, do candidato.

/** Normaliza texto: minúsculas, sem acentos, só alfanumérico (p/ comparação). */
function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Distância de Levenshtein (para tolerar pequenas variações de nome). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur.push(Math.min(prev[j + 1]! + 1, cur[j]! + 1, prev[j]! + cost));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Igualdade tolerante: idêntico, contido, ou distância pequena (~20%). */
function nameMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const tol = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.2));
  return levenshtein(a, b) <= tol;
}

/** Domínio registrável simplificado a partir de uma URL ou host. */
function hostOf(urlOrHost: unknown): string {
  let h = String(urlOrHost ?? '').trim().toLowerCase();
  if (!h) return '';
  h = h.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  h = h.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  return h;
}

/** Dois hosts "batem" se iguais ou um é subdomínio do outro. */
function domainMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/** ID da página do anúncio, lido do objeto bruto do actor. */
export function adPageId(ad: NormalizedAd): string | null {
  const raw = (ad.raw ?? {}) as Raw;
  return pickStr(raw?.pageId, raw?.pageID, raw?.snapshot?.pageId);
}

/** Critério pelo qual um anúncio foi considerado "próprio" do candidato. */
export type KeepBasis = 'nome' | 'pageId' | 'dominio';

export interface OwnAdMatch {
  ad: NormalizedAd;
  basis: KeepBasis;
}

export interface PageIdVote {
  /** pageId escolhido, ou null se ausente ou votos divididos. */
  pageId: string | null;
  /** pageIds candidatos que apareceram no pool de votação. */
  candidates: string[];
  /** true quando nenhum pageId passou de 50% dos votos. */
  split: boolean;
  /** De qual pool saiu o voto: nome (inclui pageId) ou domínio. */
  from: 'nome' | 'dominio' | null;
}

/**
 * Escolhe o pageId da página "dona" entre os anúncios mantidos, dando
 * PRIORIDADE aos que casaram por nome (ou pageId): se houver pelo menos um
 * mantido por nome/pageId, vota só entre esses; os mantidos apenas por domínio
 * de linkUrl são fallback quando nenhum bateu por nome. Se os votos ficarem
 * divididos (nenhum pageId com MAIS de 50%), não devolve pageId (split=true).
 */
export function mostFrequentPageId(matches: OwnAdMatch[]): PageIdVote {
  const byNameOrId = matches.filter((m) => m.basis === 'nome' || m.basis === 'pageId');
  const pool = byNameOrId.length ? byNameOrId : matches.filter((m) => m.basis === 'dominio');
  const from: 'nome' | 'dominio' | null = byNameOrId.length
    ? 'nome'
    : pool.length
      ? 'dominio'
      : null;

  const counts = new Map<string, number>();
  for (const m of pool) {
    const id = adPageId(m.ad);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const candidates = [...counts.keys()];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { pageId: null, candidates, split: false, from };

  let top: string | null = null;
  let topN = 0;
  for (const [id, n] of counts) {
    if (n > topN) {
      top = id;
      topN = n;
    }
  }
  // Maioria estrita: top precisa de MAIS de 50% dos votos do pool.
  const majority = topN * 2 > total;
  if (!majority) return { pageId: null, candidates, split: true, from };
  return { pageId: top, candidates, split: false, from };
}

/**
 * Mantém só os anúncios do próprio candidato e anota o critério de cada um.
 * Um anúncio é "próprio" se atender a PELO MENOS UM critério (prioridade
 * nome > pageId > domínio ao rotular):
 *  - nome: pageName bate com o nome do candidato (normalizado, tolerante);
 *  - pageId: é o pageId esperado (candidate.facebookPage, quando ID/handle);
 *  - domínio: o domínio de linkUrl é o domínio do candidato.
 */
export function filterOwnAds(
  ads: NormalizedAd[],
  candidate: Pick<Candidate, 'name' | 'domain' | 'facebookPage'>,
): { kept: NormalizedAd[]; discarded: NormalizedAd[]; matches: OwnAdMatch[] } {
  const candName = norm(candidate.name);
  const candDomain = hostOf(candidate.domain);
  const candPage = candidate.facebookPage ?? null;
  const candPageId = candPage && /^\d{5,}$/.test(candPage.trim()) ? candPage.trim() : null;
  const candPageName = candPage ? norm(candPage) : '';

  const matches: OwnAdMatch[] = [];
  const discarded: NormalizedAd[] = [];
  for (const ad of ads) {
    const byName = nameMatches(norm(ad.pageName), candName);
    const pid = adPageId(ad);
    const byPageId =
      (candPageId != null && pid != null && pid === candPageId) ||
      (candPageName !== '' && nameMatches(norm(ad.pageName), candPageName));
    const byDomain =
      candDomain !== '' && ad.linkUrl != null && domainMatches(hostOf(ad.linkUrl), candDomain);

    if (byName) matches.push({ ad, basis: 'nome' });
    else if (byPageId) matches.push({ ad, basis: 'pageId' });
    else if (byDomain) matches.push({ ad, basis: 'dominio' });
    else discarded.push(ad);
  }
  return { kept: matches.map((m) => m.ad), discarded, matches };
}
