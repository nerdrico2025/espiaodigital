'use client';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await createClient().auth.signOut();
    router.replace('/login');
    router.refresh();
  }
  return (
    <button onClick={logout} className="btn-ghost">
      Sair
    </button>
  );
}
