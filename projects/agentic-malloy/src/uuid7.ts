/**
 * Generate a UUIDv7 (time-sortable) string. Copied from data-chat-mini.
 * 48-bit timestamp in high bytes, version 7, random fill.
 */
export function uuid7(): string {
  const now = Date.now();
  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);

  const b = new Uint8Array(16);
  b[0] = (now / 0x10000000000) & 0xff;
  b[1] = (now / 0x100000000) & 0xff;
  b[2] = (now / 0x1000000) & 0xff;
  b[3] = (now / 0x10000) & 0xff;
  b[4] = (now / 0x100) & 0xff;
  b[5] = now & 0xff;
  b[6] = 0x70 | (randBytes[0] & 0x0f);
  b[7] = randBytes[1];
  b[8] = 0x80 | (randBytes[2] & 0x3f);
  for (let i = 3; i < 10; i++) b[6 + i] = randBytes[i];

  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
