'use client';

import { useState } from 'react';

/**
 * Renders the MotherDuck Dive embed iframe (embed-motherduck.com) with a
 * loading overlay until it finishes loading. `src` is the documented embed URL
 * (`…/sandbox/#session=<session>`); the sandbox attributes are the documented
 * `allow-scripts allow-same-origin` (same-origin here refers to
 * embed-motherduck.com's own origin — cross-origin to this app, so it stays
 * isolated from us).
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
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
