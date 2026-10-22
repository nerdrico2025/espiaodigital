import { retry } from '../util/retry.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'input_audio'; input_audio: { data: string; format: string } }
      >;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export async function openRouterChat(opts: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  jsonMode?: boolean;
  temperature?: number;
}): Promise<{ content: string; usage: OpenRouterUsage }> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  return retry(
    async () => {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Espiao de Ofertas',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as any;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenRouter: resposta sem content');
      return { content, usage: (json?.usage ?? {}) as OpenRouterUsage };
    },
    { label: 'OpenRouter chat', retries: 3, timeoutMs: 120_000 },
  );
}

/** Extrai o primeiro bloco JSON de um texto (tolerante a cercas markdown). */
export function parseJsonLoose<T = unknown>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    const lastObj = cleaned.lastIndexOf('}');
    const lastArr = cleaned.lastIndexOf(']');
    const to = Math.max(lastObj, lastArr);
    if (from >= 0 && to > from) return JSON.parse(cleaned.slice(from, to + 1)) as T;
    throw new Error('Não foi possível extrair JSON da resposta do LLM');
  }
}
