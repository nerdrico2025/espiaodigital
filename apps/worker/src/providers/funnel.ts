// Captura de funil com Playwright (Chromium). Acessa como visitante comum de
// celular no Brasil (emulação móvel, pt-BR, America/Sao_Paulo, referer do
// Facebook). SEM stealth, SEM esconder webdriver, SEM proxy, SEM anti-detect.
// PARA NO CHECKOUT: nunca preenche dados, compra ou submete formulário.

import { chromium, devices, type Browser, type Request } from 'playwright';
import type { RequestLog } from '@espiao/shared';
import type { CapturedStep, FunnelCapturer } from '../interfaces.js';

// Estas funções são serializadas e executadas DENTRO do browser (têm DOM).
// O worker não compila com a lib DOM, então declaramos os globais como any.
declare const document: any;

const WAIT_MIN = 3000;
const WAIT_MAX = 5000;
const NAV_TIMEOUT = 45_000;

// Domínios que indicam checkout — ao chegar aqui, PARA (não segue adiante).
const CHECKOUT_HINT =
  /(hotmart|kiwify|eduzz|ticto|monetizze|pagar\.me|pagarme|stripe|vindi|asaas|iugu|braip|perfectpay|cartpanda|mercadopago|checkout|pay\.)/i;

// Texto de CTA típico (para achar o botão principal).
const CTA_TEXT = /(comprar|quero|garantir|assinar|come[çc]ar|inscrever|acessar|continuar|sim,|eu quero|adquirir|get|buy|start|join)/i;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rola a página até o fim (e volta ao topo) para disparar conteúdo lazy-load e
 * deixar o DOM assentar ANTES de extrair texto/print. Sem isso, páginas que
 * montam o conteúdo via JS (ou têm seções abaixo da dobra) eram capturadas num
 * estado inicial/parcial — origem dos campos vazios/incoerentes no passo 1.
 * Executado DENTRO do browser.
 */
async function autoScrollScript(): Promise<void> {
  const w: any = window as any;
  const step = Math.max(400, Math.floor(w.innerHeight * 0.9));
  const maxLoops = 40;
  let last = -1;
  for (let i = 0; i < maxLoops; i++) {
    w.scrollTo(0, document.body.scrollHeight);
    await new Promise((r: any) => setTimeout(r, 250));
    const h = document.body.scrollHeight;
    if (h === last) break; // parou de crescer: tudo carregado
    last = h;
    w.scrollTo(0, (i + 1) * step);
  }
  w.scrollTo(0, 0);
  await new Promise((r: any) => setTimeout(r, 300));
}

declare const window: any;

/** Texto limpo (markdown simples) a partir do DOM visível. */
function cleanTextScript(): string {
  // Executado no browser.
  const drop = ['script', 'style', 'noscript', 'svg', 'iframe'];
  drop.forEach((sel: string) => document.querySelectorAll(sel).forEach((n: any) => n.remove()));
  const lines: string[] = [];
  document.querySelectorAll('h1,h2,h3,li,p,button,a,span').forEach((el: any) => {
    const t = el.innerText?.trim();
    if (!t) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1') lines.push(`# ${t}`);
    else if (tag === 'h2') lines.push(`## ${t}`);
    else if (tag === 'h3') lines.push(`### ${t}`);
    else if (tag === 'li') lines.push(`- ${t}`);
    else lines.push(t);
  });
  return Array.from(new Set(lines)).join('\n').slice(0, 20000);
}

export class PlaywrightFunnel implements FunnelCapturer {
  async capture(
    entryUrl: string,
    opts: { maxSteps: number; country: string },
  ): Promise<{ steps: CapturedStep[] }> {
    const steps: CapturedStep[] = [];
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      const device = devices['iPhone 13'];
      const context = await browser.newContext({
        ...device,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        extraHTTPHeaders: { referer: 'https://www.facebook.com/' },
      });

      let currentUrl = entryUrl;
      const visited = new Set<string>();

      for (let order = 0; order < opts.maxSteps; order++) {
        if (visited.has(currentUrl)) break;
        visited.add(currentUrl);

        const page = await context.newPage();
        const requests: RequestLog[] = [];
        page.on('request', (r: Request) => {
          const u = r.url();
          if (u.startsWith('http')) requests.push({ url: u, resourceType: r.resourceType() });
        });

        const t0 = Date.now();
        let blocked = false;
        let html: string | null = null;
        let text: string | null = null;
        let screenshot: Buffer | null = null;
        let finalUrl = currentUrl;

        try {
          await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await sleep(WAIT_MIN + Math.floor(Math.random() * (WAIT_MAX - WAIT_MIN)));
          // Rola a página toda (lazy-load) e deixa o DOM assentar antes de extrair.
          await page.evaluate(autoScrollScript).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          finalUrl = page.url();
          screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
          html = await page.content().catch(() => null);
          text = await page.evaluate(cleanTextScript).catch(() => null);
          // Página branca / conteúdo mínimo / bloqueio evidente.
          if (!text || text.replace(/\s+/g, '').length < 40) blocked = true;
        } catch {
          blocked = true;
        }

        const loadMs = Date.now() - t0;
        const stepTypeGuess = CHECKOUT_HINT.test(finalUrl) ? 'checkout' : null;
        steps.push({
          order,
          url: finalUrl,
          stepTypeGuess,
          screenshot,
          html,
          text,
          requests,
          blocked,
          loadMs,
        });

        // Parar no checkout: não segue, não preenche nada.
        if (stepTypeGuess === 'checkout' || blocked) {
          await page.close();
          break;
        }

        // Descobrir o próximo passo pelo CTA principal (sem submeter formulário).
        const nextUrl = await findNextUrl(page, finalUrl).catch(() => null);
        await page.close();
        if (!nextUrl || nextUrl === currentUrl) break;
        currentUrl = nextUrl;
      }

      await context.close();
      return { steps };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

/** Acha a URL do CTA principal (href). Clica só quando não há href navegável. */
async function findNextUrl(page: import('playwright').Page, baseUrl: string): Promise<string | null> {
  // 1) Links/botões com href e texto de CTA.
  const hrefs: string[] = await page
    .$$eval('a[href]', (els: any[]) =>
      els.map((e: any) => ({ href: e.href as string, text: (e.innerText as string) || '' })),
    )
    .then((list) => {
      const cta = list.filter((x) => /./.test(x.href));
      // Prioriza textos de CTA; senão, qualquer link que saia da página atual.
      const strong = cta.filter((x) => CTA_TEXT.test(x.text));
      return (strong.length ? strong : cta).map((x) => x.href);
    })
    .catch(() => [] as string[]);

  const base = safeHost(baseUrl);
  for (const href of hrefs) {
    if (!href.startsWith('http')) continue;
    const h = safeHost(href);
    // Segue se é checkout OU muda de página/domínio (novo passo do funil).
    if (CHECKOUT_HINT.test(href)) return href;
    if (h && h !== base) return href;
    if (href !== baseUrl && h === base) return href; // próximo passo no mesmo domínio
  }
  return null;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
