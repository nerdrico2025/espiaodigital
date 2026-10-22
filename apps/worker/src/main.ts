// Worker: faz polling na fila (tabela jobs) e executa investigações.
// Sem Redis — usa a função claim_job (FOR UPDATE SKIP LOCKED).

import { randomUUID } from 'node:crypto';
import { buildRealDeps, defaultLogger } from './deps.js';
import { readEnv } from './env.js';
import { runInvestigation, errMessage } from './pipeline/run.js';
import type { SupabaseDb } from './db/supabase-db.js';

const WORKER_ID = `worker-${process.env.HOSTNAME ?? randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 4000);

let shuttingDown = false;

async function claimJob(db: SupabaseDb): Promise<any | null> {
  const { data, error } = await db.client.rpc('claim_job', { p_worker: WORKER_ID });
  if (error) throw new Error(`claim_job: ${error.message}`);
  return data ?? null;
}

async function finishJob(db: SupabaseDb, jobId: string, status: 'concluida' | 'falhou', err?: string) {
  await db.client
    .from('jobs')
    .update({ status, locked_at: null, locked_by: null, last_error: err ?? null })
    .eq('id', jobId);
}

async function main() {
  const env = readEnv();
  const { deps, db } = buildRealDeps(env);
  defaultLogger.info(`Worker iniciado (${WORKER_ID}). Transcrição: ${env.TRANSCRIPTION_PROVIDER}.`);

  process.on('SIGTERM', () => {
    shuttingDown = true;
    defaultLogger.info('SIGTERM recebido, encerrando após o job atual.');
  });
  process.on('SIGINT', () => {
    shuttingDown = true;
  });

  while (!shuttingDown) {
    let job: any = null;
    try {
      job = await claimJob(db);
    } catch (e) {
      defaultLogger.error('Falha ao reivindicar job', errMessage(e));
    }

    if (!job) {
      await sleep(POLL_MS);
      continue;
    }

    defaultLogger.info(`Job ${job.id} reivindicado (investigação ${job.investigation_id}).`);
    try {
      await runInvestigation(deps, job.investigation_id);
      await finishJob(db, job.id, 'concluida');
      defaultLogger.info(`Job ${job.id} concluído.`);
    } catch (e) {
      const msg = errMessage(e);
      await finishJob(db, job.id, 'falhou', msg);
      defaultLogger.error(`Job ${job.id} falhou`, msg);
    }
  }

  defaultLogger.info('Worker encerrado.');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  defaultLogger.error('Erro fatal no worker', errMessage(e));
  process.exit(1);
});
