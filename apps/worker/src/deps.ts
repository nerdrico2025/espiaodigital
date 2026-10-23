import type { Deps, Logger } from './interfaces.js';
import { readEnv, hasRealKeys, type WorkerEnv } from './env.js';
import { SupabaseDb } from './db/supabase-db.js';
import { ExaDiscovery } from './providers/exa-discovery.js';
import { ApifyAdsProvider } from './providers/apify-ads.js';
import { LlmAnalyzer } from './providers/analyzer.js';
import { RealTranscriber } from './providers/transcriber.js';
import { RealMedia, type Uploader } from './providers/media.js';
import { PlaywrightFunnel } from './providers/funnel.js';

export const defaultLogger: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ lvl: 'info', m, meta, t: new Date().toISOString() })),
  warn: (m, meta) => console.warn(JSON.stringify({ lvl: 'warn', m, meta, t: new Date().toISOString() })),
  error: (m, meta) => console.error(JSON.stringify({ lvl: 'error', m, meta, t: new Date().toISOString() })),
};

export function buildRealDeps(env: WorkerEnv = readEnv()): { deps: Deps; db: SupabaseDb } {
  if (!hasRealKeys(env)) {
    throw new Error(
      'Chaves reais ausentes. Preencha APIFY_TOKEN, EXA_API_KEY, OPENROUTER_API_KEY, ' +
        'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.',
    );
  }
  const db = new SupabaseDb(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

  const uploader: Uploader = {
    async upload(storagePath, data, contentType) {
      const { error } = await db.client.storage
        .from('creatives')
        .upload(storagePath, data, { contentType, upsert: true });
      if (error) throw new Error(`storage upload ${storagePath}: ${error.message}`);
    },
  };

  const deps: Deps = {
    db,
    discovery: new ExaDiscovery({
      exaKey: env.EXA_API_KEY!,
      openRouterKey: env.OPENROUTER_API_KEY!,
      discoveryModel: env.LLM_MODEL_DISCOVERY,
    }),
    ads: new ApifyAdsProvider({ token: env.APIFY_TOKEN!, actor: env.APIFY_META_ADS_ACTOR }),
    media: new RealMedia(uploader),
    transcriber: new RealTranscriber({
      provider: env.TRANSCRIPTION_PROVIDER,
      transcriptionModel: env.TRANSCRIPTION_MODEL,
      openRouterKey: env.OPENROUTER_API_KEY,
      openaiKey: env.OPENAI_API_KEY,
    }),
    analyzer: new LlmAnalyzer({ apiKey: env.OPENROUTER_API_KEY!, model: env.LLM_MODEL_ANALYSIS }),
    funnel: new PlaywrightFunnel(),
    clock: { now: () => Date.now() },
    log: defaultLogger,
  };
  return { deps, db };
}
