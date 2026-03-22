// src/drive.js
// Google Drive API wrapper for Nexus Spine Link.

const DRIVE_API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API   = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME  = 'application/vnd.google-apps.folder';
const ROOT_FOLDER  = 'nexus-media';

// ---- Token management -------------------------------------------------------
// Tokens are stored in localStorage so they survive page reloads.
// A plain Map would be wiped on every refresh, forcing re-auth every session.
// Tokens still expire after ~1 hour (Google's hard limit).

const TOKEN_PREFIX = 'nexus_dt_';

export function storeDriveToken(driveUid, accessToken, expiresInSecs) {
  try {
    const record = {
      accessToken,
      expiresAt: Date.now() + (expiresInSecs - 60) * 1000,
    };
    localStorage.setItem(TOKEN_PREFIX + driveUid, JSON.stringify(record));
  } catch {}
}

export function getDriveToken(driveUid) {
  try {
    const raw = localStorage.getItem(TOKEN_PREFIX + driveUid);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (Date.now() > t.expiresAt) {
      localStorage.removeItem(TOKEN_PREFIX + driveUid);
      return null;
    }
    return t.accessToken;
  } catch { return null; }
}

export function clearDriveToken(driveUid) {
  try { localStorage.removeItem(TOKEN_PREFIX + driveUid); } catch {}
}

export function hasDriveToken(driveUid) {
  return !!getDriveToken(driveUid);
}

// ---- Authenticated fetch ----------------------------------------------------

async function driveGet(driveUid, path, params = {}) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const url = new URL(`${DRIVE_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    clearDriveToken(driveUid);
    throw new DriveAuthError(driveUid);
  }
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- Quota ------------------------------------------------------------------

export async function getDriveQuota(driveUid) {
  const data = await driveGet(driveUid, '/about', { fields: 'storageQuota' });
  const q = data.storageQuota;
  const limit = parseInt(q.limit ?? '0', 10);
  const usage = parseInt(q.usage ?? '0', 10);
  return { limit, usage, free: Math.max(0, limit - usage) };
}

// ---- Folder management ------------------------------------------------------

export async function ensureFolder(driveUid, nexusUid) {
  const rootId = await findOrCreateFolder(driveUid, ROOT_FOLDER, 'root');
  return findOrCreateFolder(driveUid, nexusUid, rootId);
}

async function findOrCreateFolder(driveUid, name, parentId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const query = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const res = await driveGet(driveUid, '/files', {
    q: query, fields: 'files(id,name)', spaces: 'drive',
  });

  if (res.files?.length) return res.files[0].id;

  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });

  if (!createRes.ok) throw new Error(`Failed to create folder: ${await createRes.text()}`);
  const folder = await createRes.json();
  return folder.id;
}

// ---- Upload -----------------------------------------------------------------

export async function uploadFile(driveUid, folderId, uuid, encryptedBlob) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  if (encryptedBlob.size < 5 * 1024 * 1024) {
    return uploadMultipart(token, folderId, uuid, encryptedBlob);
  } else {
    return uploadResumable(token, folderId, uuid, encryptedBlob);
  }
}

async function uploadMultipart(token, folderId, uuid, blob) {
  const metadata = JSON.stringify({ name: uuid, parents: [folderId] });
  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('file', blob, uuid);

  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (res.status === 401) throw new DriveAuthError();
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const msg  = body?.error?.message ?? '';
    if (msg.toLowerCase().includes('not been used') || msg.toLowerCase().includes('disabled')) {
      throw new Error(
        'Google Drive API is not enabled. Go to console.cloud.google.com → ' +
        'APIs & Services → Enable APIs → search "Google Drive API" → Enable.'
      );
    }
    throw new DriveQuotaError();
  }
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function uploadResumable(token, folderId, uuid, blob) {
  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': blob.size,
    },
    body: JSON.stringify({ name: uuid, parents: [folderId] }),
  });

  if (!initRes.ok) throw new Error(`Resumable init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.size },
    body: blob,
  });

  if (uploadRes.status === 401) throw new DriveAuthError();
  if (uploadRes.status === 403) throw new DriveQuotaError();
  if (!uploadRes.ok) throw new Error(`Resumable upload failed: ${uploadRes.status}`);
  const data = await uploadRes.json();
  return data.id;
}

// ---- Download ---------------------------------------------------------------

export async function downloadFile(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const res = await fetch(`${DRIVE_API}/files/${driveFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) { clearDriveToken(driveUid); throw new DriveAuthError(driveUid); }
  if (res.status === 404) throw new DriveFileNotFoundError(driveFileId);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return res.arrayBuffer();
}

// ---- Trash / restore detection ----------------------------------------------

export async function checkFileStatus(driveUid, driveFileId) {
  try {
    const res = await driveGet(driveUid, `/files/${driveFileId}`, { fields: 'id,trashed' });
    return res.trashed ? 'trashed' : 'live';
  } catch (err) {
    if (err instanceof DriveFileNotFoundError) return 'missing';
    throw err;
  }
}

export async function restoreFile(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  const res = await fetch(`${DRIVE_API}/files/${driveFileId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: false }),
  });
  if (!res.ok) throw new Error(`Restore failed: ${res.status}`);
  return res.json();
}

export async function restoreFolderIfTrashed(driveUid, nexusUid) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  const q = `name='${nexusUid}' and mimeType='${FOLDER_MIME}' and trashed=true`;
  const res = await driveGet(driveUid, '/files', { q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.files?.length) {
    for (const f of res.files) await restoreFile(driveUid, f.id);
    return true;
  }
  return false;
}

// ---- Delete -----------------------------------------------------------------

export async function deleteFile(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  await fetch(`${DRIVE_API}/files/${driveFileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---- Scan for orphaned files ------------------------------------------------

export async function listNexusFiles(driveUid, folderId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  const files = [];
  let pageToken = null;
  do {
    const params = {
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,size)',
      pageSize: '1000',
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveGet(driveUid, '/files', params);
    files.push(...(res.files ?? []));
    pageToken = res.nextPageToken ?? null;
  } while (pageToken);
  return files;
}

// ---- Error types ------------------------------------------------------------

export class DriveAuthError extends Error {
  constructor(driveUid) {
    super(`Drive auth required for account: ${driveUid}`);
    this.name = 'DriveAuthError';
    this.driveUid = driveUid;
  }
}

export class DriveQuotaError extends Error {
  constructor() {
    super('Drive quota exceeded');
    this.name = 'DriveQuotaError';
  }
}

export class DriveFileNotFoundError extends Error {
  constructor(fileId) {
    super(`Drive file not found: ${fileId}`);
    this.name = 'DriveFileNotFoundError';
    this.fileId = fileId;
  }
}
