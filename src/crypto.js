// src/crypto.js
// End-to-end encryption for Nexus.
//
// All message content is encrypted on-device before being written to Firebase.
// Firebase only ever stores ciphertext — it cannot read your messages.
//
// Algorithm: AES-256-GCM (authenticated encryption, tamper-proof)
// Key derivation: PBKDF2-SHA-256, 310,000 iterations (OWASP 2023 recommendation)
// Key storage: non-extractable CryptoKey in IndexedDB (cannot be read by JS)
// PIN hashing: PBKDF2-SHA-256, 100,000 iterations, per-account salt

const PBKDF2_ITERATIONS = 310_000;
const PIN_ITERATIONS    = 100_000;
const AES_KEY_BITS      = 256;
const SALT_BYTES        = 32;
const IV_BYTES          = 12; // 96-bit IV for AES-GCM (NIST recommended)

// ---- Encoding helpers -------------------------------------------------------

// Stack-safe base64 encoder. The naive btoa(String.fromCharCode(...bytes))
// approach crashes with "Maximum call stack size exceeded" for buffers larger
// than ~64 KB because spreading a large typed array overflows function argument
// limits. This chunked version handles buffers of any size.
function buf2b64(buf) {
  const bytes = new Uint8Array(buf);
  let binary  = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b642buf(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function buf2hex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---- Random generators ------------------------------------------------------

// Returns a random base64-encoded salt string
export function generateSalt() {
  const bytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(bytes);
  return buf2b64(bytes);
}

// Returns a random hex device ID (128-bit / 32 hex chars)
export function generateDeviceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return buf2hex(bytes);
}

// ---- Key derivation ---------------------------------------------------------

// Derive an AES-256-GCM CryptoKey from a passphrase and base64 salt.
// The returned key is NON-EXTRACTABLE — it can be used for encrypt/decrypt
// and stored in IndexedDB, but the raw bytes can never be read by JavaScript.
// This is the most secure client-side key storage approach available in browsers.
export async function deriveKey(passphrase, saltBase64) {
  const enc     = new TextEncoder();
  const rawPass = enc.encode(passphrase);
  const saltBuf = b642buf(saltBase64);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', rawPass, 'PBKDF2', false, ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name:       'PBKDF2',
      salt:       saltBuf,
      iterations: PBKDF2_ITERATIONS,
      hash:       'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,           // NOT extractable
    ['encrypt', 'decrypt']
  );
}

// ---- Encryption / Decryption ------------------------------------------------

// Encrypt a plaintext string.
// Returns { ciphertext: string (base64), iv: string (base64) }
export async function encrypt(key, plaintext) {
  const iv   = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv); // Fresh random IV for every message

  const encoded   = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    ciphertext: buf2b64(encrypted),
    iv:         buf2b64(iv),
  };
}

// Decrypt a ciphertext produced by encrypt().
// Throws DOMException if decryption fails (wrong key, tampered data).
export async function decrypt(key, ciphertextB64, ivB64) {
  const cipherBuf = b642buf(ciphertextB64);
  const ivBuf     = b642buf(ivB64);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf }, key, cipherBuf
  );

  return new TextDecoder().decode(plainBuf);
}

// ---- Key verification -------------------------------------------------------
// On first device: generate a known vector encrypted with the key.
// On subsequent devices: verify the entered passphrase produces the same key
// by attempting to decrypt the known vector.

const VERIFY_PLAINTEXT = 'nexus-e2e-key-verification-v1';

export async function createVerificationVector(key) {
  return encrypt(key, VERIFY_PLAINTEXT);
}

// Returns true if the key successfully decrypts the stored verification vector.
export async function verifyKey(key, vector) {
  try {
    const result = await decrypt(key, vector.ciphertext, vector.iv);
    return result === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

// ---- PIN hashing ------------------------------------------------------------
// Hash a PIN using PBKDF2 before storing. Uses a per-account salt so that
// the same PIN produces different hashes across accounts.

export async function hashPIN(pin, saltBase64) {
  const enc    = new TextEncoder();
  const pinBuf = enc.encode(String(pin));
  const salt   = b642buf(saltBase64);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', pinBuf, 'PBKDF2', false, ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  return buf2hex(bits);
}

// ---- Passphrase strength (0–4) ----------------------------------------------
export function passphraseStrength(p) {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8)                              s++;
  if (p.length >= 16)                             s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p))        s++;
  if (/[0-9]/.test(p))                            s++;
  if (/[^A-Za-z0-9]/.test(p))                     s++;
  return Math.min(s, 4);
}
