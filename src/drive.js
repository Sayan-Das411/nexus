// src/drive.js
// Google Drive API wrapper for Nexus Spine Link.

const DRIVE_API   = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER = 'nexus-media';

// ---- Token management -------------------------------------------------------
// Stored in localStorage so tokens survive page reloads.

const TOKEN_PREFIX = 'nexus_dt_';

export function storeDriveToken(driveUid, accessToken, expiresInSecs) {
  try {
    localStorage.setItem(TOKEN_PREFIX + driveUid, JSON.stringify({
      accessToken,
      expiresAt: Date.now() + (expiresInSecs - 60) * 1000,
    }));
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

// ---- Upload cancellation ----------------------------------------------------

let _activeXhr = null;

export function cancelCurrentUpload() {
  if (_activeXhr) {
    _activeXhr.abort();
    _activeXhr = null;
  }
}

// ---- Authenticated fetch (GET/PATCH/DELETE) ---------------------------------

async function driveGet(driveUid, path, params = {}) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const url = new URL(`${DRIVE_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) { clearDriveToken(driveUid); throw new DriveAuthError(driveUid); }
  if (res.status === 404) throw new DriveFileNotFoundError(path);
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- Quota ------------------------------------------------------------------

export async function getDriveQuota(driveUid) {
  const data = await driveGet(driveUid, '/about', { fields: 'storageQuota' });
  const q     = data.storageQuota;
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

  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const res = await driveGet(driveUid, '/files', { q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.files?.length) return res.files[0].id;

  const createRes = await fetch(`${DRIVE_API}/files`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (createRes.status === 401) {
    clearDriveToken(driveUid);
    throw new DriveAuthError(driveUid);
  }
  if (!createRes.ok) throw new Error(`Failed to create folder: ${await createRes.text()}`);
  return (await createRes.json()).id;
}

// ---- Upload -----------------------------------------------------------------
// Uses XMLHttpRequest for all uploads so progress events and cancellation work.

// onProgress(fraction) is called with values 0..1 during upload.
export async function uploadFile(driveUid, folderId, uuid, encryptedBlob, onProgress) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  if (encryptedBlob.size < 5 * 1024 * 1024) {
    return uploadMultipart(token, driveUid, folderId, uuid, encryptedBlob, onProgress);
  } else {
    return uploadResumable(token, driveUid, folderId, uuid, encryptedBlob, onProgress);
  }
}

function xhrUpload(method, url, headers, body, onProgress, driveUid) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    _activeXhr = xhr;

    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, String(v));

    if (onProgress) {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }

    xhr.onload = () => {
      _activeXhr = null;
      if (xhr.status === 401) { if (driveUid) clearDriveToken(driveUid); reject(new DriveAuthError(driveUid ?? 'unknown')); return; }
      if (xhr.status === 403) {
        let msg = '';
        try { msg = JSON.parse(xhr.responseText)?.error?.message ?? ''; } catch {}
        if (msg.toLowerCase().includes('not been used') || msg.toLowerCase().includes('disabled')) {
          reject(new Error(
            'Google Drive API is not enabled. Go to console.cloud.google.com → ' +
            'APIs & Services → Enable APIs → search "Google Drive API" → Enable.'
          ));
        } else {
          reject(new DriveQuotaError());
        }
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed ${xhr.status}: ${xhr.responseText}`));
        return;
      }
      try   { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error('Invalid response from Drive API')); }
    };

    xhr.onerror = () => { _activeXhr = null; reject(new Error('Network error during upload')); };
    xhr.onabort = () => { _activeXhr = null; reject(new Error('Upload cancelled')); };

    xhr.send(body);
  });
}

async function uploadMultipart(token, driveUid, folderId, uuid, blob, onProgress) {
  const metadata = JSON.stringify({ name: uuid, parents: [folderId] });
  const form     = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('file', blob, uuid);

  const data = await xhrUpload(
    'POST',
    `${UPLOAD_API}/files?uploadType=multipart&fields=id`,
    { Authorization: `Bearer ${token}` },
    form,
    onProgress,
    driveUid
  );
  return data.id;
}

async function uploadResumable(token, driveUid, folderId, uuid, blob, onProgress) {
  // Initiate the resumable session
  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
    method:  'POST',
    headers: {
      Authorization:             `Bearer ${token}`,
      'Content-Type':            'application/json',
      'X-Upload-Content-Type':   'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name: uuid, parents: [folderId] }),
  });
  if (!initRes.ok) throw new Error(`Resumable init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');

  // Upload the content with progress tracking
  const data = await xhrUpload(
    'PUT',
    uploadUrl,
    { 'Content-Type': 'application/octet-stream' },
    blob,
    onProgress,
    driveUid
  );
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
  if (!res.ok)            throw new Error(`Download failed ${res.status}`);
  return res.arrayBuffer();
}

// ---- Trash / restore --------------------------------------------------------

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
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ trashed: false }),
  });
  if (!res.ok) throw new Error(`Restore failed: ${res.status}`);
  return res.json();
}

export async function restoreFolderIfTrashed(driveUid, nexusUid) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  const q   = `name='${nexusUid}' and mimeType='${FOLDER_MIME}' and trashed=true`;
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
  const res = await fetch(`${DRIVE_API}/files/${driveFileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  // 204 No Content = success; 404 = already gone (treat as success)
  if (res.status !== 204 && res.status !== 404) {
    if (res.status === 401) { clearDriveToken(driveUid); throw new DriveAuthError(driveUid); }
    throw new Error(`Delete failed ${res.status}`);
  }
}

// ---- Scan -------------------------------------------------------------------

export async function listNexusFiles(driveUid, folderId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);
  const files = [];
  let pageToken = null;
  do {
    const params = {
      q:         `'${folderId}' in parents and trashed=false`,
      fields:    'nextPageToken,files(id,name,size)',
      pageSize:  '1000',
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
  constructor() { super('Drive quota exceeded'); this.name = 'DriveQuotaError'; }
}

export class DriveFileNotFoundError extends Error {
  constructor(fileId) {
    super(`Drive file not found: ${fileId}`);
    this.name = 'DriveFileNotFoundError';
    this.fileId = fileId;
  }
}
