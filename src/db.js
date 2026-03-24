// src/db.js
// IndexedDB wrapper for Nexus local storage.
// All persistent local data lives here: settings, accounts, encryption keys,
// message cache, offline send queue, drafts, biometrics, lock data.
//
// Schema is designed to support Phase 2 (Spine Link multi-Drive accounts)
// without needing a migration — the spineAccounts field in account records
// will be populated in Phase 2.

const DB_NAME    = 'nexus-local';
const DB_VERSION = 1;

let _db = null;

// Open (or reuse) the database connection
export async function initDB() {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = ev => {
      const db = ev.target.result;

      // ---- settings ----
      // Generic key-value store: firebase config, current theme, misc flags
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      // ---- accounts ----
      // One record per signed-in Google account
      // Fields: uid, email, displayName, photoURL, deviceId, deviceName,
      //         platform, addedAt, lastSignedIn, isCurrentAccount,
      //         spineAccounts (populated in Phase 2)
      if (!db.objectStoreNames.contains('accounts')) {
        const s = db.createObjectStore('accounts', { keyPath: 'uid' });
        s.createIndex('email', 'email', { unique: true });
      }

      // ---- keys ----
      // Stores derived AES-GCM CryptoKey per account (non-extractable)
      // Fields: uid, key (CryptoKey), salt (base64), verificationVector (JSON)
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys', { keyPath: 'uid' });
      }

      // ---- messages ----
      // Cached message records for offline reading
      // Fields: id (Firebase key), uid (account), ...message fields
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('uid',    'uid',       { unique: false });
        s.createIndex('uid_ts', ['uid', 'timestamp'], { unique: false });
      }

      // ---- queue ----
      // Offline send queue — messages to be sent when connectivity returns
      // Fields: id (autoIncrement), uid, payload (encrypted message data), addedAt
      if (!db.objectStoreNames.contains('queue')) {
        const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        s.createIndex('uid', 'uid', { unique: false });
      }

      // ---- drafts ----
      // One draft text per account
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'uid' });
      }

      // ---- biometrics ----
      // WebAuthn credential IDs per account
      if (!db.objectStoreNames.contains('biometrics')) {
        db.createObjectStore('biometrics', { keyPath: 'uid' });
      }

      // ---- lock ----
      // PIN hash, salt, and lock settings per account
      if (!db.objectStoreNames.contains('lock')) {
        db.createObjectStore('lock', { keyPath: 'uid' });
      }
    };

    req.onsuccess = ev => { _db = ev.target.result; resolve(_db); };
    req.onerror   = ev => reject(ev.target.error);
  });
}

// ---- Generic helpers --------------------------------------------------------

export async function dbGet(store, key) {
  const db  = await initDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

export async function dbPut(store, value) {
  const db  = await initDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

export async function dbDelete(store, key) {
  const db  = await initDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

export async function dbGetAll(store) {
  const db  = await initDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

export async function dbGetAllByIndex(store, indexName, value) {
  const db  = await initDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction(store, 'readonly');
    const index = tx.objectStore(store).index(indexName);
    const req   = index.getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

// ---- Namespaced accessors ---------------------------------------------------
// These provide a clean API over the raw IDB helpers.

export const settings = {
  get:    key         => dbGet('settings', key).then(r => r?.value ?? null),
  set:    (key, val)  => dbPut('settings', { id: key, value: val }),
  delete: key         => dbDelete('settings', key),
};

export const accountStore = {
  get:    uid     => dbGet('accounts', uid),
  set:    account => dbPut('accounts', account),
  delete: uid     => dbDelete('accounts', uid),
  all:    ()      => dbGetAll('accounts'),
};

export const keyStore = {
  get:             uid => dbGet('keys', uid),
  set: (uid, key, salt, verificationVector) =>
    dbPut('keys', { uid, key, salt, verificationVector }),
  delete: uid => dbDelete('keys', uid),
};

export const messageCache = {
  put:          (uid, msg)  => dbPut('messages', { ...msg, uid }),
  byAccount:    uid         => dbGetAllByIndex('messages', 'uid', uid),
  deleteMsg:    id          => dbDelete('messages', id),
  clearAccount: async uid   => {
    const msgs = await dbGetAllByIndex('messages', 'uid', uid);
    await Promise.all(msgs.map(m => dbDelete('messages', m.id)));
  },
};

export const queue = {
  add:          (uid, payload) => dbPut('queue', { uid, payload, addedAt: Date.now() }),
  byAccount:    uid            => dbGetAllByIndex('queue', 'uid', uid),
  remove:       id             => dbDelete('queue', id),
  all:          ()             => dbGetAll('queue'),
};

export const drafts = {
  get:    uid        => dbGet('drafts', uid).then(r => r?.text ?? ''),
  set:    (uid, txt) => dbPut('drafts', { uid, text: txt }),
  delete: uid        => dbDelete('drafts', uid),
};

export const biometricStore = {
  get:    uid  => dbGet('biometrics', uid),
  set:    (uid, credentialId) => dbPut('biometrics', { uid, credentialId }),
  delete: uid  => dbDelete('biometrics', uid),
};

export const lockStore = {
  get:    uid  => dbGet('lock', uid),
  set:    (uid, data) => dbPut('lock', { uid, ...data }),
  delete: uid  => dbDelete('lock', uid),
};
