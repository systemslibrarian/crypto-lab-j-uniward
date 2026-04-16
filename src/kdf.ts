/**
 * kdf.ts — Key derivation for STC steganography
 *
 * PBKDF2-SHA-256 (600,000 iterations) → 32-byte master key
 * HKDF-SHA-256 domain separation → hatKey + permKey (32 bytes each)
 *
 * The passphrase enters the system EXACTLY ONCE — here.
 */

/**
 * HKDF-Expand using HMAC-SHA-256 (RFC 5869 §2.3).
 * WebCrypto lacks a direct HKDF-Expand, so we use deriveBits with HKDF.
 */
async function hkdfExpand(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Import IKM as HKDF key material
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  // Zero-filled salt (IKM is already high-entropy from PBKDF2)
  const salt = new Uint8Array(32);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveSTCKeys(
  passphrase: string,
  salt: Uint8Array, // 16 bytes, caller-generated via crypto.getRandomValues
): Promise<{ hatKey: Uint8Array; permKey: Uint8Array; salt: Uint8Array }> {
  const enc = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  // PBKDF2-SHA-256, 600,000 iterations → 32-byte master key
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    passphraseKey,
    256,
  );
  const masterKey = new Uint8Array(masterBits);

  // HKDF domain-separated subkeys
  const [hatKey, permKey] = await Promise.all([
    hkdfExpand(masterKey, enc.encode('stc-hat-v1'), 32),
    hkdfExpand(masterKey, enc.encode('stc-perm-v1'), 32),
  ]);

  return { hatKey, permKey, salt };
}
