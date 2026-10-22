import type { Candidate, CostEntry, NormalizedAd } from '@espiao/shared';
import { PRICE_REFERENCE } from '@espiao/shared';
import type { AdsProvider } from '../interfaces.js';
import { retry } from '../util/retry.js';
import { normalizeAds } from '../pipeline/normalize.js';

/**
 * Monta uma URL de BUSCA da Meta Ad Library já com o país.
 * (No actor, o país vem pela URL — não há campo "country" no input.)
 */
export function buildAdLibraryUrl(opts: {
  country: string;
  query: string;
  onlyActive: boolean;
}): string {
  const params = new URLSearchParams({
    active_status: opts.onlyActive ? 'active' : 'all',
    ad_type: 'all',
    country: opts.country.toUpperCase(),
    q: opts.query,
    search_type: 'keyword_unordered',
    media_type: 'all',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

/**
 * Monta uma URL da Ad Library por PÁGINA (search_type=page & view_all_page_id).
 * Formato confirmado no input schema do actor apify/facebook-ads-scraper.
 */
export function buildPageAdLibraryUrl(opts: {
  country: string;
  pageId: string;
  onlyActive: boolean;
}): string {
  const params = new URLSearchParams({
    active_status: opts.onlyActive ? 'active' : 'all',
    ad_type: 'all',
    country: opts.country.toUpperCase(),
    media_type: 'all',
    search_type: 'page',
    view_all_page_id: opts.pageId,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

export class ApifyAdsProvider implements AdsProvider {
  constructor(private cfg: { token: string; actor: string }) {}

  private actorPath(): string {
    // API usa "~" no lugar de "/": apify/facebook-ads-scraper -> apify~facebook-ads-scraper
    return this.cfg.actor.replace('/', '~');
  }

  async fetchAds(
    candidate: Candidate,
    opts: { country: string; onlyActive: boolean; limit: number },
  ): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }> {
    // Busca só pela marca: com search_type=keyword_unordered, incluir o domínio
    // como palavra-chave exige casar todos os termos e zera os resultados.
    const query = candidate.name.trim();
    const url = buildAdLibraryUrl({ country: opts.country, query, onlyActive: opts.onlyActive });
    return this.runActor(url, opts.limit, opts.onlyActive, `marca:${candidate.name}`);
  }

  async fetchAdsByPage(
    pageId: string,
    opts: { country: string; onlyActive: boolean; limit: number },
  ): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }> {
    const url = buildPageAdLibraryUrl({ country: opts.country, pageId, onlyActive: opts.onlyActive });
    return this.runActor(url, opts.limit, opts.onlyActive, `página:${pageId}`);
  }

  /** Dispara o actor com uma startUrl e normaliza o resultado. */
  private async runActor(
    url: string,
    limit: number,
    onlyActive: boolean,
    label: string,
  ): Promise<{ ads: NormalizedAd[]; cost: CostEntry[] }> {
    // Campos de entrada confirmados via Apify (actor id JJghSZmShuco4j9gJ).
    const input = {
      startUrls: [{ url }],
      resultsLimit: limit,
      activeStatus: onlyActive ? 'active' : '',
      isDetailsPerAd: false,
    };

    const endpoint =
      `https://api.apify.com/v2/acts/${this.actorPath()}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(this.cfg.token)}&clean=true&format=json`;

    const items = await retry(
      async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`Apify ${res.status}: ${t.slice(0, 300)}`);
        }
        return (await res.json()) as any[];
      },
      { label: `Apify (${label})`, retries: 3, timeoutMs: 180_000 },
    );

    const ads = normalizeAds(Array.isArray(items) ? items : []);
    const cost: CostEntry[] = [
      {
        provider: 'apify',
        unit: 'ad',
        quantity: ads.length,
        estimatedUsd: ads.length * PRICE_REFERENCE.apifyPerAdUsd,
        note: this.cfg.actor,
      },
    ];
    return { ads, cost };
  }
}
