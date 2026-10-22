'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Atualiza a página periodicamente enquanto a investigação está em andamento.
export function AutoRefresh({ active, ms = 5000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}
