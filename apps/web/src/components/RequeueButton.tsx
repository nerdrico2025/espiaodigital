'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RequeueButton({ investigationId, step }: { investigationId: string; step: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function requeue() {
    setLoading(true);
    await fetch(`/api/investigations/${investigationId}/requeue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step }),
    });
    setLoading(false);
    router.refresh();
  }

  return (
    <button onClick={requeue} disabled={loading} className="btn-ghost text-xs">
      {loading ? 'Reenfileirando…' : '↻ Refazer a partir desta etapa'}
    </button>
  );
}
