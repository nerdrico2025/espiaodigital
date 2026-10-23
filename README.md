# 🕵️ Espião de Ofertas Escaladas

MVP de uso pessoal (um único usuário) que:

1. Descobre concorrentes de um app/nicho (EXA + LLM via OpenRouter);
2. Busca anúncios na **Meta Ad Library** via Apify;
3. Pontua e filtra quem tem **anúncios escalados** (regras de evidência);
4. Baixa os criativos campeões (imagem/vídeo), **transcreve** os vídeos e **analisa** com IA;
5. Consolida tudo com a **evidência por trás** (dias no ar, variações, plataformas, países).

> ⚠️ **Uso responsável.** O app usa apenas dados **públicos** da Meta Ad Library.
> Nada de login falso, bypass de cloaker, proxies ou scraping de áreas privadas.
> As mídias baixadas são para **análise interna**, não para republicação.
>
> 🧭 **Funil (fase 05).** A captura de páginas acessa só **conteúdo público**, como um
> visitante comum de celular. **Para no checkout**: nunca preenche dados reais, não
> compra, não cria conta, não submete formulário, não persiste lead. Os **prints, HTML e
> análises do funil são para análise interna**, não para republicação.
>
> 🎬 **VSL (fase 06).** Baixa só vídeo **público** (sem DRM bypass, sem login, sem compra,
> sem proxy). Áudio/vídeo, transcrição e mapeamento são para **análise interna**, não para
> republicação. A modelagem **copia estrutura e ângulo, nunca a copy literal**.

---

## Arquitetura

```
apps/web      Next.js (App Router) + TypeScript + Tailwind — tema claro, PT-BR
apps/worker   Worker Node/TS (tsx) — consome a fila de jobs (tabela `jobs`)
packages/shared  Tipos, regras de pontuação (pesos), estimativa de custo
supabase/migrations  SQL do banco (schema + RLS + fila)
docker-compose.yml   web + worker (HTTPS e roteamento pelo proxy do Easypanel)
scripts/smoke-test.ts  Teste de ponta a ponta com mocks
```

- **Fila sem Redis:** tabela `jobs` + função `claim_job` com `FOR UPDATE SKIP LOCKED` e polling.
- **Segredos só por env** (`.env`). Nunca há chave no código ou em log.
- O worker usa a **service role**; a interface lê com a sessão do usuário (RLS).

### Pipeline (etapas visíveis na tela)
`descobrir → buscar_ads → pontuar → escolher_criativos → baixar_midia → transcrever → analisar → consolidar`

Cada etapa grava `job_events`. Se uma falhar, dá para **refazer a partir dela** sem repetir as concluídas.

---

## 1. Criar o projeto no Supabase e aplicar as migrations

1. Crie um projeto em <https://supabase.com> (nuvem).
2. Em **Project Settings → API**, copie:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (secreta!)
3. Aplique as migrations **na ordem** (`0001`, `0002`, `0003`). Duas opções:

   **a) SQL Editor (mais simples):** cole o conteúdo de cada arquivo de
   `supabase/migrations/` e rode um a um.

   **b) Supabase CLI:**
   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

As migrations criam as tabelas (`investigations`, `candidates`, `ads`, `creatives`,
`jobs`, `job_events`, `cost_log`), ativam **RLS**, criam o bucket privado `creatives`
e as funções `claim_job` / `requeue_step`.

## 2. Criar o único usuário e **desativar o cadastro**

1. Em **Authentication → Providers → Email**, mantenha **Email** ativo e
   **desative "Enable Sign Ups"** (Allow new users to sign up = OFF).
   Isso bloqueia qualquer cadastro novo — só existe o seu usuário.
2. Em **Authentication → Users → Add user**, crie o seu usuário com e-mail e senha.
3. Coloque esse e-mail em `ALLOWED_USER_EMAIL` no `.env` (referência/documentação).

> Como o sign-up fica desligado no Supabase, a tela de login **nunca** cadastra
> ninguém novo; tentativas de login com outro e-mail simplesmente falham.

## 3. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha. Chaves necessárias para o fluxo real:

> ⚠️ **Regra:** o `.env.example` é só um **modelo**; **nunca** coloque chaves reais
> nele. As chaves reais vão apenas no `.env` (ignorado pelo git).

| Variável | Para quê |
|---|---|
| `APIFY_TOKEN` | Rodar o actor da Meta Ad Library |
| `EXA_API_KEY` | Descoberta de concorrentes |
| `OPENROUTER_API_KEY` | Extração de candidatos e análise de criativos |
| `OPENAI_API_KEY` | Fallback de transcrição (Whisper) |
| `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` | Front + sessão |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker e enfileiramento (ignora RLS) |
| `APIFY_META_ADS_ACTOR` | Padrão `apify/facebook-ads-scraper` |
| `LLM_MODEL_ANALYSIS` / `LLM_MODEL_DISCOVERY` | Modelos OpenRouter |
| `TRANSCRIPTION_PROVIDER` | `openrouter` ou `openai` |
| `TRANSCRIPTION_MODEL` | `whisper-1` (openai) ou modelo multimodal (openrouter) |

> No Easypanel, cole essas mesmas variáveis em **Environment** do serviço Compose
> (o domínio/HTTPS é configurado no painel, não por variável).

## 4. Rodar localmente (dev)

```bash
npm install
npm run dev:web      # http://localhost:3000
npm run dev:worker   # consome a fila
```

## 5. Deploy via Easypanel

O Easypanel já tem proxy próprio com **HTTPS automático** (portas 80/443), então
**não há Caddy** no projeto. O `docker-compose.yml` sobe apenas `web` e `worker`.

1. No Easypanel, crie um projeto e adicione um serviço do tipo **Compose**,
   apontando para este repositório (ele usa a raiz como contexto de build).
2. Em **Environment** do serviço Compose, cole as variáveis (seção 3). Elas são
   lidas via `${VAR}` tanto no build (NEXT_PUBLIC_*) quanto em runtime.
3. Em **Domains**, aponte seu domínio para o serviço **`web`**, porta interna
   **`3000`**. O proxy do Easypanel emite e renova o certificado HTTPS.
4. Faça o deploy. O `worker` roda em background consumindo a fila; ele não expõe
   portas (fala só com o Supabase).
5. Acesse pelo domínio e faça login.

> As `NEXT_PUBLIC_*` entram no bundle no momento do **build** — se mudar o
> projeto Supabase, refaça o build (não basta reiniciar).

## 6. Atualizar a versão

Faça o **Redeploy** do serviço Compose no Easypanel (ele reconstrói as imagens).

## 7. Ler logs

No Easypanel, abra os logs de cada serviço (`web` e `worker`). Localmente:

```bash
docker compose logs -f web       # interface
docker compose logs -f worker    # pipeline (logs em JSON por linha)
```
Na interface, a barra de etapas e os `job_events` mostram o progresso e erros legíveis por etapa.

---

## Regras de pontuação (editáveis)

Em `packages/shared/src/config.ts` (`SCORING_WEIGHTS` e `SCORING_THRESHOLDS`):

- > 60 dias no ar: **5** · 30–60 dias: **3**
- 4+ plataformas: **4**
- 3+ variações: **3** (considera "escalado" com 5+)
- 2+ países: **4**
- vídeo: **2** · CTA de ação: **2**

Seleciona os **N** com maior score que **também** tenham evidência forte
(**30+ dias E 3+ variações**). Se menos de N passarem, mostra só os que passaram
e avisa quantos faltaram — **nunca completa a lista com candidatos fracos**.

### Limites de custo (editáveis em `DEFAULT_LIMITS`)
- candidatos: 12–20 · ads por candidato: 60
- criativos campeões: 3–5 · vídeos por investigação: 15 · minutos transcritos: 90

---

## Verificação / smoke test

```bash
npm run smoke
```

- **Sem chaves reais:** roda a orquestração completa com **mocks** (sem custo) e
  lista explicitamente o que **não** foi testado com serviço real.
- **Com chaves reais no `.env`:** avisa e explica que o teste real ponta a ponta
  exige Supabase + worker (crie uma investigação pela interface).

### Modo real do smoke test (`SMOKE_REAL=1`)

```bash
SMOKE_REAL=1 npm run smoke
# opcional: SMOKE_QUERY="seu nicho" SMOKE_COUNTRY=BR
```

Usa **EXA, Apify, OpenRouter e Whisper de verdade**, limitado a **1 candidato,
10 anúncios e 1 vídeo** (sem Supabase). Ao final:
- salva o **JSON bruto do Apify** em `scripts/out/apify-sample.json`;
- imprime **quais campos o normalizador deixou como "não coletado"** na amostra;
- baixa 1 vídeo (`scripts/out/media/`), transcreve e analisa.

Precisa de `EXA_API_KEY`, `APIFY_TOKEN`, `OPENROUTER_API_KEY` e, para Whisper,
`OPENAI_API_KEY`. Consome créditos reais (poucos). Os artefatos em `scripts/out/`
são ignorados pelo git.

---

## Pontos de extensão (não implementados)

Interfaces vazias em `apps/worker/src/extensions/`:
- `site-traffic.ts` — tráfego do site;
- `instagram.ts` — criativos do Instagram;
- `multi-player.ts` — síntese comparativa multi-concorrente.

---

## Nota sobre o actor do Apify

O schema de **entrada** foi confirmado via Apify (`apify/facebook-ads-scraper`,
id `JJghSZmShuco4j9gJ`): `startUrls` (obrigatório), `resultsLimit`, `activeStatus`,
`sorting`, `onlyAdsNewerThan/OlderThan`, `isDetailsPerAd`, `includeAboutPage`,
`enrichWithEcommerceData`. **O país vai na URL da Ad Library** (`country=BR`), não há
campo próprio. A **saída** é baseada em `snapshot`; o normalizador
(`apps/worker/src/pipeline/normalize.ts`) é tolerante a variações de nome de campo —
revalide contra um run real na primeira execução.
