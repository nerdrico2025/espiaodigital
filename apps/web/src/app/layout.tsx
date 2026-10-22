import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Espião de Ofertas Escaladas',
  description: 'Descubra concorrentes e analise anúncios escalados na Meta Ad Library.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="text-lg font-semibold text-gray-900">
              🕵️ Espião de Ofertas
            </Link>
            <nav className="flex items-center gap-3 text-sm">
              <Link href="/" className="text-gray-600 hover:text-gray-900">
                Investigações
              </Link>
              <Link href="/investigations/new" className="btn-primary">
                Nova investigação
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-gray-400">
          Uso pessoal. Mídias coletadas da Ad Library pública são para análise interna, não para republicação.
        </footer>
      </body>
    </html>
  );
}
