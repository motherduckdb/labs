import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';

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
 * The embed HTML (`processMvizMarkdown`) carries its specs inline and issues no
 * runtime `fetch`/XHR, but it is NOT fully self-contained: mviz emits a
 * `document.write`n `<script src>` for echarts on every chart tile (see
 * `mviz/dist/core/serializer.js`). Two legitimate external requests, then:
 * the echarts bundle, and the Google Fonts `@import` in mviz-theme's
 * `MVIZ_FONT_IMPORT_URL` (the CSS on fonts.googleapis.com, then the font files
 * on fonts.gstatic.com).
 *
 * echarts is served from disk rather than the network — see
 * `resolveVendoredAsset`. Only the fonts actually leave the machine.
 *
 * Chart content is model- and query-data-derived, i.e. attacker-influenced, so
 * we treat the render as hostile: even if injected markup or a raw-JS chart
 * option executes inside the page, this allowlist denies it any network egress.
 * Blocking everything except the two font hosts kills SSRF to internal
 * services / the cloud metadata endpoint (169.254.169.254), loopback, private
 * ranges, `file://` reads, and exfiltration to arbitrary hosts.
 */
const ALLOWED_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

export function isAllowedResourceUrl(rawUrl: string): boolean {
  // Inline/embedded schemes carry no network egress and no filesystem access.
  if (/^(data|blob|about):/i.test(rawUrl)) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // Only HTTPS to the Google Fonts hosts. Everything else — http:, file:, any
  // other host, and every IP-literal (so loopback/link-local/private targets
  // can't be reached by hostname or by raw address) — is denied.
  return url.protocol === 'https:' && ALLOWED_FONT_HOSTS.has(url.hostname);
}

const require_ = createRequire(import.meta.url);

/**
 * The chart-library script mviz asks jsdelivr for, e.g.
 * `/npm/echarts@5.5.0/dist/echarts.min.js`. Capture group 1 is the major.
 */
const ECHARTS_CDN_PATH_RE = /^\/npm\/echarts@(\d+)[^/]*\/dist\/echarts(\.min)?\.js$/;

/**
 * Major version of the echarts we vendor. A request for a DIFFERENT major is
 * refused rather than answered with this bundle: serving echarts 5 to an embed
 * written against echarts 6 would reintroduce the very bug this vendoring
 * fixes — a blank chart — but silently, and with the mismatch buried a layer
 * deeper. Refusing instead fails closed at the allowlist and trips the
 * "covers every external script" test in `screenshot.test.ts`, which is what
 * turns an mviz major bump into a build-time failure with a name on it.
 *
 * Patch and minor bumps inside the major are served as usual.
 */
const VENDORED_ECHARTS_MAJOR = ((): string | null => {
  try {
    const { version } = require_('echarts/package.json') as { version: string };
    return version.split('.')[0] ?? null;
  } catch {
    return null;
  }
})();

/**
 * Map a CDN request to a local file to serve in its place, or null to let the
 * allowlist decide.
 *
 * Blocking echarts outright (the allowlist's behavior before this existed) left
 * every chart PNG as a bare tile title over an empty canvas — the static HTML
 * renders, `echarts is not defined` kills the chart body. Allowlisting
 * cdn.jsdelivr.net would fix that by handing attacker-influenced page content a
 * live fetch channel to a host that serves any npm package at any path, which
 * is exactly the egress this sandbox exists to deny.
 *
 * So echarts is a real dependency of this project and gets fulfilled off disk:
 * no egress, version pinned by the lockfile, no CDN in the render path, and
 * charts render with the network fully unplugged. Reads are confined to this
 * one resolved module path — the URL never influences which file is opened.
 */
export function resolveVendoredAsset(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'cdn.jsdelivr.net') return null;
  const match = ECHARTS_CDN_PATH_RE.exec(url.pathname);
  if (!match) return null;
  // Only answer for the major we actually vendor — see VENDORED_ECHARTS_MAJOR.
  if (VENDORED_ECHARTS_MAJOR === null || match[1] !== VENDORED_ECHARTS_MAJOR) return null;
  try {
    return require_.resolve('echarts/dist/echarts.min.js');
  } catch {
    // Dependency missing — fall through to the allowlist, which denies it. The
    // chart renders empty (visibly broken) instead of silently reaching a CDN.
    return null;
  }
}

/**
 * Load an mviz embed in a network-sandboxed page and hand it to `fn`.
 *
 * Shared by the PNG path and by `probeRenderedChart`, so a test asserting the
 * chart actually drew exercises the same sandbox production renders through —
 * the empty-chart bug lived entirely in this route handler, so a test that
 * built its own page would have missed it.
 */
async function withRenderedPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 900, height: 600 },
    deviceScaleFactor: 2,
  });
  try {
    // Sandbox the render's network: serve the chart library from disk, allow
    // only the embed's font fetch, abort everything else. This is the
    // load-bearing control against SSRF/exfil from attacker-influenced chart
    // content — see the comments on isAllowedResourceUrl and
    // resolveVendoredAsset. Registered before setContent so the very first
    // subresource load is already gated.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const vendored = resolveVendoredAsset(url);
      if (vendored) {
        void route.fulfill({ path: vendored, contentType: 'application/javascript; charset=utf-8' });
      } else if (isAllowedResourceUrl(url)) {
        void route.continue();
      } else {
        void route.abort();
      }
    });
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
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * What a rendered embed's DOM actually contains. Exists so tests can assert the
 * chart drew — a blank tile is a perfectly valid PNG, so pixel output alone
 * cannot distinguish a working chart from a failed one.
 */
export interface RenderedChartProbe {
  echartsInstances: number;
  svgPaths: number;
  text: string;
}

export async function probeRenderedChart(html: string): Promise<RenderedChartProbe> {
  return withRenderedPage(html, (page) =>
    page.evaluate(`(() => ({
      echartsInstances: document.querySelectorAll('[_echarts_instance_]').length,
      svgPaths: document.querySelectorAll('svg path').length,
      text: document.body.innerText || '',
    }))()`),
  );
}

/**
 * Render an mviz embed HTML document to a PNG buffer.
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
  return withRenderedPage(html, async (page) => {
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
  });
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
