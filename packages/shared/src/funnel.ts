// Detecção técnica de funil (determinística) a partir das requisições + HTML.
// Sem LLM: casa padrões conhecidos de checkout, player de vídeo e pixels.

import type { FunnelTech, PixelHit } from './types';

export interface RequestLog {
  url: string;
  resourceType?: string;
}

const CHECKOUTS: { name: string; re: RegExp }[] = [
  { name: 'Hotmart', re: /(hotmart\.com|pay\.hotmart)/i },
  { name: 'Kiwify', re: /kiwify\.(com|app|com\.br)/i },
  { name: 'Eduzz', re: /eduzz\.com|sun\.eduzz/i },
  { name: 'Ticto', re: /ticto\.(com|app)/i },
  { name: 'Monetizze', re: /monetizze\.com/i },
  { name: 'Pagar.me', re: /pagar\.me|pagarme/i },
  { name: 'Stripe', re: /(js\.stripe\.com|checkout\.stripe\.com|api\.stripe\.com)/i },
  { name: 'Vindi', re: /vindi\.com/i },
  { name: 'Asaas', re: /asaas\.com/i },
  { name: 'Iugu', re: /iugu\.com/i },
  { name: 'Braip', re: /braip\.com/i },
  { name: 'PerfectPay', re: /perfectpay\.com/i },
  { name: 'Cartpanda', re: /cartpanda\.com/i },
  { name: 'Mercado Pago', re: /mercadopago\.(com|com\.br)/i },
];

const PLAYERS: { name: string; re: RegExp }[] = [
  { name: 'VTurb/Converteai', re: /(converteai\.net|vturb|scripts\.converteai)/i },
  { name: 'Panda Video', re: /pandavideo\.com|b-cdn\.net\/.*panda/i },
  { name: 'Vimeo', re: /vimeo\.com|vimeocdn\.com/i },
  { name: 'YouTube', re: /youtube\.com|ytimg\.com|youtu\.be/i },
  { name: 'Wistia', re: /wistia\.(com|net)/i },
  { name: 'JW Player', re: /jwplayer\.com|jwpcdn/i },
];

const MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;

/** Extrai o id numérico/alfanumérico de um pixel a partir da URL/HTML. */
function firstMatch(re: RegExp, texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Detecta pixels (plataforma + id quando possível). */
function detectPixels(urls: string[], html: string): PixelHit[] {
  const texts = [html, ...urls];
  const hits: PixelHit[] = [];
  const push = (tipo: string, id: string | null) => {
    if (!hits.some((h) => h.tipo === tipo && h.id === id)) hits.push({ tipo, id });
  };

  // Meta Pixel: fbq('init','<id>') ou connect.facebook.net + id=
  if (/connect\.facebook\.net|fbevents\.js|fbq\(/i.test(html) || urls.some((u) => /facebook\.com\/tr/i.test(u))) {
    const id =
      firstMatch(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/i, [html]) ??
      firstMatch(/facebook\.com\/tr\/?\?[^"']*\bid=(\d{6,})/i, texts);
    push('meta', id);
  }
  // Google Tag Manager
  const gtm = firstMatch(/GTM-([A-Z0-9]+)/i, texts);
  if (gtm) push('gtm', `GTM-${gtm}`);
  // GA4
  const ga4 = firstMatch(/\bG-([A-Z0-9]{6,})\b/i, texts);
  if (ga4) push('ga4', `G-${ga4}`);
  // TikTok
  if (/analytics\.tiktok\.com|ttq\.load/i.test(html)) {
    push('tiktok', firstMatch(/ttq\.load\(\s*['"]([A-Z0-9]+)['"]/i, [html]));
  }
  // Hotjar / Clarity
  if (/static\.hotjar\.com|hjid/i.test(html)) push('hotjar', firstMatch(/hjid\s*[:=]\s*(\d+)/i, [html]));
  if (/clarity\.ms/i.test(html) || urls.some((u) => /clarity\.ms/i.test(u)))
    push('clarity', firstMatch(/clarity[^)]*\(\s*['"]?\w+['"]?\s*,\s*['"]([a-z0-9]+)['"]/i, [html]));
  // E-mail marketing comum
  if (/(rdstation|activecampaign|mailchimp|getresponse|klaviyo|leadlovers)/i.test(html))
    push('email', null);

  return hits;
}

/** Monta a detecção técnica do funil a partir das requisições e do HTML. */
export function detectFunnelTech(requests: RequestLog[], html: string): FunnelTech {
  const urls = requests.map((r) => r.url);
  const texts = [html, ...urls];

  const checkout = CHECKOUTS.find((c) => texts.some((t) => c.re.test(t)))?.name ?? null;
  const player = PLAYERS.find((p) => texts.some((t) => p.re.test(t)))?.name ?? null;
  const manifests = Array.from(new Set(urls.filter((u) => MANIFEST_RE.test(u))));
  const pixels = detectPixels(urls, html);

  return { checkoutPlatform: checkout, videoPlayer: player, pixels, manifests };
}

/** Normaliza destino (domínio+path) de uma URL — dedup de páginas por oferta. */
export function funnelDestKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const raw = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const u = new URL(raw);
    return u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Só o domínio (para comparar pixels entre domínios). */
export function funnelDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const raw = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
