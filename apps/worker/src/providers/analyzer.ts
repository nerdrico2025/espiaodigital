import { z } from 'zod';
import type { CostEntry, CreativeAnalysis } from '@espiao/shared';
import { PRICE_REFERENCE } from '@espiao/shared';
import type { Analyzer } from '../interfaces.js';
import { openRouterChat, parseJsonLoose, type ChatMessage } from './openrouter.js';

const analysisSchema = z.object({
  hook: z.string().nullable(),
  angulo: z.enum(['curiosidade', 'dor', 'promessa', 'autoridade', 'contradicao']).nullable(),
  mecanismo: z.string().nullable(),
  prova: z.string().nullable(),
  cta: z.string().nullable(),
  twist: z.string().nullable(),
  blocos: z
    .array(z.object({ timestamp: z.string(), descricao: z.string() }))
    .nullable()
    .optional(),
  imagem: z
    .object({
      formato: z.string().nullable(),
      textoNaImagem: z.string().nullable(),
      estilo: z.string().nullable(),
      paleta: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

const SYSTEM = `Você é um analista de criativos de performance. Analise o criativo de anúncio e
responda SOMENTE um objeto JSON com as chaves:
hook, angulo, mecanismo, prova, cta, twist, blocos, imagem.
- angulo deve ser um de: curiosidade, dor, promessa, autoridade, contradicao (ou null).
- Para VSLs/vídeos longos, preencha "blocos" como lista de {timestamp, descricao}.
- Para imagens, preencha "imagem" {formato, textoNaImagem, estilo, paleta}.
- Campo "cta": quando houver domínio de destino (linkUrl), use-o como base do CTA;
  o texto ouvido/visível é só complemento. NUNCA invente um domínio que não apareça
  no linkUrl nem na transcrição.
- Use o "Contexto da marca" apenas para grafar nomes próprios corretamente.
- Se a informação NÃO estiver no material, use null. NUNCA invente.`;

/** Extrai o domínio registrável de uma URL (sem esquema/www/caminho). */
function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let h = String(url).trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  h = h.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  return h || null;
}

export class LlmAnalyzer implements Analyzer {
  constructor(private cfg: { apiKey: string; model: string }) {}

  async analyze(input: {
    mediaType: 'image' | 'video';
    bodyText: string | null;
    title: string | null;
    ctaText: string | null;
    transcription: string | null;
    imageUrl?: string | null;
    linkUrl?: string | null;
    context?: { brand?: string | null; domain?: string | null };
  }): Promise<{ analysis: CreativeAnalysis; cost: CostEntry[] }> {
    const linkDomain = domainFromUrl(input.linkUrl);
    const brandBits = [input.context?.brand, input.context?.domain]
      .filter((x): x is string => !!x && x.trim() !== '')
      .join(' — ');

    const parts: string[] = [
      `Tipo de mídia: ${input.mediaType}`,
      brandBits ? `Contexto da marca (só p/ grafia): ${brandBits}` : '',
      input.title ? `Título: ${input.title}` : '',
      input.bodyText ? `Texto do anúncio: ${input.bodyText}` : '',
      input.ctaText ? `CTA (texto visível): ${input.ctaText}` : '',
      linkDomain
        ? `Domínio de destino (linkUrl): ${linkDomain} — base preferencial do campo "cta".`
        : `Sem domínio de destino conhecido — não invente domínios no campo "cta".`,
      input.transcription ? `Transcrição do vídeo:\n${input.transcription}` : '',
    ].filter(Boolean);

    const content: ChatMessage['content'] =
      input.mediaType === 'image' && input.imageUrl
        ? [
            { type: 'text', text: parts.join('\n') },
            { type: 'image_url', image_url: { url: input.imageUrl } },
          ]
        : parts.join('\n');

    const { content: out, usage } = await openRouterChat({
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      jsonMode: true,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
    });

    const parsed = parseJsonLoose(out);
    const safe = analysisSchema.safeParse(parsed);
    const analysis: CreativeAnalysis = safe.success
      ? {
          hook: safe.data.hook,
          angulo: safe.data.angulo,
          mecanismo: safe.data.mecanismo,
          prova: safe.data.prova,
          cta: safe.data.cta,
          twist: safe.data.twist,
          blocos: safe.data.blocos ?? null,
          imagem: safe.data.imagem ?? null,
        }
      : emptyAnalysis();

    // CTA: prefere o domínio real do linkUrl; o texto ouvido/visível é complemento.
    // (Não inventa domínio: linkDomain vem do próprio linkUrl do anúncio.)
    if (linkDomain) {
      const cur = analysis.cta?.trim() ?? '';
      const already = cur.toLowerCase().includes(linkDomain);
      analysis.cta = already ? cur : cur ? `${linkDomain} — ${cur}` : linkDomain;
    }

    const cost: CostEntry[] = [
      {
        provider: 'openrouter',
        unit: 'analise-criativo',
        quantity: usage.total_tokens ?? 1,
        estimatedUsd: PRICE_REFERENCE.llmPerCreativeUsd,
        note: this.cfg.model,
      },
    ];
    return { analysis, cost };
  }
}

function emptyAnalysis(): CreativeAnalysis {
  return {
    hook: null,
    angulo: null,
    mecanismo: null,
    prova: null,
    cta: null,
    twist: null,
    blocos: null,
    imagem: null,
  };
}
