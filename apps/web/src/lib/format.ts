import type { StepName } from '@espiao/shared';

export function brl(usd: number, rate = 5.2): string {
  return (usd * rate).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function usdFmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return `US$ ${n.toFixed(2)}`;
}

export function dateFmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export const STATUS_PT: Record<string, string> = {
  pendente: 'Pendente',
  rodando: 'Rodando',
  concluida: 'Concluída',
  falhou: 'Falhou',
};

export const STATUS_STYLE: Record<string, string> = {
  pendente: 'bg-gray-100 text-gray-700',
  rodando: 'bg-blue-100 text-blue-700',
  concluida: 'bg-green-100 text-green-700',
  falhou: 'bg-red-100 text-red-700',
};

export const EVIDENCE_PT: Record<string, string> = {
  alto: 'Alta',
  medio: 'Média',
  baixo: 'Baixa',
};

export function stepLabel(step: StepName | string): string {
  const labels: Record<string, string> = {
    descobrir: 'Descobrir candidatos',
    buscar_ads: 'Buscar anúncios',
    pontuar: 'Pontuar escalados',
    escolher_criativos: 'Escolher criativos',
    baixar_midia: 'Baixar mídia',
    transcrever: 'Transcrever vídeos',
    analisar: 'Analisar com IA',
    consolidar: 'Consolidar',
    capturar_funil: 'Capturar funil',
  };
  return labels[step] ?? step;
}
