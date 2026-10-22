import { STEP_ORDER } from '@espiao/shared';
import { stepLabel } from '@/lib/format';
import { RequeueButton } from './RequeueButton';

type EventRow = { step: string; status: string; message: string | null; created_at: string };

function stepStatus(
  step: string,
  completed: string[],
  current: string | null,
  jobStatus: string,
): 'concluida' | 'rodando' | 'falhou' | 'pendente' {
  if (completed.includes(step)) return 'concluida';
  if (current === step && jobStatus === 'rodando') return 'rodando';
  if (current === step && jobStatus === 'falhou') return 'falhou';
  return 'pendente';
}

const DOT: Record<string, string> = {
  concluida: 'bg-green-500',
  rodando: 'bg-blue-500 animate-pulse',
  falhou: 'bg-red-500',
  pendente: 'bg-gray-300',
};

export function StepBar({
  investigationId,
  completed,
  current,
  jobStatus,
  lastError,
  events,
}: {
  investigationId: string;
  completed: string[];
  current: string | null;
  jobStatus: string;
  lastError: string | null;
  events: EventRow[];
}) {
  return (
    <div className="card">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Etapas</h2>
      <ol className="space-y-2">
        {STEP_ORDER.map((step) => {
          const st = stepStatus(step, completed, current, jobStatus);
          const lastEvent = [...events].reverse().find((e) => e.step === step);
          return (
            <li key={step} className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[st]}`} />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{stepLabel(step)}</span>
                  <span className="text-xs text-gray-400">
                    {st === 'concluida' ? 'Concluída' : st === 'rodando' ? 'Rodando…' : st === 'falhou' ? 'Falhou' : 'Pendente'}
                  </span>
                </div>
                {st === 'falhou' && (
                  <div className="mt-1 space-y-1">
                    <p className="text-xs text-red-600">{lastError ?? lastEvent?.message ?? 'Erro.'}</p>
                    <RequeueButton investigationId={investigationId} step={step} />
                  </div>
                )}
                {st !== 'falhou' && lastEvent?.message && (
                  <p className="text-xs text-gray-400">{lastEvent.message}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
