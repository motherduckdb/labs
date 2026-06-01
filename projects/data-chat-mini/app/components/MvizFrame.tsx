import { useEffect, useRef, useState } from 'react';

/**
 * MvizFrame — sandboxed iframe that renders an mviz table/chart.
 *
 * Auto-sizes from `postMessage({type:'mviz-height', height})`
 * notifications emitted by mviz's bundled height-reporter script.
 *
 * The page chrome (top accent bar, title row, theme toggle, etc.) is
 * stripped upstream at render time — `processMvizMarkdown` renders with
 * mviz's `embedOverride` (^1.7.0), which omits the chrome and prunes the
 * output for iframe embedding. This used to require a local CSS strip
 * (matsonj/mviz#11); embed mode delivered it, so the strip is gone.
 *
 * Shared between chat and prism so both surfaces render identical frames.
 */
export function MvizFrame({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(180);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handler = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (
        e.data?.type === 'mviz-height' &&
        typeof e.data.height === 'number' &&
        e.data.height > 0
      ) {
        // Clamp to avoid runaway-tall frames from a misbehaving inner doc.
        setHeight(Math.min(e.data.height + 16, 1200));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      className="mviz-frame"
      style={{ height, pointerEvents: 'none' }}
      sandbox="allow-scripts"
      title="Visualization"
    />
  );
}
