import Link from 'next/link';
import { requireUserAccessToken } from '@/lib/require-auth';
import { createEmbedSession, embedIframeSrc, EmbedNotConfiguredError } from '@/lib/dive-embed';
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
  const accessToken = await requireUserAccessToken(`/dives/${id}`);

  const sp = await searchParams;
  const title = typeof sp.title === 'string' && sp.title.length > 0 ? sp.title : 'Dive';

  // Mint a MotherDuck embed session server-side. The browser only ever gets
  // the opaque session (in the iframe URL) — never a MotherDuck token.
  let embedSrc: string | null = null;
  let notConfigured = false;
  let error: string | null = null;
  try {
    const session = await createEmbedSession(accessToken, id);
    embedSrc = embedIframeSrc(session);
  } catch (e) {
    if (e instanceof EmbedNotConfiguredError) {
      notConfigured = true;
    } else {
      console.error('[Dive] embed session failed:', e);
      error = 'Could not open this Dive.';
    }
  }

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

      {embedSrc && <DiveFrame src={embedSrc} title={title} />}

      {notConfigured && (
        <div className="border-2 border-foreground rounded-sm bg-brutal-surface p-6 text-sm">
          <p className="font-semibold mb-2">Embedding isn&apos;t configured yet.</p>
          <p className="text-brutal-muted leading-relaxed">
            Set <code className="font-mono">MOTHERDUCK_EMBED_TOKEN</code> to a MotherDuck
            service-account (Admin) token. Dive embed sessions can only be created with a
            service-account token; this app keeps it server-side and runs the embed as the
            signed-in user. See{' '}
            <a
              href="https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/embedding-dives/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              Embedding Dives
            </a>
            .
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </main>
  );
}
