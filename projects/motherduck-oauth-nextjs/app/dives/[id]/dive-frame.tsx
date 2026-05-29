'use client';

import { useState } from 'react';

/**
 * Renders the Dive viewer iframe with a loading overlay until the iframe's
 * document finishes loading. The viewer route (`/api/dives/view`) does
 * server-side work first (mint token, fetch source, build HTML), so without
 * this the iframe shows blank until that returns.
 */
export function DiveFrame({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className="relative border-2 border-foreground rounded-sm shadow-[3px_3px_0_#171717] overflow-hidden bg-white"
      style={{ height: '760px' }}
    >
      {!loaded && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white text-brutal-muted">
          <span className="w-7 h-7 rounded-full border-2 border-foreground/20 border-t-foreground animate-spin" />
          <span className="text-sm">Loading dive…</span>
        </div>
      )}
      {/* Deliberately NO `allow-same-origin`: the iframe runs arbitrary Dive
          source, so it gets an opaque origin. Combined with `allow-scripts`
          that keeps the dive from reaching this app's origin — it can't read
          the parent DOM or call our authenticated APIs with the user's
          cookies (those requests become cross-site, so SameSite=Lax cookies
          aren't sent and the CSRF guard holds). The viewer only needs to run
          JS and talk to MotherDuck over the network. */}
      <iframe
        src={src}
        title={title}
        onLoad={() => setLoaded(true)}
        className="block w-full h-full"
        style={{ border: 0 }}
        sandbox="allow-scripts"
      />
    </div>
  );
}
