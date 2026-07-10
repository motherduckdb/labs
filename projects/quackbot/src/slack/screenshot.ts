import { chromium, type Browser } from 'playwright';

/**
 * Renders self-contained mviz embed HTML to a PNG for Slack, since Slack
 * cannot display interactive charts inline. The embed HTML carries its own
 * styles + scripts (recharts, etc.), so all we do is drop it into a headless
 * Chromium page, let the charts settle, and screenshot the dashboard root.
 *
 * The browser is a lazily-launched singleton reused across renders — launching
 * Chromium per chart would add ~1s of latency to every visualization. Call
 * `closeBrowser()` on process shutdown to release it.
 */

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      // Reset so a later call can retry (e.g. after the user installs the
      // browser). Surface an actionable message — the usual failure is a
      // missing browser binary.
      browserPromise = null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to launch headless Chromium for chart rendering: ${detail}. ` +
          'If the browser is not installed, run `npx playwright install chromium`.',
      );
    });
  }
  return browserPromise;
}

/** Breathing room kept around the chart tile inside the shot, in CSS px. */
const CLIP_PAD_PX = 16;

/**
 * Render a self-contained HTML document (an mviz embed) to a PNG buffer.
 *
 * The page is 900px wide and mviz lays the chart out on its 16-column grid,
 * so the fence's `size=[w,h]` decides the `.grid-item` box (w=8 → ~424px
 * wide, taller h → taller box). Screenshot THAT box — plus a little padding,
 * clamped to the dashboard — so the PNG Slack displays is the size the spec
 * asked for, not a full-width canvas with dead space beside a half-width
 * chart. Multi-tile embeds and missing selectors fall back to the
 * `.dashboard` root, then to a full-page shot.
 */
export async function renderHtmlToPng(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 900, height: 600 },
    deviceScaleFactor: 2,
  });
  try {
    // networkidle is best-effort: the embed may pull a webfont, and a slow
    // font CDN shouldn't block the shot. If it times out we screenshot what
    // rendered anyway.
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      // fall through — render whatever is on the page
    }
    // Give charts a beat to animate/settle before capturing.
    await page.waitForTimeout(500);

    const root = page.locator('.dashboard').first();
    let buffer: Buffer | null = null;
    try {
      const dashBox = (await root.count()) > 0 ? await root.boundingBox() : null;
      const items = page.locator('.dashboard .grid-item');
      const itemBox = (await items.count()) === 1 ? await items.first().boundingBox() : null;
      if (dashBox && itemBox) {
        const x = Math.max(dashBox.x, itemBox.x - CLIP_PAD_PX);
        const y = Math.max(dashBox.y, itemBox.y - CLIP_PAD_PX);
        buffer = await page.screenshot({
          type: 'png',
          clip: {
            x,
            y,
            width: Math.min(dashBox.x + dashBox.width, itemBox.x + itemBox.width + CLIP_PAD_PX) - x,
            height: Math.min(dashBox.y + dashBox.height, itemBox.y + itemBox.height + CLIP_PAD_PX) - y,
          },
        });
      } else if (dashBox) {
        buffer = await root.screenshot({ type: 'png' });
      }
    } catch {
      // fall through to the full-page shot
    }
    return buffer ?? (await page.screenshot({ type: 'png', fullPage: true }));
  } finally {
    await page.close().catch(() => {});
  }
}

/** Close the shared browser. Best-effort; safe to call when never launched. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* ignore */
  }
}
