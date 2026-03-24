// src/media.js
// Media message handling for Nexus Phase 2.
//
// Handles: file selection, compression (images), upload to Spine,
// generating message payloads, and rendering media in the chat.
//
// All media is encrypted before leaving the device.
// The message in Firebase contains only the encrypted UUID reference —
// the actual bytes live in Drive, accessible only with the Nexus key.

import { encrypt, decrypt } from './crypto.js';
import { uploadMedia, downloadMedia } from './spine.js';

// ---- Constants --------------------------------------------------------------
const MAX_IMAGE_DIMENSION = 1920; // resize images above this before upload
const JPEG_QUALITY        = 0.85;
const MAX_FILE_SIZE       = 100 * 1024 * 1024; // 100 MB hard limit per file

// ---- File validation --------------------------------------------------------

export function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (max 100 MB). This file is ${formatBytes(file.size)}.`);
  }
  return true;
}

// ---- Image compression ------------------------------------------------------

// Resize and compress an image file before upload.
// Returns a new Blob (JPEG) or the original file if not an image or small enough.
export async function compressImage(file) {
  if (!file.type.startsWith('image/')) return file;
  if (file.size < 200 * 1024) return file; // skip compression for small images

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
        resolve(file); // no resize needed
        return;
      }

      const ratio  = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
      width        = Math.round(width  * ratio);
      height       = Math.round(height * ratio);

      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        blob => {
          if (!blob) { resolve(file); return; }
          // Use compressed version only if it's actually smaller
          resolve(blob.size < file.size
            ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
            : file
          );
        },
        'image/jpeg',
        JPEG_QUALITY
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ---- Generate thumbnail (for image previews in chat) -----------------------

export async function generateThumbnail(file, maxSize = 200) {
  if (!file.type.startsWith('image/')) return null;

  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio  = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---- Upload and build message payload --------------------------------------

// Upload a media file and return the message payload fields to include
// alongside the encrypted text payload.
// Returns: { uuid, mediaType, fileName, fileSize, mimeType, thumbnailB64? }
export async function prepareMediaMessage(uid, encKey, file, onProgress) {
  validateFile(file);

  // Compress images
  const fileToUpload = await compressImage(file);

  // Generate thumbnail for images (stored encrypted in message metadata)
  const thumbB64 = await generateThumbnail(file);

  // Upload to Spine Drive
  const { uuid } = await uploadMedia(uid, encKey, fileToUpload, onProgress);

  // Encrypt the thumbnail too if present
  let encThumb = null;
  if (thumbB64) {
    encThumb = await encrypt(encKey, thumbB64);
  }

  return {
    uuid,
    mediaType:  file.type.startsWith('image/') ? 'image' : 'file',
    fileName:   file.name,
    fileSize:   file.size,
    mimeType:   file.type,
    encThumb,  // { ciphertext, iv } or null
  };
}

// ---- In-memory media cache -------------------------------------------------
// Maps uuid → { objectURL, mimeType } for the lifetime of the page session.
// Prevents re-downloading the same file from Drive every time the user taps it.
// Object URLs are revoked when the page unloads.
const _mediaCache = new Map();

window.addEventListener('beforeunload', () => {
  // Blobs are stored, not object URLs — nothing to explicitly revoke.
  // The browser reclaims blob memory when the page unloads.
  _mediaCache.clear();
});

// Evict oldest entries if cache grows too large (max 50 media items in memory)
// Cache stores Blobs, not object URLs, so no revocation needed here.
function evictMediaCache() {
  if (_mediaCache.size <= 50) return;
  const oldest = _mediaCache.keys().next().value;
  _mediaCache.delete(oldest);
}

// ---- Download and display --------------------------------------------------

// Download and decrypt a media file. Returns a fresh object URL each call.
// The underlying Blob is cached — Drive is only hit once per session per file.
// A fresh object URL is created on each call so that callers can safely
// revoke it without invalidating the cache for subsequent calls.
export async function fetchMedia(uid, encKey, uuid) {
  const cached = _mediaCache.get(uuid);
  if (cached) {
    // Blob is cached — create a new object URL (cheap, avoids revocation issues)
    return URL.createObjectURL(cached.blob);
  }

  const blob = await downloadMedia(uid, encKey, uuid);

  evictMediaCache();
  _mediaCache.set(uuid, { blob, mimeType: blob.type });
  return URL.createObjectURL(blob);
}

// Manually evict a specific UUID from the cache (e.g. after file deletion)
export function evictMediaFromCache(uuid) {
  _mediaCache.delete(uuid);
}

// Decrypt a thumbnail from message metadata. Returns a data URL.
export async function decryptThumbnail(encKey, encThumb) {
  if (!encThumb?.ciphertext) return null;
  try {
    return await decrypt(encKey, encThumb.ciphertext, encThumb.iv);
  } catch {
    return null;
  }
}

// ---- Render helpers --------------------------------------------------------

// Build the HTML for an image message bubble
export function buildImageBubbleHTML(msg, thumbDataUrl) {
  const hasThumb = !!thumbDataUrl;
  return `
    <div class="media-bubble media-image" data-uuid="${msg.uuid}">
      ${hasThumb
        ? `<img class="msg-thumb" src="${thumbDataUrl}" alt="${escHtml(msg.fileName || 'Image')}"
               loading="lazy" onclick="Nexus.openMedia('${msg.uuid}')">`
        : `<div class="media-placeholder" onclick="Nexus.openMedia('${msg.uuid}')">
             <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
               <rect x="3" y="3" width="18" height="18" rx="2"/>
               <circle cx="8.5" cy="8.5" r="1.5"/>
               <path d="M21 15l-5-5L5 21"/>
             </svg>
             <span>${escHtml(msg.fileName || 'Image')}</span>
           </div>`
      }
      <div class="media-caption">${escHtml(msg.fileName || '')}</div>
    </div>`;
}

// Build the HTML for a file message bubble
export function buildFileBubbleHTML(msg) {
  return `
    <div class="media-bubble media-file" onclick="Nexus.openMedia('${msg.uuid}')">
      <div class="file-icon">${fileIcon(msg.mimeType)}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(msg.fileName || 'File')}</div>
        <div class="file-size">${formatBytes(msg.fileSize || 0)}</div>
      </div>
      <div class="file-download-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M9 3v9M5 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3 14h12" stroke-linecap="round"/>
        </svg>
      </div>
    </div>`;
}

// ---- Utility ----------------------------------------------------------------

export function formatBytes(bytes) {
  if (bytes < 1024)           return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)     return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

function fileIcon(mimeType) {
  if (!mimeType) return '&#128196;';
  if (mimeType.startsWith('image/'))       return '&#128247;';
  if (mimeType.startsWith('video/'))       return '&#127909;';
  if (mimeType.startsWith('audio/'))       return '&#127925;';
  if (mimeType.includes('pdf'))            return '&#128196;';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return '&#128230;';
  if (mimeType.includes('word') || mimeType.includes('document'))  return '&#128196;';
  return '&#128196;';
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
