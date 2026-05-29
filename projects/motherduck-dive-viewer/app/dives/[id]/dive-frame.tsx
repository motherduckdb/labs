'use client';

import { useState } from 'react';

/**
 * Renders the Dive viewer iframe (`/api/dives/view`, same app origin) with a
 * loading overlay until it loads. `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` gives the document an opaque origin, so arbitrary Dive
 * code can't reach this app's cookies/DOM/APIs. The dive talks to the server
 * query proxy via an encrypted capability instead.
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
