# Prompt único para o Claude Code — MVP "Espião de Ofertas Escaladas"

Cole tudo abaixo (a partir da linha "---") no Claude Code, numa pasta vazia do projeto.

---

Construa, do zero e de ponta a ponta, o MVP de um app de uso pessoal (um único usuário) que descobre concorrentes de um app/nicho, encontra quem tem anúncios escalados na Meta Ad Library e entrega os criativos (imagem/vídeo) com transcrição e análise. Faça tudo numa execução: planeje, implemente, teste de verdade e só pare quando o fluxo completo rodar. Decida sozinho o que for detalhe técnico; só me pergunte se algo bloquear a execução.

## 1. Objetivo do produto

Entrada (uma tela simples): nome do app/nicho OU URL do concorrente de referência, país (padrão BR), quantidade de concorrentes (padrão 5).
Saída: os N concorrentes com anúncios escalados, e para cada um os criativos que sustentam a conclusão, com mídia baixada, transcrição (vídeos) e análise. Tudo com a evidência por trás (dias no ar, nº de variações, plataformas, países).

## 2. Stack e infraestrutura

- Next.js (App Router) + TypeScript + Tailwind, em **tema claro** e com **linguagem simples em português** na interface.
- Supabase (nuvem) para Postgres, Storage e Auth. Login simples por e-mail e senha, com **cadastro desativado** (só o meu usuário).
- Um **worker Node/TypeScript separado**, em Docker, que consome uma fila de jobs. Fila = tabela `jobs` no Postgres com `FOR UPDATE SKIP LOCKED` e polling. **Sem Redis.**
- O worker precisa de `yt-dlp` e `ffmpeg` na imagem Docker.
- Deploy em **VPS** com Docker Compose (serviços: `web`, `worker`, `caddy` com HTTPS automático). Nada de Railway/Vercel.
- Segredos só por variáveis de ambiente; entregue `.env.example`. Nunca coloque chave no código nem em log.

Variáveis: `APIFY_TOKEN`, `EXA_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` (fallback de transcrição), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APIFY_META_ADS_ACTOR` (padrão `apify/facebook-ads-scraper`), `LLM_MODEL_ANALYSIS`, `TRANSCRIPTION_PROVIDER` (`openrouter` | `openai`), `TRANSCRIPTION_MODEL`.

## 3. Pipeline (um job "investigação" com etapas e status visíveis na tela)

1. **Descobrir candidatos** (EXA): buscas de intenção comercial e de alternativas ("alternativas a X", "X vs", "melhor app de [nicho]", "[nicho] app review"). Use um LLM via OpenRouter para extrair nome do app, domínio, nome provável da página no Facebook e tipo de oferta. Deduplique. Gere de 12 a 20 candidatos.
2. **Buscar anúncios na Meta Ad Library** via Apify (actor configurável). **Antes de codar essa etapa, consulte a documentação/schema real do actor** (use o Apify MCP ou a página do actor) e ajuste os campos reais de entrada e saída; não presuma nomes de campo. País e status "ativo" vêm da tela. Limite de anúncios por candidato configurável (padrão 60).
3. **Pontuar e filtrar escalados.** Para cada candidato calcule evidência e score com esta regra (pesos fixos em um arquivo de config, fácil de editar):
   - mais de 60 dias no ar: 5; entre 30 e 60 dias: 3
   - 4 ou mais plataformas simultâneas: 4
   - 3 ou mais variações de texto para o mesmo destino: 3 (considere "escalado" com 5+ variações)
   - 2 ou mais países: 4
   - formato vídeo: 2
   - CTA de ação (Saiba mais, Comprar, Instalar etc.): 2
   Selecione os N candidatos com maior score que também tenham pelo menos uma evidência forte (30+ dias **e** 3+ variações). Se menos de N passarem, mostre os que passaram e diga claramente quantos faltaram. **Nunca complete a lista com candidatos fracos sem avisar.** Guarde em cada candidato o motivo da seleção e o nível de evidência (alto, médio, baixo).
4. **Escolher criativos campeões** de cada candidato selecionado: top 3 a 5 anúncios pelo mesmo score, priorizando os mais antigos e com mais variações. Limite configurável de vídeos por investigação (padrão 15) e de minutos totais transcritos (padrão 90), para controlar custo.
5. **Baixar mídia no mesmo momento da coleta** (as URLs da Meta expiram): imagens direto; vídeos com `yt-dlp` ou download direto da URL do criativo. Envie para o Supabase Storage e guarde o caminho. Se um download falhar, marque o criativo como "mídia indisponível" e siga em frente.
6. **Transcrever vídeos:** extraia o áudio com ffmpeg (mono, 16 kHz) e divida em trechos de até 10 minutos se necessário. Crie uma interface `Transcriber` com dois provedores: `openrouter` (modelo multimodal com entrada de áudio, definido em `TRANSCRIPTION_MODEL`) e `openai` (Whisper API, `whisper-1`, idioma `pt`). Use o provedor de `TRANSCRIPTION_PROVIDER`; se o escolhido falhar, tente o outro e registre qual foi usado. Verifique na prática qual formato de áudio o OpenRouter aceita antes de fixar a implementação.
7. **Analisar com LLM (OpenRouter):** para cada criativo, devolva JSON validado com `hook`, `angulo` (curiosidade, dor, promessa, autoridade, contradição), `mecanismo`, `prova`, `cta`, `twist` e, para VSLs ou vídeos longos, os blocos de estrutura com timestamps. Para imagens, descreva formato, texto na imagem, estilo e paleta. Se algo não estiver no material, o campo vem como `null`, sem inventar.
8. **Consolidar** em um resumo por concorrente: quem é, por que foi selecionado (com os números), padrões de hook e ângulo, e links para os criativos.

## 4. Telas

- **Nova investigação:** formulário da seção 1.
- **Lista de investigações** com status e custo estimado.
- **Detalhe da investigação:** barra de etapas com status por etapa (pendente, rodando, concluída, falhou, com mensagem de erro legível); cards dos concorrentes selecionados com evidência; dentro de cada um, galeria dos criativos (player de vídeo, imagem), transcrição expansível e análise.
- **Exportar:** botão que gera um `.md` e um `.csv` da investigação (concorrentes, evidência, criativos, transcrições, análises).
- Botão "refazer etapa" quando uma etapa falhar, sem repetir as etapas já concluídas.

## 5. Banco de dados

Crie as migrations SQL do Supabase com: `investigations`, `candidates`, `ads`, `creatives` (mídia, transcrição, análise), `jobs`, `job_events` (log por etapa) e `cost_log` (provedor, tokens/minutos, custo estimado). Ative RLS e libere acesso só para o usuário autenticado. O worker usa a service role.

## 6. Regras de qualidade (obrigatórias)

- **Honestidade dos dados:** toda conclusão mostra a evidência. Dado ausente aparece como "não coletado", nunca como suposição.
- Erros de Apify, EXA, OpenRouter e download têm retry com backoff, timeout e mensagem clara na tela; uma falha em um candidato não derruba a investigação inteira.
- Controle de custo: limites da seção 3 configuráveis, e estimativa de custo mostrada antes de iniciar a investigação e atualizada no fim.
- Respeite limites de taxa; processe um candidato por vez no Apify, com pausa curta entre chamadas.
- Uso pessoal e público: só dados públicos da Ad Library; nada de login falso, bypass de cloaker, proxies ou scraping de áreas privadas. Inclua no README um aviso de que as mídias são para análise interna, não para republicação.
- Deixe pontos de extensão (pastas e interfaces vazias, sem implementar) para: tráfego do site, Instagram e síntese multi-player.

## 7. Entregáveis

1. Código completo (monorepo `apps/web`, `apps/worker`, `supabase/migrations`), `docker-compose.yml`, `Dockerfile` de cada serviço, `Caddyfile`, `.env.example`.
2. `README.md` em português com: criar o projeto no Supabase e aplicar as migrations, criar o único usuário, subir na VPS (Docker Compose + domínio + HTTPS), atualizar a versão e ler logs.
3. Um script `scripts/smoke-test.ts` que roda uma investigação pequena de ponta a ponta (2 concorrentes, 1 vídeo) e imprime o resultado.

## 8. Verificação (faça antes de encerrar)

- Rode o smoke test com chaves reais se estiverem no `.env`; se não estiverem, rode com mocks dos provedores e diga explicitamente o que **não** foi testado com serviço real.
- Confirme que `docker compose build` passa, que a migration aplica sem erro e que o login bloqueia cadastro novo.
- No final, entregue um resumo curto: o que funciona, o que foi só mockado, os campos do actor do Apify que você confirmou, qual provedor de transcrição ficou ativo e o custo estimado de uma investigação típica.
