'use client';
import { useState } from 'react';

export function Expandable({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-200">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
      >
        <span>{title}</span>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="border-t border-gray-100 px-3 py-2 text-sm text-gray-700">{children}</div>}
    </div>
  );
}
