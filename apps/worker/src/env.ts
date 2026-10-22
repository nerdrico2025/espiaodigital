// Leitura e validação de variáveis de ambiente do worker.
export interface WorkerEnv {
  APIFY_TOKEN?: string;
  EXA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APIFY_META_ADS_ACTOR: string;
  LLM_MODEL_ANALYSIS: string;
  LLM_MODEL_DISCOVERY: string;
  TRANSCRIPTION_PROVIDER: 'openrouter' | 'openai';
  TRANSCRIPTION_MODEL: string;
}

export function readEnv(src: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const tp = (src.TRANSCRIPTION_PROVIDER ?? 'openai').toLowerCase();
  return {
    APIFY_TOKEN: src.APIFY_TOKEN,
    EXA_API_KEY: src.EXA_API_KEY,
    OPENROUTER_API_KEY: src.OPENROUTER_API_KEY,
    OPENAI_API_KEY: src.OPENAI_API_KEY,
    SUPABASE_URL: src.NEXT_PUBLIC_SUPABASE_URL ?? src.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: src.SUPABASE_SERVICE_ROLE_KEY,
    APIFY_META_ADS_ACTOR: src.APIFY_META_ADS_ACTOR ?? 'apify/facebook-ads-scraper',
    LLM_MODEL_ANALYSIS: src.LLM_MODEL_ANALYSIS ?? 'anthropic/claude-sonnet-4.5',
    LLM_MODEL_DISCOVERY: src.LLM_MODEL_DISCOVERY ?? 'anthropic/claude-sonnet-4.5',
    TRANSCRIPTION_PROVIDER: tp === 'openrouter' ? 'openrouter' : 'openai',
    TRANSCRIPTION_MODEL: src.TRANSCRIPTION_MODEL ?? 'whisper-1',
  };
}

export function hasRealKeys(env: WorkerEnv): boolean {
  return Boolean(
    env.APIFY_TOKEN &&
      env.EXA_API_KEY &&
      env.OPENROUTER_API_KEY &&
      env.SUPABASE_URL &&
      env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
