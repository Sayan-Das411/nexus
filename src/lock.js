// src/lock.js
// Lock screen for Nexus: PIN/password and WebAuthn biometrics (fingerprint / face).
//
// Security model:
//   • The lock screen protects UI access (prevents someone from reading messages
//     off your screen if you leave the device unattended).
//   • The encryption passphrase is stored in IndexedDB once entered; the lock
//     screen does NOT protect the IndexedDB key at the browser level.
//   • WebAuthn biometrics use the platform authenticator (device fingerprint /
//     face sensor) — the credential private key never leaves the device's TPM.
//   • PINs are hashed with PBKDF2-SHA-256 (100,000 iterations) before storage.
//   • Auto-lock fires after a configurable inactivity period.

import { settings, lockStore, biometricStore } from './db.js';
import { hashPIN, generateSalt }               from './crypto.js';

// In-memory lock state (reset on page load — app starts locked)
let _locked         = true;
let _autoLockTimer  = null;
let _autoLockMins   = 5;

// ---- PIN setup & verification -----------------------------------------------

export async function setupPIN(uid, pin) {
  const salt   = generateSalt();
  const hashed = await hashPIN(String(pin), salt);
  const cur    = (await lockStore.get(uid)) ?? {};

  await lockStore.set(uid, {
    ...cur,
    pinHash:         hashed,
    pinSalt:         salt,
    lockEnabled:     true,
    autoLockMinutes: cur.autoLockMinutes ?? 5,
  });
}

export async function verifyPIN(uid, pin) {
  const data = await lockStore.get(uid);
  if (!data?.pinHash) return false;
  const hashed = await hashPIN(String(pin), data.pinSalt);
  return hashed === data.pinHash;
}

export async function isLockSetUp(uid) {
  const data = await lockStore.get(uid);
  return !!(data?.pinHash);
}

export async function getLockSettings(uid) {
  return lockStore.get(uid) ?? {};
}

export async function setAutoLockMinutes(uid, mins) {
  const cur = (await lockStore.get(uid)) ?? {};
  await lockStore.set(uid, { ...cur, autoLockMinutes: mins });
  _autoLockMins = mins;
}

export async function loadAutoLockSetting(uid) {
  const data    = await lockStore.get(uid);
  _autoLockMins = data?.autoLockMinutes ?? 5;
  return _autoLockMins;
}

// ---- WebAuthn biometrics ----------------------------------------------------

// Returns true if this device has a platform authenticator (fingerprint / face)
export async function biometricsAvailable() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// Register a biometric credential tied to this app origin and user.
// The credential's private key is stored in the device's secure enclave / TPM.
export async function setupBiometrics(uid, email) {
  if (!await biometricsAvailable()) throw new Error('No platform authenticator available');

  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: 'Nexus',
        id:   location.hostname,
      },
      user: {
        id:          new TextEncoder().encode(uid),
        name:        email,
        displayName: 'Nexus',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7   }, // ES256 (ECDSA P-256)
        { type: 'public-key', alg: -257 }, // RS256 (RSA-PKCS1)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification:        'required',
        residentKey:             'preferred',
      },
      timeout: 60000,
    },
  });

  // Store only the credential ID (not the private key — that stays on device)
  const credId = Array.from(new Uint8Array(credential.rawId))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  await biometricStore.set(uid, credId);

  // Mark biometrics as enabled in lock settings
  const cur = (await lockStore.get(uid)) ?? {};
  await lockStore.set(uid, { ...cur, biometricsEnabled: true });

  return credId;
}

// Prompt for biometric authentication. Returns true on success.
export async function authenticateBiometrics(uid) {
  if (!await biometricsAvailable()) return false;

  const stored = await biometricStore.get(uid);
  if (!stored?.credentialId) return false;

  const challenge   = crypto.getRandomValues(new Uint8Array(32));
  const credIdBytes = stored.credentialId.match(/.{2}/g)
    .map(h => parseInt(h, 16));

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: location.hostname,
        allowCredentials: [{
          id:   new Uint8Array(credIdBytes),
          type: 'public-key',
        }],
        userVerification: 'required',
        timeout:          60000,
      },
    });
    return !!assertion;
  } catch (err) {
    // User cancelled or authenticator failed — not an error we throw
    console.log('[lock] Biometric auth result:', err?.name);
    return false;
  }
}

export async function isBiometricsEnabled(uid) {
  const data = await lockStore.get(uid);
  return !!(data?.biometricsEnabled);
}

export async function disableBiometrics(uid) {
  await biometricStore.delete(uid);
  const cur = (await lockStore.get(uid)) ?? {};
  await lockStore.set(uid, { ...cur, biometricsEnabled: false });
}

// ---- Lock state -------------------------------------------------------------

export function isLocked() { return _locked; }

export function lock() {
  _locked = true;
  clearAutoLockTimer();
  document.dispatchEvent(new CustomEvent('nexus:locked'));
}

export function unlock() {
  _locked = false;
  resetAutoLockTimer();
  document.dispatchEvent(new CustomEvent('nexus:unlocked'));
}

// ---- Auto-lock timer --------------------------------------------------------

export function startAutoLockTimer() {
  clearAutoLockTimer();
  if (_autoLockMins <= 0) return;
  _autoLockTimer = setTimeout(lock, _autoLockMins * 60 * 1000);
}

export function resetAutoLockTimer() {
  if (!_locked) {
    clearAutoLockTimer();
    startAutoLockTimer();
  }
}

export function clearAutoLockTimer() {
  if (_autoLockTimer) {
    clearTimeout(_autoLockTimer);
    _autoLockTimer = null;
  }
}

// Listen for visibility changes and lock when app is hidden past the threshold
export function setupVisibilityLock() {
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      await settings.set('last_hidden_at', Date.now());
    } else {
      if (_locked) return; // Already locked, nothing to do
      if (_autoLockMins <= 0) return;

      const lastHidden = await settings.get('last_hidden_at');
      if (!lastHidden) return;
      const elapsedMins = (Date.now() - lastHidden) / 60000;
      if (elapsedMins >= _autoLockMins) lock();
    }
  });

  // Also reset timer on user activity
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => {
    document.addEventListener(ev, resetAutoLockTimer, { passive: true });
  });
}
