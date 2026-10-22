import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { STATUS_PT, STATUS_STYLE, usdFmt, dateFmt } from '@/lib/format';
import { LogoutButton } from '@/components/LogoutButton';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createClient();
  const { data: investigations } = await supabase
    .from('investigations')
    .select('*')
    .order('created_at', { ascending: false });

  const rows = investigations ?? [];

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Investigações</h1>
        <LogoutButton />
      </div>

      {rows.length === 0 ? (
        <div className="card text-center text-gray-500">
          <p className="mb-3">Nenhuma investigação ainda.</p>
          <Link href="/investigations/new" className="btn-primary">
            Criar a primeira
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((inv) => (
            <Link
              key={inv.id}
              href={`/investigations/${inv.id}`}
              className="card flex items-center justify-between hover:border-brand"
            >
              <div>
                <div className="font-medium">{inv.query}</div>
                <div className="text-sm text-gray-500">
                  País {inv.country} · {inv.competitors} concorrentes · criada {dateFmt(inv.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-4 text-right">
                <div className="text-sm text-gray-500">
                  <div>Estimado: {usdFmt(Number(inv.estimated_cost_usd))}</div>
                  <div>Final: {usdFmt(inv.final_cost_usd == null ? null : Number(inv.final_cost_usd))}</div>
                </div>
                <span className={`badge ${STATUS_STYLE[inv.status]}`}>{STATUS_PT[inv.status]}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
