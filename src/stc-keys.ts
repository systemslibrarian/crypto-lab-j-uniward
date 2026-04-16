/**
 * stc-keys.ts — AES-CTR hat matrix and Fisher-Yates keyed permutation
 *
 * Hat matrix columns are rejection-sampled to guarantee non-zero values.
 * Permutation is derived via Fisher-Yates with AES-CTR keystream.
 */

const H     = 12;           // trellis height — 4096 states — DO NOT CHANGE
const STATE = 1 << H;       // 4096
const MASK  = STATE - 1;    // 0xFFF

/**
 * Build the hat matrix (array of w column bitmasks) from an AES-256-CTR keystream.
 * All column values are in [1, 4095] (rejection-sampled, no zero columns).
 */
export async function buildHatMatrix(
  hatKey: Uint8Array,   // 32-byte subkey from kdf.ts
  w: number,            // window width, always > H
): Promise<Uint32Array> {
  if (w <= H) throw new Error(`w=${w} must be > H=${H}`);

  const key = await crypto.subtle.importKey('raw', hatKey, 'AES-CTR', false, ['encrypt']);
  const cols = new Uint32Array(w);
  let collected = 0;
  let counterOffset = 0;

  while (collected < w) {
    const needed = w - collected;
    // Generate enough keystream: each column needs 2 bytes from Uint16Array
    const blockBytes = needed * 4; // overshoot to account for rejection
    const counter = new Uint8Array(16);
    // Big-endian uint32 in bytes 12–15
    const dv = new DataView(counter.buffer);
    dv.setUint32(12, counterOffset, false);

    const zeroBuf = new Uint8Array(blockBytes);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter, length: 32 },
      key,
      zeroBuf,
    );

    const words = new Uint16Array(encrypted);
    for (let i = 0; i < words.length && collected < w; i++) {
      const val = words[i] & MASK;
      if (val === 0) continue; // rejection sampling: discard zero columns
      cols[collected++] = val;
    }
    counterOffset++;
  }

  // Assert all columns non-zero
  if (!cols.every(v => v > 0 && v <= MASK)) {
    throw new Error('Hat matrix contains zero or out-of-range column');
  }

  return cols;
}

/**
 * Derive a deterministic permutation of [0..n) via Fisher-Yates + AES-CTR keystream.
 */
export async function derivePermutation(
  permKey: Uint8Array,  // 32-byte subkey from kdf.ts
  n: number,            // total carrier count
): Promise<Uint32Array> {
  const key = await crypto.subtle.importKey('raw', permKey, 'AES-CTR', false, ['encrypt']);
  const counter = new Uint8Array(16); // counter offset = 0

  const zeroBuf = new Uint8Array(n * 4);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter, length: 32 },
    key,
    zeroBuf,
  );

  const rand32 = new Uint32Array(encrypted);

  // Build identity permutation
  const perm = new Uint32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;

  // Fisher-Yates
  for (let i = n - 1; i > 0; i--) {
    const j = rand32[i] % (i + 1);
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
  }

  return perm;
}
