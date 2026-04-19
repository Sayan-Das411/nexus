// src/auth.js
// Firebase Authentication and multi-account management.
//
// Nexus supports multiple independent Google accounts. Each account has its
// own encryption key, lock settings, message history, and (in Phase 2)
// its own Spine Drive configuration. Switching accounts re-authenticates
// with Firebase and loads the correct per-account state.

import { initializeApp, getApps, getApp }       from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider,
         onAuthStateChanged, signOut as fbSignOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

import { settings, accountStore } from './db.js';
import { storeDriveToken } from './drive.js';
import { generateDeviceId }        from './crypto.js';

let _app  = null;
let _auth = null;

// ---- Firebase init ----------------------------------------------------------

// Initialize Firebase with the user-provided config object.
// Safe to call multiple times — reuses existing app if already initialized.
export async function initFirebase(config) {
  if (_app) return _app;

  const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId'];
  for (const f of required) {
    if (!config[f]) throw new Error(`Firebase config missing field: "${f}"`);
  }

  _app  = getApps().length ? getApp() : initializeApp(config);
  _auth = getAuth(_app);
  return _app;
}

export const getFirebaseApp  = () => _app;
export const getFirebaseAuth = () => _auth;

// ---- Sign Out ---------------------------------------------------------------

export async function signOut() {
  if (!_auth) return;
  const uid = await settings.get('current_uid');
  if (uid) {
    const acc = await accountStore.get(uid);
    if (acc) await accountStore.set({ ...acc, isCurrentAccount: false });
  }
  await settings.delete('current_uid');
  await fbSignOut(_auth);
}

// ---- Account management -----------------------------------------------------

export async function getCurrentAccount() {
  const uid = await settings.get('current_uid');
  return uid ? accountStore.get(uid) : null;
}

export async function listAccounts() {
  return accountStore.all();
}

// Switch the active Nexus account.
// Firebase only holds one auth session at a time; switching requires
// a Google popup (which is instant if the browser has a cached session).
export async function switchToAccount(uid) {
  const account = await accountStore.get(uid);
  if (!account) throw new Error('Account not found in local storage');

  await fbSignOut(_auth);

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ login_hint: account.email });
  provider.addScope('https://www.googleapis.com/auth/drive.appdata');
  provider.addScope('https://www.googleapis.com/auth/drive.file');

  const result = await signInWithPopup(_auth, provider);
  // Extract and store OAuth token for this account's Drive access
  const credential2 = GoogleAuthProvider.credentialFromResult(result);
  if (credential2?.accessToken) {
    storeDriveToken(uid, credential2.accessToken, 3600);
  }
  if (result.user.uid !== uid) {
    // User picked the wrong Google account in the popup
    await fbSignOut(_auth);
    throw new Error(`Wrong account. Please sign in as ${account.email}`);
  }

  await accountStore.set({ ...account, isCurrentAccount: true, lastSignedIn: Date.now() });

  // Mark all others as not current
  const all = await accountStore.all();
  for (const a of all) {
    if (a.uid !== uid && a.isCurrentAccount) {
      await accountStore.set({ ...a, isCurrentAccount: false });
    }
  }

  await settings.set('current_uid', uid);
  return account;
}

// Remove an account from local storage. Clears keys, lock data, and cache.
// Does NOT delete Firebase data — that lives on Google's servers.
export async function removeLocalAccount(uid) {
  await accountStore.delete(uid);

  const current = await settings.get('current_uid');
  if (current === uid) {
    await settings.delete('current_uid');
    if (_auth) await fbSignOut(_auth);
  }
}

// Update the device name for the current account
export async function updateDeviceName(name) {
  const uid = await settings.get('current_uid');
  if (!uid) return;
  const acc = await accountStore.get(uid);
  if (acc) await accountStore.set({ ...acc, deviceName: name });
}

// Listen for Firebase auth state changes
export function onAuthChange(cb) {
  if (!_auth) return () => {};
  return onAuthStateChanged(_auth, cb);
}

// ---- Device / platform detection --------------------------------------------

// ---- Browser detection ------------------------------------------------------
export function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//i.test(ua))                          return 'edge';
  if (/OPR\/|Opera/i.test(ua))                    return 'opera';
  if (/Samsung/i.test(ua))                        return 'samsung';
  if (/Firefox/i.test(ua))                        return 'firefox';
  if (/Chrome/i.test(ua))                         return 'chrome';
  if (/Safari/i.test(ua))                         return 'safari';
  return 'browser';
}

export function browserLabel(b) {
  const m = { edge: 'Edge', opera: 'Opera', samsung: 'Samsung Internet',
              firefox: 'Firefox', chrome: 'Chrome', safari: 'Safari',
              browser: 'Browser' };
  return m[b] ?? 'Browser';
}

// ---- OPFS persistence helpers -----------------------------------------------
// Origin Private File System survives "Clear site data" in DevTools and most
// browser cache-clear operations, unlike IndexedDB or localStorage.
// Only a full reinstall / manual OPFS clear removes these files.
async function opfsReadId(filename) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh   = await root.getFileHandle(filename);
    const file  = await fh.getFile();
    return (await file.text()).trim() || null;
  } catch { return null; }
}

async function opfsWriteId(filename, value) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh   = await root.getFileHandle(filename, { create: true });
    const w    = await fh.createWritable();
    await w.write(value);
    await w.close();
  } catch {}
}

// ---- Sign In ----------------------------------------------------------------

export async function signInWithGoogle() {
  if (!_auth) throw new Error('Firebase not initialized');

  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive.appdata');
  provider.addScope('https://www.googleapis.com/auth/drive.file');

  const result     = await signInWithPopup(_auth, provider);
  const user       = result.user;
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (credential?.accessToken) storeDriveToken(user.uid, credential.accessToken, 3600);

  const platform = detectPlatform();
  const browser  = detectBrowser();

  // ---- Stable device identity ------------------------------------------------
  // Identity = (Google UID) × (device) × (browser profile).
  // Storage hierarchy (most → least durable):
  //   1. OPFS file     — survives cache/IDB clears, lost on uninstall
  //   2. IndexedDB     — primary runtime store
  //   3. localStorage  — survives IDB-only clears
  //   4. Firebase match — last resort: match by platform+browser
  //   5. Generate new  — truly first-ever login on this browser profile

  const OPFS_FILE = `nexus_device_${user.uid}.txt`;
  const IDB_KEY   = `device_id:${user.uid}`;
  const LS_KEY    = `nexus_device_id_${user.uid}`;

  let deviceId = await opfsReadId(OPFS_FILE)
              || await settings.get(IDB_KEY)
              || (() => { try { return localStorage.getItem(LS_KEY) || localStorage.getItem('nexus_device_id') || null; } catch { return null; } })();

  if (!deviceId) {
    // Firebase match: platform + browser must BOTH match for this to count.
    // (Previously only platform matched, causing PC Chrome and PC Firefox to
    // collide after a cache clear.)
    try {
      const { getDatabase, ref, get } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
      const snap = await get(ref(getDatabase(_app), `accounts/${user.uid}/devices`));
      if (snap.exists()) {
        let exactMatch = null;
        snap.forEach(child => {
          const d = child.val();
          if (d.platform === platform && d.browser === browser) exactMatch = child.key;
        });
        if (exactMatch) deviceId = exactMatch;
      }
    } catch {}
  }

  if (!deviceId) deviceId = generateDeviceId();

  // Write back to all persistence layers
  await opfsWriteId(OPFS_FILE, deviceId);
  await settings.set(IDB_KEY, deviceId);
  try { localStorage.setItem(LS_KEY, deviceId); } catch {}

  const existing = await accountStore.get(user.uid);
  await accountStore.set({
    uid:              user.uid,
    email:            user.email,
    displayName:      user.displayName,
    photoURL:         user.photoURL,
    deviceId,
    deviceName:       existing?.deviceName ?? getDefaultDeviceName(),
    platform,
    browser,
    addedAt:          existing?.addedAt ?? Date.now(),
    lastSignedIn:     Date.now(),
    isCurrentAccount: true,
  });

  const all = await accountStore.all();
  for (const a of all) {
    if (a.uid !== user.uid && a.isCurrentAccount) {
      await accountStore.set({ ...a, isCurrentAccount: false });
    }
  }

  await settings.set('current_uid', user.uid);
  return { user, deviceId };
}

export function getDefaultDeviceName() {
  const ua = navigator.userAgent;
  if (/SM-A356|SM-A35|Galaxy A35/i.test(ua)) return 'Galaxy A35';
  if (/Samsung/i.test(ua))                     return 'Samsung Phone';
  if (/Android/i.test(ua))                     return 'Android Phone';
  if (/iPhone/i.test(ua))                      return 'iPhone';
  if (/iPad/i.test(ua))                         return 'iPad';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'Linux PC';
  if (/Windows/i.test(ua))                     return 'Windows PC';
  if (/Macintosh/i.test(ua))                   return 'Mac';
  return 'My Device';
}

export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua))                       return 'android';
  if (/iPhone|iPad/i.test(ua))                   return 'ios';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  if (/Windows/i.test(ua))                       return 'windows';
  if (/Macintosh/i.test(ua))                     return 'mac';
  return 'unknown';
}

// Platform icon (emoji fallback — Phase 3 will use SVG icons)
export function platformIcon(platform) {
  const icons = {
    android: '📱', ios: '📱', windows: '🖥️',
    linux: '🖥️', mac: '💻', unknown: '💬',
  };
  return icons[platform] ?? '💬';
}
