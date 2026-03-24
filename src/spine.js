// src/spine.js
// Spine Link — multi-Drive account pooling for Nexus media storage.

import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs
} from 'firebase/firestore';
import { getFirebaseApp } from './auth.js';
import firebaseConfig from '../firebase-applet-config.json';
import {
  getDriveQuota, ensureFolder, uploadFile, downloadFile,
  checkFileStatus, restoreFile, restoreFolderIfTrashed,
  listNexusFiles, deleteFile,
  getDriveToken, hasDriveToken,
  DriveAuthError, DriveQuotaError, DriveFileNotFoundError,
} from './drive.js';
import { encrypt, decrypt } from './crypto.js';
import { handleFirestoreError, OperationType } from './realtime.js';

let _db = null;
function db() {
  if (!_db) {
    const app = getFirebaseApp();
    _db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
  return _db;
}

// ---- Firebase path helpers --------------------------------------------------
const P = {
  spineConfig:   uid       => `accounts/${uid}/spineConfig/main`,
  manifest:      uid       => `accounts/${uid}/mediaManifest`,
  manifestEntry: (uid, id) => `accounts/${uid}/mediaManifest/${id}`,
};

// ---- Spine config CRUD ------------------------------------------------------

export async function getSpineConfig(uid) {
  const path = P.spineConfig(uid);
  try {
    const snap = await getDoc(doc(db(), path));
    if (!snap.exists()) return { accounts: [] };
    return { accounts: snap.data().accounts ?? [] };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveSpineConfig(uid, config) {
  const path = P.spineConfig(uid);
  try {
    await setDoc(doc(db(), path), config);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// Add a Drive account to the Spine
export async function addSpineAccount(uid, driveUid, email, capBytes) {
  const config = await getSpineConfig(uid);
  const existing = config.accounts.find(a => a.driveUid === driveUid);
  if (existing) throw new Error(`Drive account ${email} is already in your Spine`);

  config.accounts.push({
    driveUid,
    email,
    cap:        capBytes,
    nexusUsed:  0,
    folderId:   null, // will be set on first upload
    addedAt:    Date.now(),
    order:      config.accounts.length,
  });

  await saveSpineConfig(uid, config);
  return config;
}

// Remove a Drive account from the Spine
export async function removeSpineAccount(uid, driveUid) {
  const config = await getSpineConfig(uid);
  config.accounts = config.accounts.filter(a => a.driveUid !== driveUid);
  // Re-number order
  config.accounts.forEach((a, i) => { a.order = i; });
  await saveSpineConfig(uid, config);
  return config;
}

// Update a Drive account's cap
export async function updateSpineCap(uid, driveUid, newCapBytes) {
  const config = await getSpineConfig(uid);
  const acc = config.accounts.find(a => a.driveUid === driveUid);
  if (!acc) throw new Error('Spine account not found');
  acc.cap = newCapBytes;
  await saveSpineConfig(uid, config);
}

// Reorder Spine accounts (drag-reorder in settings)
export async function reorderSpine(uid, orderedDriveUids) {
  const config = await getSpineConfig(uid);
  const map = Object.fromEntries(config.accounts.map(a => [a.driveUid, a]));
  config.accounts = orderedDriveUids.map((id, i) => ({ ...map[id], order: i }));
  await saveSpineConfig(uid, config);
}

// ---- Available space calculation --------------------------------------------
export async function getAvailableSpace(uid, driveAcc) {
  const capHeadroom = Math.max(0, driveAcc.cap - (driveAcc.nexusUsed ?? 0));
  try {
    const quota = await getDriveQuota(driveAcc.driveUid);
    return Math.min(capHeadroom, quota.free);
  } catch {
    return capHeadroom;
  }
}

// ---- Route: pick best Drive account for an upload --------------------------
export async function routeUpload(uid, fileSizeBytes) {
  const config = await getSpineConfig(uid);
  const sorted = [...config.accounts].sort((a, b) => a.order - b.order);

  for (const acc of sorted) {
    if (!hasDriveToken(acc.driveUid)) continue;
    const avail = await getAvailableSpace(uid, acc);
    if (avail >= fileSizeBytes) return acc;
  }

  throw new Error('No Spine account has enough space. Add a Drive account or increase a cap.');
}

// ---- Manifest CRUD ----------------------------------------------------------

export async function addManifestEntry(uid, uuid, entry) {
  const path = P.manifestEntry(uid, uuid);
  try {
    await setDoc(doc(db(), path), {
      ...entry,
      addedAt: Date.now(),
      status: 'live',
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function getManifestEntry(uid, uuid) {
  const path = P.manifestEntry(uid, uuid);
  try {
    const snap = await getDoc(doc(db(), path));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function updateManifestStatus(uid, uuid, status) {
  const path = P.manifestEntry(uid, uuid);
  try {
    await updateDoc(doc(db(), path), { status });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function removeManifestEntry(uid, uuid) {
  const path = P.manifestEntry(uid, uuid);
  try {
    await deleteDoc(doc(db(), path));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function getFullManifest(uid) {
  const path = P.manifest(uid);
  try {
    const querySnap = await getDocs(collection(db(), path));
    const out = {};
    querySnap.forEach(doc => { out[doc.id] = doc.data(); });
    return out;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// ---- Update nexusUsed after upload -----------------------------------------
async function incrementNexusUsed(uid, driveUid, bytes) {
  const config = await getSpineConfig(uid);
  const acc = config.accounts.find(a => a.driveUid === driveUid);
  if (acc) {
    acc.nexusUsed = (acc.nexusUsed ?? 0) + bytes;
    await saveSpineConfig(uid, config);
  }
}

async function decrementNexusUsed(uid, driveUid, bytes) {
  const config = await getSpineConfig(uid);
  const acc = config.accounts.find(a => a.driveUid === driveUid);
  if (acc) {
    acc.nexusUsed = Math.max(0, (acc.nexusUsed ?? 0) - bytes);
    await saveSpineConfig(uid, config);
  }
}

// ---- Upload media -----------------------------------------------------------
export async function uploadMedia(uid, encKey, file, onProgress) {
  const uuid = crypto.randomUUID();
  const arrayBuf  = await file.arrayBuffer();
  const plainBlob = new Uint8Array(arrayBuf);

  let b64 = '';
  const CHUNK = 8192;
  for (let i = 0; i < plainBlob.length; i += CHUNK) {
    b64 += String.fromCharCode(...plainBlob.subarray(i, i + CHUNK));
  }
  b64 = btoa(b64);
  const { ciphertext, iv } = await encrypt(encKey, b64);
  const encPayload = JSON.stringify({ ciphertext, iv });
  const encBlob    = new Blob([encPayload], { type: 'application/octet-stream' });

  const acc = await routeUpload(uid, encBlob.size);

  if (!acc.folderId) {
    acc.folderId = await ensureFolder(acc.driveUid, uid);
    const config = await getSpineConfig(uid);
    const a = config.accounts.find(x => x.driveUid === acc.driveUid);
    if (a) { a.folderId = acc.folderId; await saveSpineConfig(uid, config); }
  }

  const driveFileId = await uploadFile(acc.driveUid, acc.folderId, uuid, encBlob, onProgress);

  await addManifestEntry(uid, uuid, {
    driveUid:    acc.driveUid,
    driveFileId,
    folderId:    acc.folderId,
    size:        encBlob.size,
    originalSize:file.size,
    mimeType:    file.type,
    fileName:    file.name,
  });

  await incrementNexusUsed(uid, acc.driveUid, encBlob.size);

  return { uuid, driveUid: acc.driveUid, driveFileId };
}

// ---- Download media ---------------------------------------------------------
export async function downloadMedia(uid, encKey, uuid) {
  const entry = await getManifestEntry(uid, uuid);
  if (!entry) throw new Error('Media not found in manifest');

  if (hasDriveToken(entry.driveUid)) {
    try {
      const status = await checkFileStatus(entry.driveUid, entry.driveFileId);
      if (status === 'trashed') {
        await restoreFile(entry.driveUid, entry.driveFileId);
      } else if (status === 'missing') {
        await updateManifestStatus(uid, uuid, 'missing');
        throw new Error('File was permanently deleted from Drive');
      }
    } catch (err) {
      if (!(err instanceof DriveAuthError)) throw err;
    }
  }

  const buf      = await downloadFile(entry.driveUid, entry.driveFileId);
  const text     = new TextDecoder().decode(buf);
  const { ciphertext, iv } = JSON.parse(text);
  const b64      = await decrypt(encKey, ciphertext, iv);
  const bytes    = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  return new Blob([bytes], { type: entry.mimeType ?? 'application/octet-stream' });
}

// ---- Delete media -----------------------------------------------------------
export async function deleteMedia(uid, uuid) {
  const entry = await getManifestEntry(uid, uuid);
  if (!entry) return;

  if (hasDriveToken(entry.driveUid)) {
    try {
      await deleteFile(entry.driveUid, entry.driveFileId);
    } catch (e) { /* ignore */ }
  }

  await decrementNexusUsed(uid, entry.driveUid, entry.size ?? 0);
  await removeManifestEntry(uid, uuid);
}

// ---- Folder recovery --------------------------------------------------------
export async function checkAndRestoreFolders(uid) {
  const config = await getSpineConfig(uid);
  for (const acc of config.accounts) {
    if (!hasDriveToken(acc.driveUid)) continue;
    try {
      const restored = await restoreFolderIfTrashed(acc.driveUid, uid);
      if (restored) console.log(`[spine] Restored trashed folder for ${acc.email}`);
    } catch (e) { /* ignore */ }
  }
}

// ---- Re-link orphan scan ----------------------------------------------------
export async function scanRelinkedAccount(uid, driveUid) {
  const config = await getSpineConfig(uid);
  const acc    = config.accounts.find(a => a.driveUid === driveUid);
  if (!acc) throw new Error('Account not in Spine');

  const folderId = acc.folderId ?? await ensureFolder(driveUid, uid);
  const driveFiles = await listNexusFiles(driveUid, folderId);
  const manifest   = await getFullManifest(uid);

  const results = { restored: [], orphaned: [], extra: [] };

  for (const f of driveFiles) {
    const uuid = f.name;
    if (manifest[uuid]) {
      if (manifest[uuid].status === 'missing') {
        await updateManifestStatus(uid, uuid, 'live');
        results.restored.push(uuid);
      }
    } else {
      results.extra.push({ uuid, driveFileId: f.id, size: f.size });
    }
  }

  for (const [uuid, entry] of Object.entries(manifest)) {
    if (entry.driveUid === driveUid && entry.status !== 'missing') {
      const found = driveFiles.find(f => f.name === uuid);
      if (!found) {
        await updateManifestStatus(uid, uuid, 'missing');
        results.orphaned.push(uuid);
      }
    }
  }

  return results;
}

// ---- Storage summary --------------------------------------------------------
export async function getStorageSummary(uid) {
  const config = await getSpineConfig(uid);
  const summary = [];

  for (const acc of config.accounts) {
    const item = {
      driveUid:   acc.driveUid,
      email:      acc.email,
      cap:        acc.cap,
      nexusUsed:  acc.nexusUsed ?? 0,
      order:      acc.order,
      driveQuota: null,
      authOk:     hasDriveToken(acc.driveUid),
    };

    if (item.authOk) {
      try {
        item.driveQuota = await getDriveQuota(acc.driveUid);
      } catch (e) { /* ignore */ }
    }

    summary.push(item);
  }

  return summary;
}
