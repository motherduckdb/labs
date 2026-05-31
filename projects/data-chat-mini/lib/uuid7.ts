/**
 * Generate a UUIDv7 (time-sortable) string.
 * 48-bit timestamp in high bytes, version 7, random fill.
 * Avoids BigInt for ES2017 compatibility.
 */
export function uuid7(): string {
  const now = Date.now();
  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);

  const b = new Uint8Array(16);

  // Bytes 0-5: 48-bit timestamp (big-endian)
  // JS Date.now() fits in 48 bits until year 10889
  b[0] = (now / 0x10000000000) & 0xFF;
  b[1] = (now / 0x100000000) & 0xFF;
  b[2] = (now / 0x1000000) & 0xFF;
  b[3] = (now / 0x10000) & 0xFF;
  b[4] = (now / 0x100) & 0xFF;
  b[5] = now & 0xFF;

  // Byte 6: version 7 (0x7_) | high 4 bits of rand_a
  b[6] = 0x70 | (randBytes[0] & 0x0F);
  // Byte 7: low 8 bits of rand_a
  b[7] = randBytes[1];

  // Byte 8: variant 10 (0x80) | 6 bits of random
  b[8] = 0x80 | (randBytes[2] & 0x3F);

  // Bytes 9-15: remaining random
  for (let i = 3; i < 10; i++) {
    b[6 + i] = randBytes[i];
  }

  // Format as UUID string
  const hex = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
