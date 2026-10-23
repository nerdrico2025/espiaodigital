// Smoke test de ponta a ponta: investigação pequena (2 concorrentes, 1 vídeo).
//
// - Se houver chaves reais no ambiente, AVISA e explica o que seria testado
//   contra serviço real (o caminho real exige Supabase + worker; ver README).
// - Caso contrário, roda com MOCKS dos provedores e exercita a orquestração
//   completa: descoberta → ads → pontuação → criativos → mídia → transcrição
//   → análise → consolidação.

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { NormalizedAd } from '@espiao/shared';
import { makeMockDeps } from '../apps/worker/src/mocks.js';
import { runInvestigation } from '../apps/worker/src/pipeline/run.js';
import { readEnv, hasRealKeys, type WorkerEnv } from '../apps/worker/src/env.js';
import { ExaDiscovery } from '../apps/worker/src/providers/exa-discovery.js';
import { ApifyAdsProvider } from '../apps/worker/src/providers/apify-ads.js';
import { LlmAnalyzer } from '../apps/worker/src/providers/analyzer.js';
import { RealTranscriber } from '../apps/worker/src/providers/transcriber.js';
import { RealMedia, type Uploader } from '../apps/worker/src/providers/media.js';
import { filterOwnAds, mostFrequentPageId, adPageId } from '../apps/worker/src/pipeline/normalize.js';
import { normalizeClaimedJob } from '../apps/worker/src/db/supabase-db.js';
import { resolveLimits, clampInvestigationConfig, DEFAULT_LIMITS, classifyCandidate, estimateInvestigationCost, adEvidenceLevel, computeAdEvidences, summarizeCandidateAds, mediaFileName, temNarracao } from '@espiao/shared';

const line = '─'.repeat(60);

// Carrega o .env da raiz do projeto para process.env (sem dependência externa;
// o tsx não faz isso sozinho). Só preenche o que ainda não estiver definido.
function loadDotEnv(): void {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return; // sem .env: segue com o ambiente atual
  }
  for (const rawLine of content.split('\n')) {
    const l = rawLine.trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq === -1) continue;
    const key = l.slice(0, eq).trim();
    let val = l.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

async function main() {
  loadDotEnv();

  // Modo real: usa EXA, Apify, OpenRouter e Whisper de verdade (limitado).
  if (process.env.SMOKE_REAL === '1') {
    await runReal(readEnv());
    return;
  }

  const env = readEnv();
  const real = hasRealKeys(env);

  console.log(line);
  console.log('SMOKE TEST — Espião de Ofertas Escaladas');
  console.log(line);

  if (real) {
    console.log('🔑 Chaves reais detectadas no ambiente.');
    console.log(
      'Este script roda a ORQUESTRAÇÃO com mocks determinísticos (sem custo).\n' +
        'Para um teste REAL ponta a ponta, suba Supabase + worker e crie uma\n' +
        'investigação pela interface (ver README, seção "Verificação").',
    );
  } else {
    console.log('ℹ️  Sem chaves reais — rodando 100% com MOCKS (nada é cobrado).');
  }
  console.log(line);

  // Investigação pequena: 2 concorrentes pedidos, 3 candidatos "fortes".
  const now = Date.UTC(2026, 0, 15);
  const { deps, db } = makeMockDeps({
    candidates: 6,
    strong: 3,
    competitors: 2,
    now,
    provider: env.TRANSCRIPTION_PROVIDER,
    inv: {
      id: 'inv_smoke',
      query: 'app de finanças pessoais',
      country: 'BR',
      competitors: 2,
      onlyActive: true,
    },
  } as any);

  await runInvestigation(deps, 'inv_smoke');

  // ── Resultado ──────────────────────────────────────────────
  const selected = [...db.candidates.values()].filter((c: any) => c.selected);
  const creatives = [...db.creatives.values()];
  const videos = creatives.filter((c) => c.mediaType === 'video');
  const transcribed = videos.filter((c) => c.transcription);

  console.log(`\nStatus final da investigação: ${db.status}`);
  console.log(`Aviso de seleção: ${db.notice ?? '(nenhum)'}`);
  console.log(`Concorrentes selecionados: ${selected.length}`);

  for (const c of selected as any[]) {
    console.log(`\n■ ${c.name} — score ${c.score} (evidência ${c.evidence_level ?? c.level})`);
    console.log(`  Motivo: ${c.selection_reason ?? c.selectionReason}`);
    if (c.summary) console.log(`  Resumo: ${c.summary}`);
    if (c.hookPatterns?.length) console.log(`  Hooks: ${c.hookPatterns.join(' | ')}`);
  }

  console.log(`\nCriativos: ${creatives.length} (vídeos: ${videos.length})`);
  const sampleVideo = transcribed[0];
  if (sampleVideo) {
    console.log(`\nExemplo de vídeo transcrito (${sampleVideo.transcriptionProvider}):`);
    console.log(`  "${sampleVideo.transcription?.slice(0, 120)}..."`);
    console.log(`  Análise: ${JSON.stringify(sampleVideo.analysis)}`);
  }

  const cost = await db.getCostTotal();
  console.log(`\nCusto estimado (mock): US$ ${cost.toFixed(4)}`);
  console.log(`Custo final gravado: US$ ${(db.finalCost ?? 0).toFixed(4)}`);

  // ── Fila vazia (claim_job) ─────────────────────────────────
  // claim_job tem `returns public.jobs`; quando não há job, o PostgREST devolve
  // uma linha com todos os campos null (não `null` puro). normalizeClaimedJob
  // precisa tratar todos esses formatos como "sem job" e NUNCA liberar um job
  // com id nulo (o que levaria a getInvestigation(null)).
  const emptyRowAllNull = { id: null, investigation_id: null, status: null, attempts: null };
  const validJob = { id: 'job_1', investigation_id: 'inv_1', status: 'rodando' };
  const queueChecks: [string, boolean][] = [
    ['fila vazia: null puro → sem job', normalizeClaimedJob(null) === null],
    ['fila vazia: linha com campos null → sem job', normalizeClaimedJob(emptyRowAllNull) === null],
    ['fila vazia: array vazio → sem job', normalizeClaimedJob([]) === null],
    ['fila vazia: array com linha null → sem job', normalizeClaimedJob([emptyRowAllNull]) === null],
    ['fila vazia: id presente mas investigation_id null → sem job',
      normalizeClaimedJob({ id: 'x', investigation_id: null }) === null],
    ['job válido → reivindicado', normalizeClaimedJob(validJob)?.id === 'job_1'],
    ['job válido em array (SETOF) → reivindicado',
      normalizeClaimedJob([validJob])?.investigation_id === 'inv_1'],
  ];

  // ── Config por investigação (resolveLimits / clamp) ────────
  const emptyLimits = resolveLimits({});
  const partialLimits = resolveLimits({ candidates: 6, adsPerCandidate: 30 });
  const clamped = clampInvestigationConfig({
    candidates: 999, // acima do máx (20)
    adsPerCandidate: 1, // abaixo do mín (10)
    maxVideos: '', // vazio → omitido
    maxTranscriptionMinutes: 15,
  });
  const configChecks: [string, boolean][] = [
    ['config vazia → usa padrões fixos (maxCandidates)',
      emptyLimits.maxCandidates === DEFAULT_LIMITS.maxCandidates],
    ['config vazia → usa padrões fixos (adsPerCandidate)',
      emptyLimits.adsPerCandidate === DEFAULT_LIMITS.adsPerCandidate],
    ['override candidates=6 aplicado', partialLimits.maxCandidates === 6],
    ['min ≤ max mantido quando candidates < padrão', partialLimits.minCandidates <= 6],
    ['override adsPerCandidate=30 aplicado', partialLimits.adsPerCandidate === 30],
    ['campo não informado cai no padrão (maxVideos)',
      partialLimits.maxVideosPerInvestigation === DEFAULT_LIMITS.maxVideosPerInvestigation],
    ['clamp prende candidates ao máx (20)', clamped.candidates === 20],
    ['clamp prende adsPerCandidate ao mín (10)', clamped.adsPerCandidate === 10],
    ['clamp omite campo vazio (maxVideos)', clamped.maxVideos === undefined],
    ['clamp mantém campo válido (maxTranscriptionMinutes)', clamped.maxTranscriptionMinutes === 15],
  ];

  // ── Classificação de candidatos (Candidatos avaliados) ─────
  const base = {
    distinctPlatforms: 1,
    distinctCountries: 1,
    hasVideo: false,
    hasActionCta: false,
    adsPerCandidateLimit: 30,
  };
  const vSel = classifyCandidate({ ...base, adsCollected: 40, daysLive: 90, maxVariations: 6, noOwnAds: false }, true);
  const vQuase = classifyCandidate({ ...base, adsCollected: 20, daysLive: 20, maxVariations: 2, noOwnAds: false }, false);
  const vNovo = classifyCandidate({ ...base, adsCollected: 20, daysLive: 5, maxVariations: 1, noOwnAds: false }, false);
  const vSemAnuncios = classifyCandidate({ ...base, adsCollected: 0, daysLive: null, maxVariations: 0, noOwnAds: true }, false);
  const vLongo = classifyCandidate({ ...base, adsCollected: 20, daysLive: 70, maxVariations: 1, noOwnAds: false }, false);
  const classifyChecks: [string, boolean][] = [
    ['selecionado → status selecionado', vSel.status === 'selecionado'],
    ['20 dias e 2 variações → Quase lá', vQuase.status === 'quase' && vQuase.label === 'Quase lá'],
    ['5 dias → Não selecionado com motivo "só 5 dias"', vNovo.status === 'nao' && vNovo.reason.includes('5 dias')],
    ['apenas 1 variação citada no motivo', vNovo.reason.includes('1 variação')],
    ['sem anúncios próprios → motivo correto', vSemAnuncios.reason === 'nenhum anúncio próprio encontrado'],
    ['amostra pequena sinalizada (20 ≤ 30)', vQuase.smallSample === true],
    ['amostra pequena não dispara sem anúncios', vSemAnuncios.smallSample === false],
    ['70 dias e 1 variação → Quase lá (muito tempo no ar)',
      vLongo.status === 'quase' && vLongo.reason.includes('muito tempo no ar')],
  ];

  // ── Evidência POR ANÚNCIO ──────────────────────────────────
  const dayMs = 86400000;
  const tNow = Date.UTC(2026, 0, 15);
  const mkAd = (o: Partial<NormalizedAd>): NormalizedAd => ({
    adArchiveId: o.adArchiveId ?? Math.random().toString(36).slice(2),
    pageName: null, bodyText: o.bodyText ?? null, title: null, ctaText: o.ctaText ?? null,
    ctaType: null, linkUrl: o.linkUrl ?? null,
    startDate: o.startDate ?? null, endDate: o.endDate ?? null,
    isActive: o.isActive ?? true, platforms: o.platforms ?? [], countries: o.countries ?? [],
    variations: o.variations ?? 0, images: o.images ?? [], videos: o.videos ?? [],
  });
  const adsSameDest = (n: number, days: number, host: string): NormalizedAd[] =>
    Array.from({ length: n }, (_, i) =>
      mkAd({ adArchiveId: `${host}-${i}`, linkUrl: `https://${host}/oferta`, startDate: tNow - days * dayMs, isActive: true }),
    );

  const sumMed = summarizeCandidateAds(adsSameDest(1, 132, 'medio'), tNow); // 132 dias, 1 versão
  const vMedNew = classifyCandidate(
    {
      adsCollected: 1, noOwnAds: false, adsPerCandidateLimit: 30,
      daysLive: 132, distinctPlatforms: 0, maxVariations: 1, distinctCountries: 0, hasVideo: false, hasActionCta: false,
      hasHigh: false, hasMedium: sumMed.hasMedium, bestAdLevel: sumMed.best?.ev.nivel ?? null,
      bestAdDays: sumMed.best?.ev.diasNoAr ?? null, bestAdVersions: sumMed.best?.ev.versoes ?? null,
      bestAdReason: sumMed.best?.ev.motivo, sampleAtLimit: false,
    },
    false,
  );
  const sumAlto = summarizeCandidateAds(adsSameDest(4, 45, 'alto'), tNow); // 45 dias, 4 versões
  const sumBaixo = summarizeCandidateAds(adsSameDest(5, 10, 'baixo'), tNow); // 10 dias, 5 versões
  const clusterDest = computeAdEvidences(adsSameDest(2, 40, 'dest'), tNow);
  const adLevelChecks: [string, boolean][] = [
    ['132 dias + 1 versão = médio', adEvidenceLevel(132, 1) === 'medio'],
    ['45 dias + 4 versões = alto', adEvidenceLevel(45, 4) === 'alto'],
    ['10 dias + 5 versões = baixo', adEvidenceLevel(10, 5) === 'baixo'],
    ['cluster por destino conta 2 versões', clusterDest[0]?.ev.versoes === 2],
    ['132 dias + 1 versão → melhor médio → Quase lá', vMedNew.status === 'quase' && vMedNew.label === 'Quase lá'],
    ['45 dias + 4 versões → anunciante tem evidência alta', sumAlto.hasHigh === true && sumAlto.best?.ev.nivel === 'alto'],
    ['10 dias + 5 versões → melhor anúncio baixo', sumBaixo.best?.ev.nivel === 'baixo' && !sumBaixo.hasHigh],
  ];

  // ── Nome de arquivo de mídia + narração ────────────────────
  const fnameVideo = mediaFileName({
    candidate: 'ArcAds', nivel: 'medio', dias: 15, creativeId: 'a1b2c3d4-ffff', storagePath: 'inv/clip.mp4', mediaType: 'video',
  });
  const fnameImgNoExt = mediaFileName({
    candidate: 'Empresa Legal!', nivel: 'alto', dias: 90, creativeId: 'deadbeef1234', storagePath: null, mediaType: 'image',
  });
  const fnameNoData = mediaFileName({
    candidate: null, nivel: null, dias: null, creativeId: '112233aa', storagePath: 'x/y.webp', mediaType: 'image',
  });
  const mediaChecks: [string, boolean][] = [
    ['nome de arquivo vídeo = arcads_medio_15d_a1b2c3.mp4', fnameVideo === 'arcads_medio_15d_a1b2c3.mp4'],
    ['sem acento/espaço e ext por tipo (imagem→jpg)', fnameImgNoExt === 'empresa_legal_alto_90d_deadbe.jpg'],
    ['dados ausentes viram "na" e ext do path (webp)', fnameNoData === 'item_na_nad_112233.webp'],
    ['narração: vazio → false', temNarracao('') === false],
    ['narração: 2 palavras → false', temNarracao('só música') === false],
    ['narração: 3+ palavras → true', temNarracao('clique no link agora') === true],
  ];

  // ── Estimativa de custo por modo ───────────────────────────
  const limitsCost = resolveLimits({});
  const custoConc = estimateInvestigationCost(5, limitsCost, 'concorrentes');
  const custoAnun = estimateInvestigationCost(1, limitsCost, 'anunciante');
  const costModeChecks: [string, boolean][] = [
    ['modo concorrentes inclui descoberta EXA', custoConc.entries.some((e) => e.provider === 'exa')],
    ['modo anunciante NÃO inclui EXA', !custoAnun.entries.some((e) => e.provider === 'exa')],
    ['modo anunciante NÃO inclui extração de candidatos',
      !custoAnun.entries.some((e) => e.unit === 'extracao-candidatos')],
    ['modo anunciante custa menos que concorrentes', custoAnun.total < custoConc.total],
    ['modo anunciante tem linha Apify', custoAnun.entries.some((e) => e.provider === 'apify')],
  ];

  // ── Verificações (assert) ──────────────────────────────────
  const checks: [string, boolean][] = [
    ...queueChecks,
    ...configChecks,
    ...classifyChecks,
    ...adLevelChecks,
    ...mediaChecks,
    ...costModeChecks,
    ['investigação concluída', db.status === 'concluida'],
    ['selecionou exatamente 2 concorrentes', selected.length === 2],
    ['pelo menos 1 vídeo transcrito', transcribed.length >= 1],
    ['todos os criativos de mídia analisados', creatives.every((c) => c.analysis || c.status === 'midia_indisponivel')],
    ['custo final > 0', (db.finalCost ?? 0) > 0],
    ['nenhum concorrente fraco incluído (todos passam evidência forte)',
      (selected as any[]).every((c) => c.evidence?.daysLive >= 30 && c.evidence?.maxVariations >= 3)],
  ];

  console.log(`\n${line}\nVerificações:`);
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allOk = false;
  }
  console.log(line);

  if (!real) {
    console.log('\n⚠️  NÃO testado com serviço real nesta execução (sem chaves):');
    console.log('   - EXA (descoberta)        - Apify / Meta Ad Library (ads)');
    console.log('   - OpenRouter (análise)    - Whisper/OpenRouter (transcrição)');
    console.log('   - Download real de mídia + Supabase Storage + Postgres');
  }

  if (!allOk) {
    console.error('\n❌ SMOKE TEST FALHOU.');
    process.exit(1);
  }
  console.log('\n✅ SMOKE TEST PASSOU (orquestração completa com mocks).');
}

// ─────────────────────────────────────────────────────────────
// MODO REAL — SMOKE_REAL=1
// Chama EXA, Apify, OpenRouter e Whisper de verdade, limitado a
// 1 candidato, 10 anúncios e 1 vídeo. Não usa o runInvestigation
// (que exige Supabase): aciona os provedores reais diretamente,
// sem alterar o pipeline.
// ─────────────────────────────────────────────────────────────

// Campos escalares/arrays do NormalizedAd que o normalizador preenche.
const NORM_FIELDS: (keyof NormalizedAd)[] = [
  'adArchiveId', 'pageName', 'bodyText', 'title', 'ctaText', 'ctaType',
  'linkUrl', 'startDate', 'endDate', 'platforms', 'countries',
  'variations', 'images', 'videos',
];

function isMissing(ad: NormalizedAd, f: keyof NormalizedAd): boolean {
  const v = ad[f] as unknown;
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

async function runReal(env: WorkerEnv) {
  console.log(line);
  console.log('SMOKE TEST — MODO REAL (SMOKE_REAL=1)');
  console.log(line);

  // Valida só as chaves que o modo real usa.
  const missing: string[] = [];
  if (!env.EXA_API_KEY) missing.push('EXA_API_KEY');
  if (!env.APIFY_TOKEN) missing.push('APIFY_TOKEN');
  if (!env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (env.TRANSCRIPTION_PROVIDER === 'openai' && !env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (env.TRANSCRIPTION_PROVIDER === 'openrouter' && !env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (missing.length) {
    console.error(`❌ Faltam chaves para o modo real: ${missing.join(', ')}`);
    process.exit(1);
  }

  const outDir = fileURLToPath(new URL('./out', import.meta.url));
  const mediaDir = path.join(outDir, 'media');
  await mkdir(mediaDir, { recursive: true });

  const query = process.env.SMOKE_QUERY ?? 'app de finanças pessoais';
  const country = (process.env.SMOKE_COUNTRY ?? 'BR').toUpperCase();
  const input = { query, country, competitors: 1, onlyActive: true };
  console.log(`Alvo: "${query}" · país ${country} · limites: 1 candidato / 10 anúncios / 1 vídeo`);

  // 1) EXA + OpenRouter → candidatos (pega 1).
  console.log('\n[1/5] Descoberta (EXA + OpenRouter)…');
  const discovery = new ExaDiscovery({
    exaKey: env.EXA_API_KEY!,
    openRouterKey: env.OPENROUTER_API_KEY!,
    discoveryModel: env.LLM_MODEL_DISCOVERY,
  });
  const { candidates } = await discovery.discover(input, { min: 1, max: 3 });
  const candidate = candidates[0];
  if (!candidate) {
    console.error('❌ EXA/LLM não retornou nenhum candidato.');
    process.exit(1);
  }
  console.log(`   → candidato: ${candidate.name}${candidate.domain ? ` (${candidate.domain})` : ''}`);

  // 2) Apify (Meta Ad Library) → até 10 anúncios.
  console.log('\n[2/5] Apify / Meta Ad Library (resultsLimit=10)…');
  const adsProvider = new ApifyAdsProvider({ token: env.APIFY_TOKEN!, actor: env.APIFY_META_ADS_ACTOR });
  const { ads: fetched } = await adsProvider.fetchAds(candidate, { country, onlyActive: true, limit: 10 });
  console.log(`   → ${fetched.length} anúncios normalizados.`);

  // Salva o JSON BRUTO devolvido pelo Apify (preservado em ad.raw) — tudo o que veio.
  const rawItems = fetched.map((a) => a.raw);
  const samplePath = path.join(outDir, 'apify-sample.json');
  await writeFile(samplePath, JSON.stringify(rawItems, null, 2), 'utf8');
  console.log(`   → JSON bruto salvo em scripts/out/apify-sample.json (${rawItems.length} itens).`);

  // Filtro de "anúncios próprios" (mesmo do pipeline): descarta menções de terceiros.
  const { kept, discarded, matches } = filterOwnAds(fetched, candidate);
  console.log(
    `   → 1ª chamada (busca por marca): ${fetched.length} anúncios · filtro de dono: ` +
      `${kept.length} mantidos, ${discarded.length} descartados (terceiros).`,
  );
  // Critério pelo qual cada anúncio foi mantido (nome, pageId ou domínio).
  if (matches.length) {
    const porCriterio = { nome: 0, pageId: 0, dominio: 0 } as Record<string, number>;
    for (const m of matches) porCriterio[m.basis]++;
    console.log(
      `      mantidos por critério: nome=${porCriterio.nome}, pageId=${porCriterio.pageId}, domínio=${porCriterio.dominio}`,
    );
    for (const m of matches) {
      console.log(`        · [${m.basis}] ${m.ad.pageName ?? '(sem pageName)'} — pageId ${adPageId(m.ad) ?? '∅'}`);
    }
  }
  if (discarded.length) {
    const nomes = [...new Set(discarded.map((a) => a.pageName ?? '(sem pageName)'))].slice(0, 5);
    console.log(`      descartados (páginas): ${nomes.join(', ')}`);
  }

  // 2ª chamada: busca pela PÁGINA dona (voto de pageId por prioridade de critério).
  let ads = kept;
  let pageId: string | null = null;
  if (kept.length === 0) {
    console.log(
      `   ⚠️ "${candidate.name}" marcado como SEM ANÚNCIOS PRÓPRIOS — não usaria anúncios de terceiros.`,
    );
  } else {
    const vote = mostFrequentPageId(matches);
    pageId = vote.pageId;
    if (vote.split) {
      console.log(
        `   → votos de pageId DIVIDIDOS (nenhum >50%, pool: ${vote.from}); 2ª chamada pulada. ` +
          `Candidatos: ${vote.candidates.join(', ')}. Mantendo ${kept.length} da busca por marca.`,
      );
    } else {
      console.log(
        `   → pageId da página dona: ${pageId ?? '(não encontrado)'}` +
          (vote.from ? ` (voto por ${vote.from})` : ''),
      );
    }
    if (pageId) {
      try {
        const { ads: pageAds } = await adsProvider.fetchAdsByPage(pageId, {
          country,
          onlyActive: true,
          limit: 10,
        });
        console.log(
          `   → 2ª chamada (search_type=page, view_all_page_id=${pageId}): ${pageAds.length} anúncios.`,
        );
        if (pageAds.length > 0) {
          ads = pageAds;
          console.log(`   → base de pontuação substituída pela 2ª chamada (${pageAds.length}).`);
        } else {
          console.log(`   → 2ª chamada sem anúncios; mantendo ${kept.length} da busca por marca.`);
        }
      } catch (e) {
        console.log(
          `   → 2ª chamada falhou (${String(e).slice(0, 120)}); mantendo ${kept.length} da busca por marca.`,
        );
      }
    }
  }

  // 3) Campos que o normalizador deixou como "não coletado" (nos anúncios próprios).
  console.log('\n[3/5] Campos deixados como "não coletado" pelo normalizador:');
  if (ads.length === 0) {
    console.log('   (sem anúncios — nada a avaliar; verifique o alvo/país na Ad Library)');
  } else {
    for (const f of NORM_FIELDS) {
      const miss = ads.filter((a) => isMissing(a, f)).length;
      if (miss > 0) {
        const allMissing = miss === ads.length;
        console.log(`   ${allMissing ? '✖' : '·'} ${String(f)}: ${miss}/${ads.length} anúncios sem valor${allMissing ? ' (TODOS)' : ''}`);
      }
    }
    const full = NORM_FIELDS.filter((f) => ads.every((a) => isMissing(a, f)));
    console.log(`   Resumo — nunca coletados nesta amostra: ${full.length ? full.join(', ') : '(nenhum)'}`);
    console.log('   (obs.: endDate costuma ser nulo em anúncios ativos — esperado.)');
  }

  // 4) Baixar 1 vídeo (yt-dlp/ffmpeg) + transcrever (Whisper/OpenRouter).
  const videoAd = ads.find((a) => a.videos.length > 0);
  if (!videoAd) {
    console.log('\n[4/5] Nenhum vídeo entre os anúncios coletados — transcrição/análise puladas.');
    console.log('\n✅ MODO REAL concluído (sem vídeo para transcrever).');
    return;
  }

  console.log('\n[4/5] Download do vídeo + extração de áudio + transcrição…');
  const localUploader: Uploader = {
    async upload(storagePath, data) {
      await writeFile(path.join(mediaDir, storagePath.replace(/\//g, '_')), data);
    },
  };
  const media = new RealMedia(localUploader);
  const dl = await media.download({
    investigationId: 'smoke',
    creativeId: 'video-1',
    mediaType: 'video',
    url: videoAd.videos[0]!.url,
    previewUrl: videoAd.videos[0]!.previewUrl ?? null,
  });
  if (!dl.ok || !dl.localAudioPath) {
    console.error(`❌ Download/áudio falhou: ${dl.error ?? 'sem áudio'}`);
    process.exit(1);
  }
  console.log(`   → mídia salva em scripts/out/media · duração ~${Math.round(dl.durationSeconds ?? 0)}s`);

  const transcriber = new RealTranscriber({
    provider: env.TRANSCRIPTION_PROVIDER,
    transcriptionModel: env.TRANSCRIPTION_MODEL,
    openRouterKey: env.OPENROUTER_API_KEY,
    openaiKey: env.OPENAI_API_KEY,
  });
  const tr = await transcriber.transcribe({
    audioPath: dl.localAudioPath,
    durationSeconds: dl.durationSeconds ?? null,
    context: { brand: candidate.name, domain: candidate.domain },
  });
  console.log(`   → transcrição (${tr.provider}): "${tr.text.slice(0, 160)}${tr.text.length > 160 ? '…' : ''}"`);

  // 5) Análise (OpenRouter).
  console.log('\n[5/5] Análise do criativo (OpenRouter)…');
  const analyzer = new LlmAnalyzer({ apiKey: env.OPENROUTER_API_KEY!, model: env.LLM_MODEL_ANALYSIS });
  const { analysis } = await analyzer.analyze({
    mediaType: 'video',
    bodyText: videoAd.bodyText,
    title: videoAd.title,
    ctaText: videoAd.ctaText,
    transcription: tr.text,
    linkUrl: videoAd.linkUrl,
    context: { brand: candidate.name, domain: candidate.domain },
  });
  console.log(`   → ${JSON.stringify(analysis)}`);

  console.log(`\n${line}\n✅ MODO REAL concluído: EXA + Apify + OpenRouter + ${tr.provider} exercitados.`);
  console.log('Arquivos: scripts/out/apify-sample.json e scripts/out/media/');
}

main().catch((e) => {
  console.error('❌ Erro no smoke test:', e);
  process.exit(1);
});
