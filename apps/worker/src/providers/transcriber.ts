import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CostEntry } from '@espiao/shared';
import { PRICE_REFERENCE } from '@espiao/shared';
import type { Transcriber } from '../interfaces.js';
import { retry } from '../util/retry.js';

export interface TranscriberConfig {
  provider: 'openrouter' | 'openai';
  transcriptionModel: string;
  openRouterKey?: string;
  openaiKey?: string;
}

/**
 * Transcriber com dois provedores e fallback automático.
 * - openai: Whisper API (whisper-1), idioma pt. Formato de áudio bem definido.
 * - openrouter: modelo multimodal com entrada de áudio (input_audio base64).
 *   OBS: o formato aceito pelo OpenRouter varia por modelo — enviamos WAV e,
 *   se falhar, caímos para o OpenAI. Verifique o formato ao trocar de modelo.
 */
export class RealTranscriber implements Transcriber {
  constructor(private cfg: TranscriberConfig) {}

  async transcribe(input: {
    audioPath: string;
    durationSeconds: number | null;
    context?: { brand?: string | null; domain?: string | null };
  }): Promise<{
    text: string;
    provider: 'openrouter' | 'openai';
    cost: CostEntry[];
  }> {
    const order: ('openrouter' | 'openai')[] =
      this.cfg.provider === 'openrouter' ? ['openrouter', 'openai'] : ['openai', 'openrouter'];

    let lastErr: unknown;
    for (const provider of order) {
      try {
        const text =
          provider === 'openai'
            ? await this.viaOpenAI(input.audioPath, input.context)
            : await this.viaOpenRouter(input.audioPath, input.context);
        const minutes = (input.durationSeconds ?? 0) / 60;
        const cost: CostEntry[] = [
          {
            provider: `transcription:${provider}`,
            unit: 'minuto',
            quantity: minutes,
            estimatedUsd: minutes * PRICE_REFERENCE.whisperPerMinuteUsd,
            note: provider === 'openai' ? 'whisper-1' : this.cfg.transcriptionModel,
          },
        ];
        return { text, provider, cost };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Transcrição falhou em todos os provedores: ${String(lastErr)}`);
  }

  /** Monta uma dica curta de marca/domínio para orientar a grafia. */
  private brandHint(ctx?: { brand?: string | null; domain?: string | null }): string {
    const parts = [ctx?.brand, ctx?.domain].filter((x): x is string => !!x && x.trim() !== '');
    return parts.length ? `Marca mencionada: ${parts.join(' — ')}.` : '';
  }

  private async viaOpenAI(
    audioPath: string,
    ctx?: { brand?: string | null; domain?: string | null },
  ): Promise<string> {
    if (!this.cfg.openaiKey) throw new Error('OPENAI_API_KEY ausente');
    const buf = await readFile(audioPath);
    const hint = this.brandHint(ctx);
    return retry(
      async () => {
        const form = new FormData();
        form.append('file', new Blob([buf]), path.basename(audioPath));
        form.append('model', 'whisper-1');
        form.append('language', 'pt');
        // `prompt` do Whisper melhora a grafia de nomes próprios/marcas.
        if (hint) form.append('prompt', hint);
        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cfg.openaiKey}` },
          body: form,
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`OpenAI Whisper ${res.status}: ${t.slice(0, 200)}`);
        }
        const json = (await res.json()) as { text?: string };
        if (!json.text) throw new Error('Whisper: resposta sem texto');
        return json.text;
      },
      { label: 'OpenAI Whisper', retries: 2, timeoutMs: 120_000 },
    );
  }

  private async viaOpenRouter(
    audioPath: string,
    ctx?: { brand?: string | null; domain?: string | null },
  ): Promise<string> {
    if (!this.cfg.openRouterKey) throw new Error('OPENROUTER_API_KEY ausente');
    const buf = await readFile(audioPath);
    const b64 = buf.toString('base64');
    const format = path.extname(audioPath).replace('.', '') || 'wav';
    const hint = this.brandHint(ctx);
    const promptText =
      `Transcreva o áudio em português. Responda só a transcrição.` +
      (hint ? ` ${hint} Use a grafia correta dessa marca quando ela aparecer.` : '');
    return retry(
      async () => {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.openRouterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.cfg.transcriptionModel,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: promptText },
                  { type: 'input_audio', input_audio: { data: b64, format } },
                ],
              },
            ],
          }),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`OpenRouter áudio ${res.status}: ${t.slice(0, 200)}`);
        }
        const json = (await res.json()) as any;
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('OpenRouter áudio: sem content');
        return text;
      },
      { label: 'OpenRouter áudio', retries: 2, timeoutMs: 120_000 },
    );
  }
}
