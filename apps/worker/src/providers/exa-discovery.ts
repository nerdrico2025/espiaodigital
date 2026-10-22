import { z } from 'zod';
import type { Candidate, CostEntry, InvestigationInput } from '@espiao/shared';
import type { Discovery } from '../interfaces.js';
import { retry } from '../util/retry.js';
import { openRouterChat, parseJsonLoose } from './openrouter.js';

const EXA_URL = 'https://api.exa.ai/search';

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
}

const candidateSchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable().optional(),
  facebookPage: z.string().nullable().optional(),
  offerType: z.string().nullable().optional(),
});

/** Monta as queries de intenção comercial a partir da entrada. */
export function buildQueries(query: string): string[] {
  const q = query.trim();
  return [
    `alternativas a ${q}`,
    `${q} vs`,
    `melhor app de ${q}`,
    `${q} app review`,
  ];
}

export class ExaDiscovery implements Discovery {
  constructor(
    private cfg: { exaKey: string; openRouterKey: string; discoveryModel: string },
  ) {}

  private async exaSearch(query: string): Promise<ExaResult[]> {
    return retry(
      async () => {
        const res = await fetch(EXA_URL, {
          method: 'POST',
          headers: { 'x-api-key': this.cfg.exaKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            numResults: 8,
            type: 'auto',
            contents: { text: { maxCharacters: 1200 } },
          }),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`EXA ${res.status}: ${t.slice(0, 200)}`);
        }
        const json = (await res.json()) as any;
        return (json?.results ?? []) as ExaResult[];
      },
      { label: `EXA (${query})`, retries: 3, timeoutMs: 30_000 },
    );
  }

  async discover(
    input: InvestigationInput,
    limit: { min: number; max: number },
  ): Promise<{ candidates: Candidate[]; cost: CostEntry[] }> {
    const queries = buildQueries(input.query);
    const cost: CostEntry[] = [];

    const resultsByQuery: { query: string; results: ExaResult[] }[] = [];
    for (const q of queries) {
      const results = await this.exaSearch(q);
      resultsByQuery.push({ query: q, results });
      cost.push({ provider: 'exa', unit: 'busca', quantity: 1, estimatedUsd: 0.005 });
    }

    const corpus = resultsByQuery
      .flatMap((r) =>
        r.results.map((x) => `# ${x.title ?? ''}\nURL: ${x.url ?? ''}\n${(x.text ?? '').slice(0, 800)}`),
      )
      .join('\n\n---\n\n')
      .slice(0, 24_000);

    const sys =
      'Você extrai concorrentes de um nicho a partir de resultados de busca. ' +
      'Responda SOMENTE um objeto JSON {"candidates": [{name, domain, facebookPage, offerType}]}. ' +
      'Deduplique por domínio/nome. Não invente: se não souber, use null. ' +
      `Gere entre ${limit.min} e ${limit.max} candidatos, priorizando apps/produtos reais do nicho.`;

    const user =
      `Nicho/alvo: "${input.query}" | País: ${input.country}.\n\n` +
      `Resultados de busca:\n\n${corpus}`;

    const { content, usage } = await openRouterChat({
      apiKey: this.cfg.openRouterKey,
      model: this.cfg.discoveryModel,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      jsonMode: true,
    });
    cost.push({
      provider: 'openrouter',
      unit: 'extracao-candidatos',
      quantity: usage.total_tokens ?? 1,
      estimatedUsd: 0.02,
      note: this.cfg.discoveryModel,
    });

    const parsed = parseJsonLoose<{ candidates?: unknown[] }>(content);
    const raw = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const item of raw) {
      const ok = candidateSchema.safeParse(item);
      if (!ok.success) continue;
      const c = ok.data;
      const key = (c.domain ?? c.name).toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        id: cryptoId(),
        name: c.name.trim(),
        domain: c.domain?.trim() || null,
        facebookPage: c.facebookPage?.trim() || null,
        offerType: c.offerType?.trim() || null,
        source: 'exa',
      });
      if (candidates.length >= limit.max) break;
    }

    return { candidates, cost };
  }
}

function cryptoId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `c_${Date.now()}_${Math.random().toString(36).slice(2)}`);
}
