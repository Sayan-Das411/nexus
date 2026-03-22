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

// ---- Sign In ----------------------------------------------------------------

// Open Google sign-in popup.
// Requests drive.appdata scope so Phase 2 can access Drive immediately.
// Returns { user, isNewAccount, deviceId }
export async function signInWithGoogle() {
  if (!_auth) throw new Error('Firebase not initialized');

  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive.appdata');
  // Also request a broad drive scope for Phase 2 Spine (user can grant later)
  provider.addScope('https://www.googleapis.com/auth/drive.file');

  const result = await signInWithPopup(_auth, provider);
  const user   = result.user;

  // Ensure this installation has a stable device ID
  let deviceId = await settings.get('device_id');
  if (!deviceId) {
    deviceId = generateDeviceId();
    await settings.set('device_id', deviceId);
  }

  const existing     = await accountStore.get(user.uid);
  const isNewAccount = !existing;

  await accountStore.set({
    uid:              user.uid,
    email:            user.email,
    displayName:      user.displayName,
    photoURL:         user.photoURL,
    deviceId,
    deviceName:       existing?.deviceName  ?? getDefaultDeviceName(),
    platform:         existing?.platform    ?? detectPlatform(),
    addedAt:          existing?.addedAt     ?? Date.now(),
    lastSignedIn:     Date.now(),
    isCurrentAccount: true,
    // Phase 2: spineAccounts will be added here
  });

  // Mark all other local accounts as not current
  const all = await accountStore.all();
  for (const a of all) {
    if (a.uid !== user.uid && a.isCurrentAccount) {
      await accountStore.set({ ...a, isCurrentAccount: false });
    }
  }

  await settings.set('current_uid', user.uid);
  return { user, isNewAccount, deviceId };
}

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
