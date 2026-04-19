// src/spine.js
// Spine Link — multi-Drive account pooling for Nexus media storage.
//
// A "Spine" is an ordered list of Google Drive accounts. When sending media,
// Nexus picks the first account in the queue with enough free space.
// Each account has a user-defined cap (ceiling Nexus will not exceed).
//
// Firebase storage path for Spine config:
//   accounts/{uid}/spineConfig/
//     accounts: [ { driveUid, email, cap, nexusUsed, folderId, addedAt, order } ]
//
// Firebase storage path for media manifest:
//   accounts/{uid}/mediaManifest/{uuid}/
//     driveUid, driveFileId, folderId, size, mimeType, addedAt, status
//
// The manifest is the ground truth for which file lives where. It survives
// device wipes, account re-links, and everything else.

import {
  getDatabase, ref, get, set, update, remove,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getFirebaseApp } from './auth.js';
import {
  getDriveQuota, ensureFolder, uploadFile, downloadFile,
  checkFileStatus, restoreFile, restoreFolderIfTrashed,
  listNexusFiles, deleteFile,
  getDriveToken, hasDriveToken,
  DriveAuthError, DriveQuotaError, DriveFileNotFoundError,
} from './drive.js';
import { encrypt, decrypt } from './crypto.js';

let _spineDb = null;
function db() {
  if (!_spineDb) _spineDb = getDatabase(getFirebaseApp());
  return _spineDb;
}

// ---- Firebase path helpers --------------------------------------------------
const P = {
  spineConfig:   uid       => `accounts/${uid}/spineConfig`,
  manifest:      uid       => `accounts/${uid}/mediaManifest`,
  manifestEntry: (uid, id) => `accounts/${uid}/mediaManifest/${id}`,
};

// ---- Spine config CRUD ------------------------------------------------------

export async function getSpineConfig(uid) {
  const snap = await get(ref(db(), P.spineConfig(uid)));
  if (!snap.exists()) return { accounts: [] };
  const val = snap.val();
  return { accounts: val.accounts ?? [] };
}

export async function saveSpineConfig(uid, config) {
  await set(ref(db(), P.spineConfig(uid)), config);
}

// Add a Drive account to the Spine
export async function addSpineAccount(uid, driveUid, email, capBytes) {
  // Read fresh config each time — concurrent adds from different devices
  // could both pass the duplicate check if we cached the config.
  const config = await getSpineConfig(uid);
  const existing = config.accounts.find(a => a.driveUid === driveUid);
  if (existing) throw new Error(`Drive account ${email} is already in your Spine`);

  const newAcc = {
    driveUid,
    email,
    cap:        capBytes,
    nexusUsed:  0,
    folderId:   null, // will be set on first upload
    addedAt:    Date.now(),
    order:      config.accounts.length,
  };
  config.accounts.push(newAcc);

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
// Returns bytes available for Nexus on a specific Drive account.
// = min(cap - nexusUsed, realDriveFreeSpace)
export async function getAvailableSpace(uid, driveAcc) {
  const capHeadroom = Math.max(0, driveAcc.cap - (driveAcc.nexusUsed ?? 0));
  try {
    const quota = await getDriveQuota(driveAcc.driveUid);
    return Math.min(capHeadroom, quota.free);
  } catch (err) {
    // Auth errors mean the token is gone — return 0 so this account is skipped.
    // Other errors (network) fall back to cap headroom so we don't block uploads
    // just because the quota API is temporarily unavailable.
    if (err instanceof DriveAuthError) return 0;
    return capHeadroom;
  }
}

// ---- Route: pick best Drive account for an upload --------------------------
// Returns the SpineAccount that has enough space, in queue order.
// Throws if no account has enough space.
export async function routeUpload(uid, fileSizeBytes) {
  const config = await getSpineConfig(uid);
  if (!config.accounts.length) {
    throw new Error('No Drive accounts in Spine. Add one in Settings → Storage.');
  }

  const sorted = [...config.accounts].sort((a, b) => a.order - b.order);
  let needsAuth = false;

  for (const acc of sorted) {
    if (!hasDriveToken(acc.driveUid)) { needsAuth = true; continue; }
    const avail = await getAvailableSpace(uid, acc);
    if (avail >= fileSizeBytes) return acc;
  }

  if (needsAuth) {
    throw new Error(
      'Drive account needs re-authentication. Open Settings → Storage and tap Re-authenticate.'
    );
  }
  throw new Error('No Spine account has enough space. Add a Drive account or increase a cap.');
}

// ---- Manifest CRUD ----------------------------------------------------------

export async function addManifestEntry(uid, uuid, entry) {
  await set(ref(db(), P.manifestEntry(uid, uuid)), {
    ...entry,
    addedAt: Date.now(),
    status: 'live',
  });
}

export async function getManifestEntry(uid, uuid) {
  const snap = await get(ref(db(), P.manifestEntry(uid, uuid)));
  return snap.exists() ? snap.val() : null;
}

export async function updateManifestStatus(uid, uuid, status) {
  await update(ref(db(), P.manifestEntry(uid, uuid)), { status });
}

export async function removeManifestEntry(uid, uuid) {
  await remove(ref(db(), P.manifestEntry(uid, uuid)));
}

export async function getFullManifest(uid) {
  const snap = await get(ref(db(), P.manifest(uid)));
  if (!snap.exists()) return {};
  return snap.val();
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
// Encrypts the file with the Nexus key, uploads to Drive, records in manifest.
// Returns the UUID.
export async function uploadMedia(uid, encKey, file, onProgress) {
  // Generate a UUID for this file
  const uuid = crypto.randomUUID();

  // Read file as ArrayBuffer and encrypt
  const arrayBuf  = await file.arrayBuffer();
  const plainBlob = new Uint8Array(arrayBuf);

  // Encrypt: convert to base64 string then encrypt.
  // Use a chunked approach — the naive spread pattern crashes with stack
  // overflow for any file larger than ~64 KB.
  let b64 = '';
  const CHUNK = 8192;
  for (let i = 0; i < plainBlob.length; i += CHUNK) {
    b64 += String.fromCharCode(...plainBlob.subarray(i, i + CHUNK));
  }
  b64 = btoa(b64);
  const { ciphertext, iv } = await encrypt(encKey, b64);
  const encPayload = JSON.stringify({ ciphertext, iv });
  const encBlob    = new Blob([encPayload], { type: 'application/octet-stream' });

  // Route to best Drive account
  const acc = await routeUpload(uid, encBlob.size);

  // Ensure the folder exists on that Drive account.
  // Re-read config from Firebase before writing so we never overwrite a
  // folderId that a concurrent upload on another device may have just set.
  let folderId = acc.folderId;
  if (!folderId) {
    folderId = await ensureFolder(acc.driveUid, uid);
    // Read-modify-write with a fresh snapshot to avoid overwriting concurrent updates
    const freshConfig = await getSpineConfig(uid);
    const freshAcc = freshConfig.accounts.find(x => x.driveUid === acc.driveUid);
    if (freshAcc && !freshAcc.folderId) {
      freshAcc.folderId = folderId;
      await saveSpineConfig(uid, freshConfig);
    } else if (freshAcc?.folderId) {
      // Another upload already wrote the folderId — use theirs
      folderId = freshAcc.folderId;
    }
  }

  // Upload
  const driveFileId = await uploadFile(acc.driveUid, folderId, uuid, encBlob, onProgress);

  // Record in manifest
  await addManifestEntry(uid, uuid, {
    driveUid:    acc.driveUid,
    driveFileId,
    folderId,
    size:        encBlob.size,
    originalSize:file.size,
    mimeType:    file.type,
    fileName:    file.name,
  });

  // Update usage (use encrypted blob size — same unit as cap tracking)
  await incrementNexusUsed(uid, acc.driveUid, encBlob.size);

  return { uuid, driveUid: acc.driveUid, driveFileId };
}

// ---- Download media ---------------------------------------------------------
// Downloads and decrypts a media file. Returns a Blob.
export async function downloadMedia(uid, encKey, uuid) {
  const entry = await getManifestEntry(uid, uuid);
  if (!entry) throw new Error('Media not found in manifest');

  // Check if file is trashed — restore it silently
  if (hasDriveToken(entry.driveUid)) {
    try {
      const status = await checkFileStatus(entry.driveUid, entry.driveFileId);
      if (status === 'trashed') {
        await restoreFile(entry.driveUid, entry.driveFileId);
        await updateManifestStatus(uid, uuid, 'live');
      } else if (status === 'missing') {
        await updateManifestStatus(uid, uuid, 'missing');
        throw new Error('File was permanently deleted from Drive');
      }
    } catch (err) {
      throw err; // surface all errors including DriveAuthError immediately
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
// ---- Pending Drive delete queue ---------------------------------------------
// When deleteMedia is called but the OAuth token has expired we persist the
// driveUid + driveFileId in Firebase and retry on next sign-in / re-auth.

async function enqueuePendingDelete(uid, driveUid, driveFileId) {
  try {
    const config = await getSpineConfig(uid);
    const queue  = config.pendingDeletes ?? [];
    if (!queue.some(e => e.driveFileId === driveFileId)) {
      queue.push({ driveUid, driveFileId, queuedAt: Date.now() });
      await saveSpineConfig(uid, { ...config, pendingDeletes: queue });
    }
  } catch (err) {
    console.warn('[spine] Could not queue Drive deletion:', err.message);
  }
}

export async function drainPendingDriveDeletes(uid) {
  try {
    const config = await getSpineConfig(uid);
    const queue  = config.pendingDeletes ?? [];
    if (!queue.length) return;

    const remaining = [];
    for (const entry of queue) {
      if (!hasDriveToken(entry.driveUid)) { remaining.push(entry); continue; }
      try {
        await deleteFile(entry.driveUid, entry.driveFileId);
      } catch (err) {
        if (!(err instanceof DriveFileNotFoundError)) remaining.push(entry);
      }
    }
    await saveSpineConfig(uid, { ...config, pendingDeletes: remaining });
    const n = queue.length - remaining.length;
    if (n > 0) console.log(`[spine] Drained ${n} pending Drive deletion(s)`);
  } catch (err) {
    console.warn('[spine] drainPendingDriveDeletes error:', err.message);
  }
}

export async function deleteMedia(uid, uuid) {
  const entry = await getManifestEntry(uid, uuid);
  if (!entry) return;

  if (hasDriveToken(entry.driveUid)) {
    try {
      await deleteFile(entry.driveUid, entry.driveFileId);
    } catch (err) {
      if (!(err instanceof DriveFileNotFoundError)) {
        await enqueuePendingDelete(uid, entry.driveUid, entry.driveFileId);
      }
    }
  } else {
    // Token expired — queue for retry after next sign-in
    await enqueuePendingDelete(uid, entry.driveUid, entry.driveFileId);
  }

  await decrementNexusUsed(uid, entry.driveUid, entry.size ?? 0);
  await removeManifestEntry(uid, uuid);
}

// ---- Folder recovery --------------------------------------------------------
// Called on startup for each Spine account to check if the Nexus folder
// was trashed and restore it silently.
export async function checkAndRestoreFolders(uid) {
  const config = await getSpineConfig(uid);
  for (const acc of config.accounts) {
    if (!hasDriveToken(acc.driveUid)) continue;
    try {
      const restored = await restoreFolderIfTrashed(acc.driveUid, uid);
      if (restored) console.log(`[spine] Restored trashed folder for ${acc.email}`);
    } catch {}
  }
}

// ---- Re-link orphan scan ----------------------------------------------------
// When a previously removed Drive account is re-added, scan its folder for
// UUID files and cross-reference against the manifest.
export async function scanRelinkedAccount(uid, driveUid) {
  const config = await getSpineConfig(uid);
  const acc    = config.accounts.find(a => a.driveUid === driveUid);
  if (!acc) throw new Error('Account not in Spine');

  // Ensure folder exists
  const folderId = acc.folderId ?? await ensureFolder(driveUid, uid);

  // List files on Drive
  const driveFiles = await listNexusFiles(driveUid, folderId);
  const manifest   = await getFullManifest(uid);

  const results = { restored: [], orphaned: [], extra: [] };
  let recalcUsed = 0;

  for (const f of driveFiles) {
    const uuid = f.name; // files are named by UUID
    if (manifest[uuid]) {
      // Known UUID — restore manifest entry if it was marked missing
      if (manifest[uuid].status === 'missing') {
        await updateManifestStatus(uid, uuid, 'live');
        results.restored.push(uuid);
      }
      // Count toward usage regardless (file is present on this account's Drive)
      recalcUsed += parseInt(f.size ?? manifest[uuid].size ?? 0, 10);
    } else {
      // Unknown UUID — flag as extra (possibly from another installation)
      results.extra.push({ uuid, driveFileId: f.id, size: f.size });
    }
  }

  // Find manifest entries that point to this Drive account but weren't on Drive
  for (const [uuid, entry] of Object.entries(manifest)) {
    if (entry.driveUid === driveUid && entry.status === 'live') {
      const found = driveFiles.find(f => f.name === uuid);
      if (!found) {
        await updateManifestStatus(uid, uuid, 'missing');
        results.orphaned.push(uuid);
      }
    }
  }

  // Reconcile nexusUsed to match actual Drive contents for this account
  const reconcileConfig = await getSpineConfig(uid);
  const liveAcc = reconcileConfig.accounts.find(a => a.driveUid === driveUid);
  if (liveAcc) {
    liveAcc.nexusUsed = recalcUsed;
    if (!liveAcc.folderId) liveAcc.folderId = folderId;
    await saveSpineConfig(uid, reconcileConfig);
  }

  return results;
}

// ---- Storage summary --------------------------------------------------------
// Returns per-account storage info for the Settings panel.
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
      } catch {}
    }

    summary.push(item);
  }

  return summary;
}
