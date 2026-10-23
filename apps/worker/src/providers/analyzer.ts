import { z } from 'zod';
import type {
  CostEntry,
  CreativeAnalysis,
  FunnelStepAnalysis,
  VslAnalysis,
  VslBlock,
  VslSegment,
  VslSummary,
} from '@espiao/shared';
import { PRICE_REFERENCE, VSL_BLOCKS } from '@espiao/shared';
import type { Analyzer } from '../interfaces.js';
import { openRouterChat, parseJsonLoose, type ChatMessage } from './openrouter.js';

// ── Salvamento tolerante do mapeamento de VSL ────────────────
// O modelo às vezes devolve um campo fora do formato (nota como string, bloco
// como número, resumo faltando uma chave). Em vez de um zod all-or-nothing que
// jogava TODA a análise fora, aproveitamos campo a campo.
function asStr(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return null;
}
function asNum(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}
function asStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asStr(x)).filter((x): x is string => !!x);
}
/** Normaliza a chave do bloco ("1", "bloco 01", 1) para "01".."11". */
function normBlocoKey(v: unknown): string {
  const m = String(v ?? '').match(/\d+/);
  return m ? m[0].padStart(2, '0') : '';
}

/**
 * Constrói a VslAnalysis a partir do JSON (possivelmente torto) do modelo.
 * - Resumo e blocos são aproveitados campo a campo.
 * - Citação que NÃO existe na transcrição é removida; o bloco permanece.
 * - mapeamentoOk = true se há qualquer conteúdo útil (resumo ou bloco presente).
 * Exportada para o smoke exercitar o validador sem rede.
 */
export function buildVslAnalysis(
  raw: unknown,
  transcription: string,
  opts: { parcial: boolean; ctaInfo?: { cta: string; aparecemSeg: number | null }[] | null },
): { analysis: VslAnalysis; mapeamentoOk: boolean; mapeamentoMotivo: string | null } {
  const lower = (transcription ?? '').toLowerCase();
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const rawResumo = (obj?.resumo && typeof obj.resumo === 'object' ? (obj.resumo as Record<string, unknown>) : {}) as Record<string, unknown>;
  const rawStack = rawResumo.stack && typeof rawResumo.stack === 'object' ? (rawResumo.stack as Record<string, unknown>) : null;

  const resumo: VslSummary = {
    bigIdea: asStr(rawResumo.bigIdea),
    mecanismo: asStr(rawResumo.mecanismo),
    oferta: asStr(rawResumo.oferta),
    preco: asStr(rawResumo.preco),
    stack: rawStack
      ? { itens: asStrArray(rawStack.itens), bonus: asStrArray(rawStack.bonus), valorAlegado: asStr(rawStack.valorAlegado) }
      : null,
    garantia: asStr(rawResumo.garantia),
    emocaoDominante: asStr(rawResumo.emocaoDominante),
    vilao: asStr(rawResumo.vilao),
    diferencial: asStr(rawResumo.diferencial),
  };

  const rawBlocos = Array.isArray(obj?.blocos) ? (obj!.blocos as unknown[]) : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const b of rawBlocos) {
    if (b && typeof b === 'object') byKey.set(normBlocoKey((b as any).bloco), b as Record<string, unknown>);
  }
  const blocos: VslBlock[] = VSL_BLOCKS.map((def) => {
    const b = byKey.get(def.key);
    // Mantém só citações que EXISTEM na transcrição — sem derrubar o bloco.
    const citacoes = asStrArray(b?.citacoes)
      .filter((c) => lower.includes(c.toLowerCase().slice(0, 40)))
      .slice(0, 3);
    return {
      bloco: def.key,
      nome: def.nome,
      presente: asBool(b?.presente),
      inicio: asStr(b?.inicio),
      fim: asStr(b?.fim),
      citacoes,
      analise: asStr(b?.analise),
      nota: asNum(b?.nota),
    };
  });

  const temResumo = [
    resumo.bigIdea, resumo.mecanismo, resumo.oferta, resumo.preco,
    resumo.garantia, resumo.emocaoDominante, resumo.vilao, resumo.diferencial,
  ].some(Boolean);
  const temBloco = blocos.some((b) => b.presente || b.analise);
  const mapeamentoOk = temResumo || temBloco;
  const mapeamentoMotivo = mapeamentoOk
    ? null
    : obj
      ? 'o modelo não retornou resumo nem blocos preenchidos'
      : 'resposta do modelo não era JSON válido';

  const analysis: VslAnalysis = {
    resumo,
    blocos,
    ctaButtons: opts.ctaInfo ?? null,
    parcialAviso: opts.parcial
      ? 'Transcrição parcial: alguns trechos falharam; a análise pode estar incompleta.'
      : null,
  };
  return { analysis, mapeamentoOk, mapeamentoMotivo };
}

const funnelStepSchema = z.object({
  tipo: z
    .enum(['pre_sell', 'lp', 'quiz', 'vsl', 'checkout', 'upsell', 'obrigado', 'outro'])
    .nullable(),
  headline: z.string().nullable(),
  promessa: z.string().nullable(),
  mecanismo: z.string().nullable(),
  prova: z.string().nullable(),
  oferta: z.string().nullable(),
  preco: z.string().nullable(),
  bonus: z.string().nullable(),
  garantia: z.string().nullable(),
  urgencia: z.string().nullable(),
  cta: z.string().nullable(),
});

const FUNNEL_SYSTEM = `Você analisa UMA página de um funil de vendas. Responda SOMENTE um objeto JSON
com as chaves: tipo, headline, promessa, mecanismo, prova, oferta, preco, bonus, garantia, urgencia, cta.
- tipo deve ser um de: pre_sell, lp, quiz, vsl, checkout, upsell, obrigado, outro.
- Preencha cada campo com o que estiver REALMENTE no texto da página.
- Se a informação NÃO estiver no material, use null. NUNCA invente preço, bônus ou garantia.`;

function emptyFunnelStep(): FunnelStepAnalysis {
  return {
    tipo: null, headline: null, promessa: null, mecanismo: null, prova: null,
    oferta: null, preco: null, bonus: null, garantia: null, urgencia: null, cta: null,
  };
}

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

  async analyzeVsl(input: {
    transcription: string;
    segments: VslSegment[];
    parcial: boolean;
    ctaInfo?: { cta: string; aparecemSeg: number | null }[] | null;
  }): Promise<{ analysis: VslAnalysis; cost: CostEntry[]; mapeamentoOk: boolean; mapeamentoMotivo: string | null }> {
    const blocosList = VSL_BLOCKS.map((b) => `${b.key} ${b.nome}`).join('; ');
    const system =
      `Você mapeia uma VSL (video sales letter) em 11 blocos: ${blocosList}. ` +
      `Responda SOMENTE JSON com { resumo, blocos }.\n` +
      `- blocos: um objeto por bloco com { bloco (01..11), presente (bool), inicio, fim (mm:ss ou null), ` +
      `citacoes (2 a 3 trechos LITERAIS da transcrição), analise, nota (1..10 ou null) }.\n` +
      `- resumo: { bigIdea, mecanismo (nome literal exato como aparece), oferta, preco, ` +
      `stack {itens[], bonus[], valorAlegado}, garantia, emocaoDominante, vilao, diferencial }.\n` +
      `- Se algo NÃO estiver na transcrição, use null. NUNCA invente. As citações têm de EXISTIR ` +
      `no texto. ${input.parcial ? 'A transcrição é PARCIAL: avise no campo diferencial se faltar contexto.' : ''}`;

    const { content: out, usage } = await openRouterChat({
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      jsonMode: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Transcrição da VSL:\n${input.transcription.slice(0, 48000)}` },
      ],
    });

    // Salvamento TOLERANTE: nunca descarta tudo por um campo fora do formato.
    // Aproveita resumo e blocos campo a campo; citação inexistente some sozinha,
    // sem levar o bloco junto.
    const built = buildVslAnalysis(parseJsonLoose(out), input.transcription, {
      parcial: input.parcial,
      ctaInfo: input.ctaInfo ?? null,
    });
    const cost: CostEntry[] = [
      {
        provider: 'openrouter',
        unit: 'mapeamento-vsl',
        quantity: usage.total_tokens ?? 1,
        estimatedUsd: PRICE_REFERENCE.llmPerVslUsd,
        note: this.cfg.model,
      },
    ];
    return { analysis: built.analysis, cost, mapeamentoOk: built.mapeamentoOk, mapeamentoMotivo: built.mapeamentoMotivo };
  }

  async analyzeFunnelStep(input: {
    url: string;
    text: string | null;
    stepTypeGuess?: string | null;
  }): Promise<{ analysis: FunnelStepAnalysis; cost: CostEntry[] }> {
    const parts = [
      `URL: ${input.url}`,
      input.stepTypeGuess ? `Palpite de tipo (heurística): ${input.stepTypeGuess}` : '',
      input.text ? `Texto da página:\n${input.text.slice(0, 12000)}` : '(sem texto coletado)',
    ].filter(Boolean);

    const { content: out, usage } = await openRouterChat({
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      jsonMode: true,
      messages: [
        { role: 'system', content: FUNNEL_SYSTEM },
        { role: 'user', content: parts.join('\n') },
      ],
    });

    const safe = funnelStepSchema.safeParse(parseJsonLoose(out));
    const analysis: FunnelStepAnalysis = safe.success ? safe.data : emptyFunnelStep();
    const cost: CostEntry[] = [
      {
        provider: 'openrouter',
        unit: 'analise-passo-funil',
        quantity: usage.total_tokens ?? 1,
        estimatedUsd: PRICE_REFERENCE.llmPerFunnelStepUsd,
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
