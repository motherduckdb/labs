import Link from 'next/link';
import { requireUserAccessToken } from '@/lib/require-auth';
import { DiveFrame } from './dive-frame';

export const dynamic = 'force-dynamic';

export default async function DivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ title?: string }>;
}) {
  const { id } = await params;
  await requireUserAccessToken(`/dives/${id}`);

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
      <DiveFrame src={`/api/dives/view?id=${encodeURIComponent(id)}`} title={title} />
    </main>
  );
}
