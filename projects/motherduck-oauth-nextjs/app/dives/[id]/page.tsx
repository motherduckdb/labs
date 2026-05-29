import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getStoredTokens } from '@/lib/motherduck-oauth';

export const dynamic = 'force-dynamic';

export default async function DivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ title?: string }>;
}) {
  const tokens = await getStoredTokens();
  if (!tokens) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;
  const title = typeof sp.title === 'string' && sp.title.length > 0 ? sp.title : 'Dive';

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-foreground underline underline-offset-2 hover:text-accent-foreground"
        >
          &larr; All Dives
        </Link>
        <a
          href="/api/auth/motherduck/logout"
          className="text-sm font-medium text-foreground underline underline-offset-2 hover:text-accent-foreground"
        >
          Sign out
        </a>
      </header>

      <h1 className="text-2xl font-semibold tracking-tight mb-1">{title}</h1>
      <p className="text-xs text-brutal-muted font-mono mb-6">{id}</p>

      {/* The dive renders in a same-origin iframe served by /api/dives/view,
          which runs the dive's queries in-browser via the MotherDuck WASM
          client (scoped to the signed-in user's short-lived token). */}
      <div className="border-2 border-foreground rounded-sm shadow-[3px_3px_0_#171717] overflow-hidden bg-white">
        <iframe
          src={`/api/dives/view?id=${encodeURIComponent(id)}`}
          title={title}
          className="block w-full"
          style={{ height: '760px', border: 0 }}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </main>
  );
}
