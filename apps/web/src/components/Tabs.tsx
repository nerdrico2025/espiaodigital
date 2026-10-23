'use client';
import { useState, type ReactNode } from 'react';

// Abas fixas no topo do detalhe. Recebe o conteúdo já renderizado (server) e só
// alterna a visibilidade — mantém o estado no cliente sem recarregar a página.
export function Tabs({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              active === t.id
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} hidden={active !== t.id}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
