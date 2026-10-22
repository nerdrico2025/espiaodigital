import { createClient } from '@supabase/supabase-js';

// Cliente com service role — IGNORA RLS. Use SOMENTE em rotas de servidor,
// nunca no browser. Serve para enfileirar jobs e ler mídia privada.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
