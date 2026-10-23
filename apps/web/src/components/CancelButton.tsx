'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CancelButton({ investigationId }: { investigationId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function cancel() {
    if (!window.confirm('Parar esta investigação? O que já foi coletado é preservado.')) return;
    setLoading(true);
    await fetch(`/api/investigations/${investigationId}/cancel`, { method: 'POST' });
    setLoading(false);
    router.refresh();
  }

  return (
    <button
      onClick={cancel}
      disabled={loading}
      className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
    >
      {loading ? 'Parando…' : 'Parar investigação'}
    </button>
  );
}
