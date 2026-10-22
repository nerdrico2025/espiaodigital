'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { estimateInvestigationCost } from '@espiao/shared';
import { usdFmt } from '@/lib/format';

export default function NewInvestigationPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('BR');
  const [competitors, setCompetitors] = useState(5);
  const [onlyActive, setOnlyActive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const estimate = useMemo(() => estimateInvestigationCost(competitors), [competitors]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch('/api/investigations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, country, competitors, onlyActive }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? 'Falha ao criar investigação.');
      return;
    }
    const { id } = await res.json();
    router.push(`/investigations/${id}`);
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-2xl font-semibold">Nova investigação</h1>
      <p className="mb-5 text-sm text-gray-500">
        Informe um nicho, o nome de um app, ou a URL de um concorrente de referência.
      </p>

      <form onSubmit={onSubmit} className="card space-y-4">
        <div>
          <label className="label">Nicho, app ou URL do concorrente</label>
          <input
            className="input"
            placeholder="ex.: app de finanças pessoais / https://concorrente.com"
            required
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">País</label>
            <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="BR">Brasil (BR)</option>
              <option value="PT">Portugal (PT)</option>
              <option value="US">Estados Unidos (US)</option>
              <option value="ALL">Todos (ALL)</option>
            </select>
          </div>
          <div>
            <label className="label">Quantidade de concorrentes</label>
            <input
              type="number"
              min={1}
              max={20}
              className="input"
              value={competitors}
              onChange={(e) => setCompetitors(Math.max(1, Math.min(20, Number(e.target.value))))}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          Só anúncios ativos
        </label>

        <div className="rounded-lg bg-brand-soft p-3 text-sm">
          <div className="font-medium text-brand">Custo estimado (teto): {usdFmt(estimate.total)}</div>
          <ul className="mt-1 text-gray-600">
            {estimate.entries.map((e) => (
              <li key={e.provider + e.unit}>
                {e.provider} · {e.quantity} {e.unit} → {usdFmt(e.estimatedUsd)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-gray-400">
            Estimativa de pior caso. O custo real (menor) aparece ao final.
          </p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={loading || !query.trim()}>
          {loading ? 'Criando…' : 'Iniciar investigação'}
        </button>
      </form>
    </div>
  );
}
