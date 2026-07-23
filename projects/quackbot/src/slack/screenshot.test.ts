import { describe, expect, it } from 'vitest';
import { isAllowedResourceUrl } from './screenshot';

describe('isAllowedResourceUrl', () => {
  it('allows the self-contained embed’s font fetches and inline schemes', () => {
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
});
