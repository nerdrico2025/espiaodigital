'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Refaz só o mapeamento da VSL (reaproveita a transcrição já salva).
export function RemapVslButton({ investigationId }: { investigationId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function remap() {
    if (!window.confirm('Refazer só o mapeamento desta VSL? A transcrição já salva é reaproveitada (sem baixar nem transcrever de novo).')) return;
    setLoading(true);
    await fetch(`/api/investigations/${investigationId}/vsl/remap`, { method: 'POST' });
    setLoading(false);
    router.refresh();
  }

  return (
    <button onClick={remap} disabled={loading} className="btn-ghost text-xs">
      {loading ? 'Reenfileirando…' : '↻ Refazer só o mapeamento'}
    </button>
  );
}
