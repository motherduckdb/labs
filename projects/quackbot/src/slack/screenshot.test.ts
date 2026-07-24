import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { processMvizMarkdown } from '../core/mviz-processor';
import {
  closeBrowser,
  isAllowedResourceUrl,
  probeRenderedChart,
  renderHtmlToPng,
  resolveVendoredAsset,
} from './screenshot';

const BAR_FENCE = [
  '```bar size=[8,8]',
  JSON.stringify({
    type: 'bar',
    title: 'Revenue by Month',
    data: [
      { month: 'Jan', revenue: 120 },
      { month: 'Feb', revenue: 190 },
    ],
    x: 'month',
    y: 'revenue',
  }),
  '```',
].join('\n');

describe('isAllowedResourceUrl', () => {
  it('allows the embed’s font fetches and inline schemes', () => {
    expect(isAllowedResourceUrl('https://fonts.googleapis.com/css2?family=Inter')).toBe(true);
    expect(isAllowedResourceUrl('https://fonts.gstatic.com/s/inter/inter.woff2')).toBe(true);
    expect(isAllowedResourceUrl('data:text/css,body{}')).toBe(true);
    expect(isAllowedResourceUrl('blob:https://x/abc')).toBe(true);
    expect(isAllowedResourceUrl('about:blank')).toBe(true);
  });

  it('denies SSRF / exfiltration targets from attacker-influenced chart content', () => {
    // Cloud metadata endpoint and other link-local / loopback / private hosts.
    expect(isAllowedResourceUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedResourceUrl('http://127.0.0.1:8080/')).toBe(false);
    expect(isAllowedResourceUrl('http://localhost/')).toBe(false);
    expect(isAllowedResourceUrl('http://10.0.0.5/')).toBe(false);
    expect(isAllowedResourceUrl('http://[::1]/')).toBe(false);
    // Arbitrary external exfil host.
    expect(isAllowedResourceUrl('https://evil.example/steal?d=secret')).toBe(false);
    // Local file read.
    expect(isAllowedResourceUrl('file:///etc/passwd')).toBe(false);
    // HTTP downgrade to a font host is still denied (must be HTTPS).
    expect(isAllowedResourceUrl('http://fonts.googleapis.com/css2')).toBe(false);
    // Look-alike host must not slip past the exact-match allowlist.
    expect(isAllowedResourceUrl('https://fonts.googleapis.com.evil.example/x')).toBe(false);
    // Garbage / non-URL input fails closed.
    expect(isAllowedResourceUrl('not a url')).toBe(false);
  });

  it('denies the echarts CDN itself — it is served from disk, never fetched', () => {
    expect(isAllowedResourceUrl('https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js')).toBe(
      false,
    );
  });
});

describe('resolveVendoredAsset', () => {
  it('serves the echarts bundle mviz asks for from a real local file', () => {
    const local = resolveVendoredAsset('https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js');
    expect(local).toBeTruthy();
    expect(existsSync(local as string)).toBe(true);
  });

  it('matches by shape so an mviz echarts version bump keeps rendering', () => {
    expect(resolveVendoredAsset('https://cdn.jsdelivr.net/npm/echarts@5.6.1/dist/echarts.min.js')).toBeTruthy();
    expect(resolveVendoredAsset('https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.js')).toBeTruthy();
  });

  it('refuses to source anything else off disk', () => {
    // Any other jsdelivr path — the URL must never widen which file we read.
    expect(resolveVendoredAsset('https://cdn.jsdelivr.net/npm/evil/x.js')).toBeNull();
    expect(resolveVendoredAsset('https://cdn.jsdelivr.net/npm/echarts@5.5.0/../../../etc/passwd')).toBeNull();
    expect(resolveVendoredAsset('https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js.map')).toBeNull();
    // Other hosts, other schemes, garbage.
    expect(resolveVendoredAsset('https://evil.example/npm/echarts@5.5.0/dist/echarts.min.js')).toBeNull();
    expect(resolveVendoredAsset('file:///etc/passwd')).toBeNull();
    expect(resolveVendoredAsset('not a url')).toBeNull();
  });

  it('covers every external script the real embed HTML requests', () => {
    // The guard that would have caught the empty-chart bug at build time: if
    // mviz starts pulling a script we do not vendor, the render sandbox aborts
    // it and charts come out blank. Fonts are the one allowed network fetch.
    const html = processMvizMarkdown(BAR_FENCE);
    const scriptSrcs = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    expect(scriptSrcs.length).toBeGreaterThan(0);
    for (const src of scriptSrcs) {
      expect(
        resolveVendoredAsset(src) !== null || isAllowedResourceUrl(src),
        `embed requests ${src}, which is neither vendored nor allowlisted — charts will render empty`,
      ).toBe(true);
    }
  });
});

describe('renderHtmlToPng', () => {
  it('renders actual chart marks, not just the tile title', async () => {
    // Regression test for charts arriving in Slack as a title over blank space:
    // mviz's embed loads echarts from a CDN, and the render sandbox denies all
    // egress, so the chart body silently failed with `echarts is not defined`.
    // Asserting on PNG bytes alone would not have caught it — a blank tile is a
    // perfectly valid PNG — so assert on the rendered DOM via a marker page.
    const html = processMvizMarkdown(BAR_FENCE);
    const png = await renderHtmlToPng(html);
    expect(png.length).toBeGreaterThan(0);
    // A drawn echarts chart leaves an <svg> with axis/series geometry in it.
    // renderHtmlToPng returns only pixels, so re-render the same HTML through
    // the same sandbox and inspect the DOM it produced.
    const probe = await probeRenderedChart(html);
    expect(probe.echartsInstances).toBeGreaterThan(0);
    expect(probe.svgPaths).toBeGreaterThan(0);
    // The axis labels and the series values must both have been drawn.
    expect(probe.text).toContain('Jan');
    expect(probe.text).toContain('120');
  }, 60_000);

  afterAll(async () => {
    await closeBrowser();
  });
});
