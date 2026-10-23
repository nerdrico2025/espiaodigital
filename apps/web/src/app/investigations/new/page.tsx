'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  estimateInvestigationCost,
  clampInvestigationConfig,
  resolveLimits,
  INVESTIGATION_CONFIG_BOUNDS,
  type InvestigationConfig,
  type InvestigationMode,
} from '@espiao/shared';
import { usdFmt } from '@/lib/format';

// Textos de cada modo (PT simples).
const MODES: {
  value: InvestigationMode;
  title: string;
  hint: string;
  fieldLabel: string;
  placeholder: string;
}[] = [
  {
    value: 'concorrentes',
    title: 'Descobrir concorrentes',
    hint: 'Informe uma referência; nós achamos os concorrentes dela e analisamos os anúncios escalados.',
    fieldLabel: 'App, nicho ou URL de referência (vamos achar os concorrentes dele)',
    placeholder: 'ex.: app de finanças pessoais / https://concorrente.com',
  },
  {
    value: 'anunciante',
    title: 'Analisar este anunciante',
    hint: 'Analisa só a empresa informada: busca, pontua e analisa os anúncios escalados dela (sem descobrir concorrentes).',
    fieldLabel: 'URL ou nome da empresa que você quer analisar',
    placeholder: 'ex.: https://zeely.ai / Zeely',
  },
];

// Campos de "Opções avançadas". A key casa com InvestigationConfig.
const ADVANCED_FIELDS: {
  key: keyof InvestigationConfig;
  label: string;
}[] = [
  { key: 'candidates', label: 'Candidatos a pesquisar' },
  { key: 'adsPerCandidate', label: 'Anúncios por candidato' },
  { key: 'maxVideos', label: 'Máximo de vídeos para transcrever' },
  { key: 'maxTranscriptionMinutes', label: 'Máximo de minutos de transcrição' },
];

export default function NewInvestigationPage() {
  const router = useRouter();
  const [mode, setMode] = useState<InvestigationMode>('concorrentes');
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('BR');
  const [competitors, setCompetitors] = useState(5);
  const [onlyActive, setOnlyActive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modeInfo = MODES.find((m) => m.value === mode)!;

  // Guardadas como string para permitir campo vazio (= usa o padrão fixo).
  // Pré-preenchidas com os padrões de teste de INVESTIGATION_CONFIG_BOUNDS.
  const [advanced, setAdvanced] = useState<Record<keyof InvestigationConfig, string>>({
    candidates: String(INVESTIGATION_CONFIG_BOUNDS.candidates.default),
    adsPerCandidate: String(INVESTIGATION_CONFIG_BOUNDS.adsPerCandidate.default),
    maxVideos: String(INVESTIGATION_CONFIG_BOUNDS.maxVideos.default),
    maxTranscriptionMinutes: String(INVESTIGATION_CONFIG_BOUNDS.maxTranscriptionMinutes.default),
  });

  // Config limpa (campos vazios omitidos → caem no padrão) para envio e estimativa.
  const config = useMemo(() => clampInvestigationConfig(advanced), [advanced]);
  // Recalcula a estimativa em tempo real conforme os campos/modo mudam.
  const estimate = useMemo(
    () => estimateInvestigationCost(competitors, resolveLimits(config), mode),
    [competitors, config, mode],
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch('/api/investigations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, query, country, competitors, onlyActive, config }),
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
      <p className="mb-5 text-sm text-gray-500">{modeInfo.hint}</p>

      <form onSubmit={onSubmit} className="card space-y-4">
        {/* Seletor de modo */}
        <div>
          <label className="label">O que você quer fazer?</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODES.map((m) => {
              const active = m.value === mode;
              return (
                <button
                  type="button"
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`rounded-lg border p-3 text-left text-sm transition ${
                    active
                      ? 'border-brand bg-brand-soft text-brand'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-medium">{m.title}</div>
                  <div className={`mt-0.5 text-xs ${active ? 'text-brand' : 'text-gray-500'}`}>
                    {m.value === 'concorrentes' ? 'Acha os concorrentes da referência' : 'Só a empresa informada'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="label">{modeInfo.fieldLabel}</label>
          <input
            className="input"
            placeholder={modeInfo.placeholder}
            required
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className={`grid gap-4 ${mode === 'anunciante' ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <div>
            <label className="label">País</label>
            <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="BR">Brasil (BR)</option>
              <option value="PT">Portugal (PT)</option>
              <option value="US">Estados Unidos (US)</option>
              <option value="ALL">Todos (ALL)</option>
            </select>
          </div>
          {mode === 'concorrentes' && (
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
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          Só anúncios ativos
        </label>

        <details className="rounded-lg border border-gray-200 p-3">
          <summary className="cursor-pointer select-none text-sm font-medium text-gray-700">
            Opções avançadas
          </summary>
          <p className="mt-2 text-xs text-gray-400">
            Deixe um campo em branco para usar o padrão do sistema.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-4">
            {ADVANCED_FIELDS.filter(
              (f) => !(mode === 'anunciante' && f.key === 'candidates'),
            ).map(({ key, label }) => {
              const b = INVESTIGATION_CONFIG_BOUNDS[key];
              return (
                <div key={key}>
                  <label className="label">{label}</label>
                  <input
                    type="number"
                    min={b.min}
                    max={b.max}
                    className="input"
                    value={advanced[key]}
                    onChange={(e) =>
                      setAdvanced((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  />
                  <p className="mt-0.5 text-xs text-gray-400">
                    mín. {b.min}, máx. {b.max}
                  </p>
                </div>
              );
            })}
          </div>
        </details>

        <div className="rounded-lg bg-brand-soft p-3 text-sm">
          <div className="font-medium text-brand">Custo estimado (teto): {usdFmt(estimate.total)}</div>
          <ul className="mt-1 text-gray-600">
            {estimate.entries.map((e) => (
              <li key={e.provider + e.unit}>
                {e.provider} · {e.quantity} {e.unit} → {usdFmt(e.estimatedUsd)}
                {e.note ? <span className="text-gray-400"> ({e.note})</span> : null}
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
