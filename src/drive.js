// src/drive.js
// Google Drive API wrapper for Nexus Spine Link.
//
// All media files are stored in a per-account folder on Google Drive.
// Files are named by UUID only — the original filename and type are stored
// in the Firebase manifest, never in Drive metadata, for privacy.
//
// Drive folder structure:
//   Google Drive (appDataFolder or regular Drive)
//     nexus-media/
//       {nexus-uid}/          ← one subfolder per Nexus account
//         {uuid}              ← encrypted media blob, no extension

const DRIVE_API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API   = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME  = 'application/vnd.google-apps.folder';
const ROOT_FOLDER  = 'nexus-media';

// ---- Token management -------------------------------------------------------
// Tokens are obtained from the Firebase / Google OAuth flow and stored
// in memory per Drive account UID. They are refreshed on 401 responses.

const _tokens = new Map(); // driveUid → { accessToken, expiresAt }

export function storeDriveToken(driveUid, accessToken, expiresInSecs) {
  _tokens.set(driveUid, {
    accessToken,
    expiresAt: Date.now() + (expiresInSecs - 60) * 1000,
  });
}

export function getDriveToken(driveUid) {
  const t = _tokens.get(driveUid);
  if (!t) return null;
  if (Date.now() > t.expiresAt) { _tokens.delete(driveUid); return null; }
  return t.accessToken;
}

export function clearDriveToken(driveUid) {
  _tokens.delete(driveUid);
}

export function hasDriveToken(driveUid) {
  return !!getDriveToken(driveUid);
}

// ---- Authenticated fetch ----------------------------------------------------

async function driveGet(driveUid, path, params = {}) {
  const token = getDriveToken(driveUid);
  if (!token) throw new Error(`No token for Drive account ${driveUid}`);

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

// Returns { limit, usage, free } in bytes.
// limit = Drive total quota (e.g. 15 GB for free tier)
// usage = total bytes used on this Drive account (all apps, not just Nexus)
// free  = limit - usage
export async function getDriveQuota(driveUid) {
  const data = await driveGet(driveUid, '/about', {
    fields: 'storageQuota',
  });
  const q = data.storageQuota;
  const limit = parseInt(q.limit  ?? '0', 10);
  const usage = parseInt(q.usage  ?? '0', 10);
  return {
    limit,
    usage,
    free: Math.max(0, limit - usage),
  };
}

// ---- Folder management ------------------------------------------------------

// Find or create the Nexus root folder for a given Nexus UID on a Drive account.
// Returns the folder ID.
export async function ensureFolder(driveUid, nexusUid) {
  // First look for the root nexus-media folder
  const rootId = await findOrCreateFolder(driveUid, ROOT_FOLDER, 'root');
  // Then look for the per-account subfolder
  return findOrCreateFolder(driveUid, nexusUid, rootId);
}

async function findOrCreateFolder(driveUid, name, parentId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  // Search for existing folder
  const query = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const res = await driveGet(driveUid, '/files', {
    q: query,
    fields: 'files(id,name)',
    spaces: 'drive',
  });

  if (res.files?.length) return res.files[0].id;

  // Create it
  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    }),
  });

  if (!createRes.ok) throw new Error(`Failed to create folder: ${await createRes.text()}`);
  const folder = await createRes.json();
  return folder.id;
}

// ---- Upload -----------------------------------------------------------------

// Upload an encrypted Blob to Drive. Returns the Drive file ID.
// The file is named by UUID only for privacy — no extension, no original name.
export async function uploadFile(driveUid, folderId, uuid, encryptedBlob) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  // Use multipart upload for files under 5 MB, resumable for larger
  if (encryptedBlob.size < 5 * 1024 * 1024) {
    return uploadMultipart(token, folderId, uuid, encryptedBlob);
  } else {
    return uploadResumable(token, folderId, uuid, encryptedBlob);
  }
}

async function uploadMultipart(token, folderId, uuid, blob) {
  const metadata = JSON.stringify({
    name: uuid,
    parents: [folderId],
  });

  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('file', blob, uuid);

  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (res.status === 401) throw new DriveAuthError();
  if (res.status === 403) throw new DriveQuotaError();
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data.id;
}

async function uploadResumable(token, folderId, uuid, blob) {
  // Initiate resumable session
  const initRes = await fetch(
    `${UPLOAD_API}/files?uploadType=resumable&fields=id`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': blob.size,
      },
      body: JSON.stringify({ name: uuid, parents: [folderId] }),
    }
  );

  if (!initRes.ok) throw new Error(`Resumable init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');

  // Upload the content
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': blob.size,
    },
    body: blob,
  });

  if (uploadRes.status === 401) throw new DriveAuthError();
  if (uploadRes.status === 403) throw new DriveQuotaError();
  if (!uploadRes.ok) throw new Error(`Resumable upload failed: ${uploadRes.status}`);

  const data = await uploadRes.json();
  return data.id;
}

// ---- Download ---------------------------------------------------------------

// Download a file by Drive file ID. Returns an ArrayBuffer.
export async function downloadFile(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const res = await fetch(
    `${DRIVE_API}/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (res.status === 401) { clearDriveToken(driveUid); throw new DriveAuthError(driveUid); }
  if (res.status === 404) throw new DriveFileNotFoundError(driveFileId);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);

  return res.arrayBuffer();
}

// ---- Trash / restore detection ----------------------------------------------

// Check if a file is in Drive trash. Returns 'live' | 'trashed' | 'missing'
export async function checkFileStatus(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  try {
    const res = await driveGet(driveUid, `/files/${driveFileId}`, {
      fields: 'id,trashed',
    });
    return res.trashed ? 'trashed' : 'live';
  } catch (err) {
    if (err instanceof DriveFileNotFoundError) return 'missing';
    throw err;
  }
}

// Restore a trashed file
export async function restoreFile(driveUid, driveFileId) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  const res = await fetch(`${DRIVE_API}/files/${driveFileId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: false }),
  });

  if (!res.ok) throw new Error(`Restore failed: ${res.status}`);
  return res.json();
}

// Restore the Nexus folder if it was trashed
export async function restoreFolderIfTrashed(driveUid, nexusUid) {
  const token = getDriveToken(driveUid);
  if (!token) throw new DriveAuthError(driveUid);

  // Search in trash for our folder
  const q = `name='${nexusUid}' and mimeType='${FOLDER_MIME}' and trashed=true`;
  const res = await driveGet(driveUid, '/files', {
    q,
    fields: 'files(id,name)',
    spaces: 'drive',
  });

  if (res.files?.length) {
    for (const f of res.files) {
      await restoreFile(driveUid, f.id);
    }
    return true; // restored
  }
  return false; // not in trash — permanently deleted
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
// Lists all files in the Nexus folder on a Drive account.
// Used when re-linking a previously removed account.
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
