// src/modals.js
// Complex modal views: passphrase change, Drive file migration, slideshow editor, video wallpaper editor, media preview.

import { toast, nexusConfirm, nexusPrompt } from './dialogs.js';
import { deriveKey, generateSalt, encrypt, decrypt, createVerificationVector, verifyKey } from './crypto.js';
import { keyStore, settings } from './db.js';
import { getFirebaseApp } from './auth.js';
import { getProfile } from './realtime.js';
import { getSpineConfig, saveSpineConfig } from './spine.js';
import { formatBytes } from './media.js';
import {
  hasDriveToken, downloadFile as driveDownloadFile,
  uploadFile as driveUploadFile, deleteFile as driveDeleteFile,
  ensureFolder as driveEnsureFolder
} from './drive.js';
import {
  loadSlideshowOpts, saveSlideshowOpts,
  clearVideoWallpaper, removeVideoWallpaper
} from './appearance.js';

// ============================================================
// CHANGE PASSPHRASE MODAL (WITH FULL DATABASE RE-ENCRYPTION)
// ============================================================
export async function openChangePassphrase(S, onKeyChanged) {
  const modal = document.createElement('div');
  modal.className = 'migrate-modal';
  modal.id = 'pcp-modal';
  modal.innerHTML = `
    <div class="migrate-panel">
      <div class="migrate-title">Change Passphrase</div>
      <div id="pcp-step1">
        <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px;line-height:1.6">
          All existing messages in your database will be re-encrypted with your new passphrase.
        </p>
        <div class="field-group" style="margin-bottom:16px">
          <label class="field-label">Current Passphrase</label>
          <input type="password" id="pcp-current" class="text-input" placeholder="Current passphrase" style="margin-bottom:0">
        </div>
        <div class="field-group" style="margin-bottom:16px">
          <label class="field-label">New Passphrase</label>
          <input type="password" id="pcp-new" class="text-input" placeholder="New passphrase (min 8 chars)" style="margin-bottom:0">
        </div>
        <div class="field-group" style="margin-bottom:20px">
          <label class="field-label">Confirm New Passphrase</label>
          <input type="password" id="pcp-confirm" class="text-input" placeholder="Confirm new passphrase" style="margin-bottom:0">
        </div>
        <div class="migrate-btn-row">
          <button id="pcp-cancel" class="btn btn-ghost btn-sm">Cancel</button>
          <button id="pcp-go" class="btn btn-sm" style="background:var(--accent);color:#fff">Change</button>
        </div>
      </div>
      <div id="pcp-progress" class="hidden">
        <div id="pcp-log" class="migrate-log" style="display:block;max-height:200px"></div>
        <div class="migrate-btn-row" style="margin-top:12px">
          <button id="pcp-close" class="btn btn-ghost btn-sm hidden">Close</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  const logEl    = modal.querySelector('#pcp-log');
  const step1    = modal.querySelector('#pcp-step1');
  const progress = modal.querySelector('#pcp-progress');
  const logLine  = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  modal.querySelector('#pcp-cancel').addEventListener('click', () => modal.remove());

  modal.querySelector('#pcp-go').addEventListener('click', async () => {
    const oldPass = modal.querySelector('#pcp-current').value;
    const newPass = modal.querySelector('#pcp-new').value;
    const confirm = modal.querySelector('#pcp-confirm').value;

    if (!oldPass) { toast('Enter your current passphrase'); return; }
    if (!newPass || newPass.length < 8) { toast('New passphrase must be at least 8 characters'); return; }
    if (newPass !== confirm) { toast('Passphrases do not match'); return; }
    if (oldPass === newPass) { toast('New passphrase must differ from current'); return; }

    step1.classList.add('hidden');
    progress.classList.remove('hidden');

    let pcp_close_bound = false;
    const bindClose = () => {
      if (!pcp_close_bound) {
        pcp_close_bound = true;
        modal.querySelector('#pcp-close').classList.remove('hidden');
        modal.querySelector('#pcp-close').addEventListener('click', () => modal.remove());
      }
    };

    try {
      logLine('Verifying current passphrase…');
      const profile = await getProfile(S.uid);
      if (!profile?.encryptionSalt) throw new Error('Profile not found in Firebase');
      const oldKey = await deriveKey(oldPass, profile.encryptionSalt);
      const vector = JSON.parse(profile.verificationVector);
      if (!await verifyKey(oldKey, vector)) throw new Error('Current passphrase is incorrect');
      logLine('Passphrase verified');

      logLine('Deriving new encryption key…');
      const newSalt   = generateSalt();
      const newKey    = await deriveKey(newPass, newSalt);
      const newVector = await createVerificationVector(newKey);
      logLine('New key derived');

      logLine('Fetching ALL messages from Firebase to prevent data loss…');
      const { getDatabase: gdb, ref: dbRef, get: dbGet, update: dbUpdate } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
      const fireDb = gdb(getFirebaseApp());

      const snap = await dbGet(dbRef(fireDb, `accounts/${S.uid}/messages`));
      const allMsgs = [];
      if (snap.exists()) {
        snap.forEach(c => {
          const val = c.val();
          if (!val.deleted && val.ciphertext) {
            allMsgs.push({ id: c.key, ...val });
          }
        });
      }

      logLine(`Re-encrypting ${allMsgs.length} messages…`);
      const updates = {};
      let msgDone = 0;
      for (const msg of allMsgs) {
        try {
          const plaintext = await decrypt(oldKey, msg.ciphertext, msg.iv);
          const { ciphertext: newC, iv: newIv } = await encrypt(newKey, plaintext);
          updates[`accounts/${S.uid}/messages/${msg.id}/ciphertext`] = newC;
          updates[`accounts/${S.uid}/messages/${msg.id}/iv`]         = newIv;

          if (msg.encThumb?.ciphertext) {
            const thumb = await decrypt(oldKey, msg.encThumb.ciphertext, msg.encThumb.iv);
            const { ciphertext: tc, iv: ti } = await encrypt(newKey, thumb);
            updates[`accounts/${S.uid}/messages/${msg.id}/encThumb/ciphertext`] = tc;
            updates[`accounts/${S.uid}/messages/${msg.id}/encThumb/iv`]         = ti;
          }
          msgDone++;
        } catch (e) {
          logLine(`  Could not re-encrypt ${msg.id}: ${e.message}`);
        }
      }

      logLine('Writing updates to Firebase…');
      const updateEntries = Object.entries(updates);
      for (let i = 0; i < updateEntries.length; i += 400) {
        await dbUpdate(dbRef(fireDb, '/'), Object.fromEntries(updateEntries.slice(i, i + 400)));
      }
      logLine(`${msgDone} messages re-encrypted`);

      logLine('Updating account profile…');
      await dbUpdate(dbRef(fireDb, `accounts/${S.uid}/profile`), {
        encryptionSalt:     newSalt,
        verificationVector: JSON.stringify(newVector),
      });
      logLine('Profile updated');

      await keyStore.set(S.uid, newKey, newSalt, newVector);
      if (onKeyChanged) onKeyChanged(newKey);
      logLine('Local key store updated');
      logLine('\nPassphrase changed successfully!');
      toast('Passphrase changed successfully');
    } catch (err) {
      logLine(`\nERROR: ${err.message}`);
    } finally {
      bindClose();
    }
  });
}

// ============================================================
// SPINE DRIVE FILE MIGRATION MODAL
// ============================================================
export async function openSpineMigration(S, onMigrated) {
  const config = await getSpineConfig(S.uid);
  if (config.accounts.length < 2) {
    toast('You need at least 2 Drive accounts to migrate files.');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'migrate-modal';

  const accountOptions = config.accounts.map(a =>
    `<option value="${a.driveUid}">${a.email}</option>`
  ).join('');

  modal.innerHTML = `
    <div class="migrate-panel">
      <div class="migrate-title">Migrate Files Between Drives</div>
      <div class="migrate-row">
        <label>From</label>
        <select id="mg-from" class="settings-select">${accountOptions}</select>
      </div>
      <div class="migrate-row">
        <label>To</label>
        <select id="mg-to" class="settings-select">${accountOptions}</select>
      </div>
      <div class="settings-hint" style="margin-bottom:12px">
        Moves files from source Drive to destination. Quota tracking updates automatically.
      </div>
      <div id="mg-log" class="migrate-log"></div>
      <div class="migrate-btn-row">
        <button id="mg-cancel" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="mg-start"  class="btn btn-sm" style="background:var(--accent);color:#fff">Migrate</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  const selFrom = modal.querySelector('#mg-from');
  const selTo   = modal.querySelector('#mg-to');
  if (config.accounts.length >= 2) {
    selFrom.value = config.accounts[0].driveUid;
    selTo.value   = config.accounts[1].driveUid;
  }

  modal.querySelector('#mg-cancel').addEventListener('click', () => modal.remove());

  modal.querySelector('#mg-start').addEventListener('click', async () => {
    const fromUid = selFrom.value;
    const toUid   = selTo.value;
    if (fromUid === toUid) { toast('Source and destination must be different'); return; }

    const fromAcc = config.accounts.find(a => a.driveUid === fromUid);
    const toAcc   = config.accounts.find(a => a.driveUid === toUid);
    if (!fromAcc || !toAcc) { toast('Account not found'); return; }

    const log = modal.querySelector('#mg-log');
    log.style.display = 'block'; log.textContent = '';
    const logLine = msg => { log.textContent += msg + '\n'; logElScroll(); };
    const logElScroll = () => { log.scrollTop = log.scrollHeight; };

    const startBtn = modal.querySelector('#mg-start');
    startBtn.disabled = true; startBtn.textContent = 'Migrating…';
    modal.querySelector('#mg-cancel').disabled = true;

    try {
      const { getFullManifest } = await import('./spine.js');
      if (!hasDriveToken(fromUid)) {
        logLine(`Re-authenticating source (${fromAcc.email})…`);
        await window.Nexus?.reAuthDrive?.(fromUid);
        if (!hasDriveToken(fromUid)) { logLine('ERROR: Source account needs re-authentication.'); return; }
      }
      if (!hasDriveToken(toUid)) {
        logLine(`Re-authenticating destination (${toAcc.email})…`);
        await window.Nexus?.reAuthDrive?.(toUid);
        if (!hasDriveToken(toUid)) { logLine('ERROR: Destination account needs re-authentication.'); return; }
      }

      logLine(`Starting: ${fromAcc.email} → ${toAcc.email}`);
      const toFolderId = toAcc.folderId ?? await driveEnsureFolder(toUid, S.uid);
      if (!toAcc.folderId) {
        const freshCfg = await getSpineConfig(S.uid);
        const liveAcc  = freshCfg.accounts.find(a => a.driveUid === toUid);
        if (liveAcc && !liveAcc.folderId) { liveAcc.folderId = toFolderId; await saveSpineConfig(S.uid, freshCfg); }
      }

      const manifest = await getFullManifest(S.uid);
      const entries  = Object.entries(manifest).filter(([, e]) => e.driveUid === fromUid && e.status !== 'missing');
      logLine(`Found ${entries.length} file(s) to migrate.`);

      let ok = 0, failed = 0, migratedBytes = 0;
      for (const [uuid, entry] of entries) {
        logLine(`  Copying ${uuid.slice(0, 8)}…`);
        try {
          const buf       = await driveDownloadFile(fromUid, entry.driveFileId);
          const encBlob   = new Blob([buf], { type: 'application/octet-stream' });
          const newFileId = await driveUploadFile(toUid, toFolderId, uuid, encBlob, () => {});

          const { update, ref: dbRef, getDatabase } =
            await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
          const db = getDatabase(getFirebaseApp());
          await update(dbRef(db, `accounts/${S.uid}/mediaManifest/${uuid}`), {
            driveUid: toUid, driveFileId: newFileId, folderId: toFolderId,
          });
          try { await driveDeleteFile(fromUid, entry.driveFileId); } catch {}
          ok++;
          migratedBytes += entry.size ?? encBlob.size;
          logLine(`  OK ${uuid.slice(0, 8)}`);
        } catch (err) {
          failed++;
          logLine(`  FAIL ${uuid.slice(0, 8)}: ${err.message}`);
        }
      }

      // Update quota usage in spineConfig
      const endConfig = await getSpineConfig(S.uid);
      const endFrom = endConfig.accounts.find(a => a.driveUid === fromUid);
      const endTo   = endConfig.accounts.find(a => a.driveUid === toUid);
      if (endFrom) endFrom.nexusUsed = Math.max(0, (endFrom.nexusUsed ?? 0) - migratedBytes);
      if (endTo)   endTo.nexusUsed   = (endTo.nexusUsed ?? 0) + migratedBytes;
      await saveSpineConfig(S.uid, endConfig);

      logLine(`\nDone. ${ok} migrated (${formatBytes(migratedBytes)}), ${failed} failed.`);
      if (onMigrated) onMigrated(endConfig);
      startBtn.textContent = 'Done';
    } catch (err) {
      logLine(`\nFATAL: ${err.message}`);
    } finally {
      modal.querySelector('#mg-cancel').disabled = false;
      modal.querySelector('#mg-cancel').textContent = 'Close';
    }
  });
}

// ============================================================
// SLIDESHOW WALLPAPER EDITOR MODAL
// ============================================================
export async function openSlideshowEditor(slides, S, onSaved) {
  const existingOpts = await loadSlideshowOpts(S.deviceKey);
  const storedInterval = (await settings.get(`anim_slideshow_interval:${S.deviceKey}`)) ?? 30;

  const modal = document.createElement('div');
  modal.className = 'migrate-modal';
  modal.id = 'slideshow-editor-modal';

  const renderThumbs = (imgs) => imgs.map((src, i) => `
    <div class="ss-thumb-item" data-index="${i}">
      <img src="${src}" alt="Slide ${i+1}" class="ss-thumb-img">
      <div class="ss-thumb-actions">
        <button class="ss-thumb-btn ss-move-up"   data-index="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="ss-thumb-btn ss-move-down" data-index="${i}" ${i === imgs.length-1 ? 'disabled' : ''}>↓</button>
        <button class="ss-thumb-btn ss-delete"    data-index="${i}" style="color:var(--danger)">✕</button>
      </div>
    </div>`).join('');

  const isWD = existingOpts.transition === 'waterdrop';

  modal.innerHTML = `
    <div class="migrate-panel" style="max-width:500px">
      <div class="migrate-title">Edit Slideshow</div>

      <!-- Thumbnails -->
      <div id="ss-thumb-grid" class="ss-thumb-grid">${renderThumbs(slides)}</div>
      <button id="ss-add-btn" class="btn btn-ghost btn-sm" style="margin-top:8px">+ Add Images</button>

      <!-- Transition settings -->
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase">Transition</div>

        <div class="color-row" style="gap:10px">
          <label style="font-size:13px;color:var(--text-dim);min-width:70px">Effect</label>
          <select id="ss-transition" class="settings-select" style="max-width:140px">
            <option value="crossfade" ${existingOpts.transition==='crossfade'?'selected':''}>Crossfade</option>
            <option value="slide"     ${existingOpts.transition==='slide'?'selected':''}>Slide</option>
            <option value="zoom"      ${existingOpts.transition==='zoom'?'selected':''}>Zoom</option>
            <option value="waterdrop" ${isWD?'selected':''}>Waterdrop</option>
          </select>
        </div>

        <div class="color-row" style="gap:10px">
          <label style="font-size:13px;color:var(--text-dim);min-width:70px">Duration</label>
          <select id="ss-duration" class="settings-select" style="max-width:140px">
            <option value="400"  ${existingOpts.duration===400?'selected':''}>Fast (0.4s)</option>
            <option value="800"  ${existingOpts.duration===800?'selected':''}>Medium (0.8s)</option>
            <option value="1500" ${existingOpts.duration===1500?'selected':''}>Slow (1.5s)</option>
          </select>
        </div>

        <div class="color-row" style="gap:10px">
          <label style="font-size:13px;color:var(--text-dim);min-width:70px">Interval</label>
          <select id="ss-interval" class="settings-select" style="max-width:140px">
            <option value="10"  ${storedInterval===10?'selected':''}>10 seconds</option>
            <option value="30"  ${storedInterval===30?'selected':''}>30 seconds</option>
            <option value="60"  ${storedInterval===60?'selected':''}>1 minute</option>
            <option value="300" ${storedInterval===300?'selected':''}>5 minutes</option>
          </select>
        </div>

        <!-- Waterdrop origin picker -->
        <div id="ss-wd-block" class="${isWD?'':'hidden'}" style="margin-top:4px">
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px">Origin Point (click box to position)</label>
          <div style="display:flex;align-items:center;gap:14px">
            <div id="ss-origin-picker" class="waterdrop-origin-picker" style="cursor:crosshair">
              <div id="ss-origin-dot" class="waterdrop-origin-dot"
                   style="left:${existingOpts.waterdropX??50}%;top:${existingOpts.waterdropY??50}%"></div>
            </div>
            <div style="font-size:12px;color:var(--text-dim);line-height:1.6">
              X: <span id="ss-x-val">${existingOpts.waterdropX??50}%</span><br>
              Y: <span id="ss-y-val">${existingOpts.waterdropY??50}%</span>
            </div>
          </div>
        </div>
      </div>

      <div class="migrate-btn-row" style="margin-top:16px">
        <button id="ss-cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="ss-save-btn"   class="btn btn-sm" style="background:var(--accent);color:#fff">Save</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  let currentSlides = [...slides];
  let curWdX = existingOpts.waterdropX ?? 50;
  let curWdY = existingOpts.waterdropY ?? 50;

  const refreshGrid = () => {
    modal.querySelector('#ss-thumb-grid').innerHTML = renderThumbs(currentSlides);
    wireThumbActions();
  };

  const wireThumbActions = () => {
    modal.querySelectorAll('.ss-move-up').forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.dataset.index, 10);
        if (i <= 0) return;
        [currentSlides[i-1], currentSlides[i]] = [currentSlides[i], currentSlides[i-1]];
        refreshGrid();
      };
    });
    modal.querySelectorAll('.ss-move-down').forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.dataset.index, 10);
        if (i >= currentSlides.length - 1) return;
        [currentSlides[i], currentSlides[i+1]] = [currentSlides[i+1], currentSlides[i]];
        refreshGrid();
      };
    });
    modal.querySelectorAll('.ss-delete').forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.dataset.index, 10);
        currentSlides.splice(i, 1);
        refreshGrid();
      };
    });
  };
  wireThumbActions();

  // Transition change
  modal.querySelector('#ss-transition').addEventListener('change', e => {
    modal.querySelector('#ss-wd-block').classList.toggle('hidden', e.target.value !== 'waterdrop');
  });

  // Origin picker click
  modal.querySelector('#ss-origin-picker').addEventListener('click', e => {
    const rect = e.currentTarget.getBoundingClientRect();
    curWdX = Math.round(Math.min(100, Math.max(0, (e.clientX - rect.left) / rect.width  * 100)));
    curWdY = Math.round(Math.min(100, Math.max(0, (e.clientY - rect.top)  / rect.height * 100)));
    modal.querySelector('#ss-origin-dot').style.left = `${curWdX}%`;
    modal.querySelector('#ss-origin-dot').style.top  = `${curWdY}%`;
    modal.querySelector('#ss-x-val').textContent    = `${curWdX}%`;
    modal.querySelector('#ss-y-val').textContent    = `${curWdY}%`;
  });

  // Add images
  modal.querySelector('#ss-add-btn').onclick = () => {
    document.getElementById('slideshow-file-input')?.click();
  };

  modal.querySelector('#ss-cancel-btn').onclick = () => modal.remove();

  modal.querySelector('#ss-save-btn').onclick = async () => {
    const transition = modal.querySelector('#ss-transition').value;
    const duration   = parseInt(modal.querySelector('#ss-duration').value, 10);
    const interval   = parseInt(modal.querySelector('#ss-interval').value, 10);

    const opts = { transition, duration, waterdropX: curWdX, waterdropY: curWdY };
    await saveSlideshowOpts(S.deviceKey, opts);
    await settings.set(`anim_slideshow_interval:${S.deviceKey}`, interval);

    if (onSaved) await onSaved(currentSlides, interval, opts);
    modal.remove();
    toast('Slideshow updated');
  };
}

// ============================================================
// VIDEO WALLPAPER EDITOR MODAL
// ============================================================
export function openVideoEditor(S, onRemoved) {
  const modal = document.createElement('div');
  modal.className = 'migrate-modal';
  modal.innerHTML = `
    <div class="migrate-panel" style="max-width:380px">
      <div class="migrate-title">Video Wallpaper</div>
      <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px;line-height:1.6">
        A video wallpaper is active. You can replace or remove it.
      </p>
      <div class="migrate-btn-row" style="flex-wrap:wrap;gap:8px">
        <button id="vw-replace-btn" class="btn btn-ghost btn-sm">Replace Video</button>
        <button id="vw-remove-btn"  class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger)">Remove</button>
        <button id="vw-cancel-btn"  class="btn btn-ghost btn-sm">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#vw-replace-btn').addEventListener('click', () => {
    modal.remove();
    document.getElementById('video-wall-file-input')?.click();
  });
  modal.querySelector('#vw-remove-btn').addEventListener('click', async () => {
    await clearVideoWallpaper(S.deviceKey);
    removeVideoWallpaper();
    document.getElementById('settings-wallpaper-remove')?.classList.add('hidden');
    toast('Video wallpaper removed');
    modal.remove();
    if (onRemoved) onRemoved();
  });
  modal.querySelector('#vw-cancel-btn').addEventListener('click', () => modal.remove());
}

// ============================================================
// MEDIA PREVIEW DIALOG (WITH CAPTION SUPPORT)
// ============================================================
let _pendingMediaFiles = [];
let _pendingOnConfirm  = null;
let _updateGalleryFn   = null;

export function isCompressibleMedia(file) {
  if (!file?.type) return false;
  // Currently images (excluding animated gifs / svgs)
  if (file.type.startsWith('image/')) {
    return file.type !== 'image/gif' && file.type !== 'image/svg+xml';
  }
  return false;
}

export function isMediaPreviewOpen() {
  const overlay = document.getElementById('media-preview-overlay');
  return !!(overlay && !overlay.classList.contains('hidden'));
}

export function addMediaPreviewFiles(filesOrFile) {
  const rawList = Array.isArray(filesOrFile) ? filesOrFile : [filesOrFile];
  const valid = rawList.filter(Boolean);
  if (!valid.length) return;

  const newFiles = valid.filter(nf =>
    !_pendingMediaFiles.some(of => of.name === nf.name && of.size === nf.size && of.lastModified === nf.lastModified)
  );
  if (!newFiles.length) {
    toast('File(s) already added');
    return;
  }

  _pendingMediaFiles.push(...newFiles);
  if (_updateGalleryFn) {
    _updateGalleryFn();
  }
}

export async function showMediaPreview(filesOrFile, S, onConfirm) {
  if (isMediaPreviewOpen()) {
    addMediaPreviewFiles(filesOrFile);
    return;
  }

  if (S.mediaUploading) { toast('Please wait — upload in progress'); return; }
  if (!S.spineConfig?.accounts?.length && S.uid) {
    try {
      S.spineConfig = await getSpineConfig(S.uid);
    } catch {}
  }
  if (!S.spineConfig?.accounts?.length) {
    toast('No Drive accounts linked. Add one in Settings → Storage.');
    return;
  }

  const rawList = Array.isArray(filesOrFile) ? filesOrFile : [filesOrFile];
  _pendingMediaFiles = rawList.filter(Boolean);
  if (!_pendingMediaFiles.length) return;
  _pendingOnConfirm = onConfirm;

  let overlay = document.getElementById('media-preview-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'media-preview-overlay';
    overlay.className = 'media-preview-overlay hidden';
    overlay.innerHTML = `
      <div class="mp-backdrop"></div>
      <div class="mp-container">
        <div class="mp-header">
          <button id="mp-cancel" class="mp-cancel-btn" title="Cancel">&times;</button>
          <span class="mp-title">Send media</span>
          <div class="mp-header-actions">
            <button id="mp-add-btn" class="mp-add-btn" type="button" title="Add more files">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add</span>
            </button>
            <label id="mp-quality-wrap" class="mp-quality-wrap hidden" title="Send original uncompressed photo">
              <input type="checkbox" id="mp-quality-toggle">
              <span class="mp-quality-pill">HD Original</span>
            </label>
          </div>
        </div>
        <input type="file" id="mp-file-input" multiple
               accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
               style="display:none" aria-hidden="true">
        <div id="mp-preview-area" class="mp-preview-area"></div>
        <div class="mp-bottom">
          <input type="text" id="mp-caption" class="mp-caption" placeholder="Add a caption…" autocomplete="off">
          <button id="mp-send" class="mp-send-btn" title="Send">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 10l6-6v4h6v4H10v4z" fill="currentColor" stroke="none" transform="rotate(-45,10,10)"/>
            </svg>
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.mp-backdrop').addEventListener('click', closeMediaPreview);
    document.getElementById('mp-cancel').addEventListener('click', closeMediaPreview);

    document.getElementById('mp-add-btn')?.addEventListener('click', () => {
      document.getElementById('mp-file-input')?.click();
    });
    document.getElementById('mp-file-input')?.addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) addMediaPreviewFiles(files);
    });

    ['dragenter', 'dragover'].forEach(name => {
      overlay.addEventListener(name, e => {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.add('mp-drag-active');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      overlay.addEventListener(name, e => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragleave' && e.target !== overlay && e.target !== overlay.querySelector('.mp-backdrop')) return;
        overlay.classList.remove('mp-drag-active');
      });
    });
    overlay.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      overlay.classList.remove('mp-drag-active');
      const dropped = Array.from(e.dataTransfer?.files || []).filter(Boolean);
      if (dropped.length) {
        addMediaPreviewFiles(dropped);
      }
    });

    overlay.addEventListener('paste', e => {
      const items = Array.from(e.clipboardData?.items || []);
      const files = items.map(it => it.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        addMediaPreviewFiles(files);
      }
    });

    document.getElementById('mp-send').addEventListener('click', () => {
      const caption = document.getElementById('mp-caption')?.value?.trim() || null;
      const isOriginal = document.getElementById('mp-quality-toggle')?.checked || false;
      const files = [..._pendingMediaFiles];
      const cb = _pendingOnConfirm;
      closeMediaPreview();
      if (files.length && cb) cb(files, caption, { isOriginal });
    });
    document.getElementById('mp-caption').addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMediaPreview();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const caption = document.getElementById('mp-caption')?.value?.trim() || null;
        const isOriginal = document.getElementById('mp-quality-toggle')?.checked || false;
        const files = [..._pendingMediaFiles];
        const cb = _pendingOnConfirm;
        closeMediaPreview();
        if (files.length && cb) cb(files, caption, { isOriginal });
      }
    });
  }

  const updateGalleryOrSingle = async () => {
    if (!_pendingMediaFiles.length) {
      closeMediaPreview();
      return;
    }

    const titleEl = overlay.querySelector('.mp-title');
    if (titleEl) {
      titleEl.textContent = _pendingMediaFiles.length === 1 ? 'Send media' : `Send ${_pendingMediaFiles.length} files`;
    }

    const qualitySetting = (await settings.get('media_quality')) ?? (await settings.get('image_quality')) ?? 'compressed';
    const hasCompressible = _pendingMediaFiles.some(f => isCompressibleMedia(f));
    const qualityWrap = document.getElementById('mp-quality-wrap');
    const qualityToggle = document.getElementById('mp-quality-toggle');

    if (qualityWrap && qualityToggle) {
      if (qualitySetting === 'ask' && hasCompressible) {
        qualityWrap.classList.remove('hidden');
      } else if (qualitySetting === 'original' && hasCompressible) {
        qualityWrap.classList.add('hidden');
        qualityToggle.checked = true;
      } else {
        qualityWrap.classList.add('hidden');
        qualityToggle.checked = false;
      }
    }

    const area = document.getElementById('mp-preview-area');
    if (!area) return;
    area.innerHTML = '';

    if (_pendingMediaFiles.length === 1) {
      const file = _pendingMediaFiles[0];
      const card = document.createElement('div');
      card.className = 'mp-single-wrap';

      const remBtn = document.createElement('button');
      remBtn.className = 'mp-card-remove';
      remBtn.innerHTML = '&times;';
      remBtn.title = 'Remove';
      remBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        _pendingMediaFiles = [];
        closeMediaPreview();
      });
      card.appendChild(remBtn);

      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'mp-img-preview';
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        card.appendChild(img);
      } else if (file.type.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.className = 'mp-vid-preview';
        vid.src = URL.createObjectURL(file);
        vid.controls = true;
        vid.muted = true;
        card.appendChild(vid);
      } else if (file.type.startsWith('audio/')) {
        const icon = document.createElement('div');
        icon.className = 'mp-icon-preview';
        icon.textContent = '🎵';
        card.appendChild(icon);
      } else {
        const icon = document.createElement('div');
        icon.className = 'mp-icon-preview';
        icon.textContent = '📎';
        card.appendChild(icon);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'mp-file-name';
      nameEl.textContent = file.name;
      card.appendChild(nameEl);

      const sizeEl = document.createElement('div');
      sizeEl.className = 'mp-file-size';
      sizeEl.textContent = formatBytes(file.size);
      card.appendChild(sizeEl);

      area.appendChild(card);
    } else {
      // Multi-file gallery grid
      const gallery = document.createElement('div');
      gallery.className = 'mp-gallery';

      let totalBytes = 0;
      _pendingMediaFiles.forEach((file, index) => {
        totalBytes += file.size;
        const card = document.createElement('div');
        card.className = 'mp-gallery-card';

        const remBtn = document.createElement('button');
        remBtn.className = 'mp-card-remove';
        remBtn.innerHTML = '&times;';
        remBtn.title = 'Remove';
        remBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          _pendingMediaFiles.splice(index, 1);
          updateGalleryOrSingle();
        });
        card.appendChild(remBtn);

        if (file.type.startsWith('image/')) {
          const thumb = document.createElement('img');
          thumb.className = 'mp-gallery-thumb';
          thumb.src = URL.createObjectURL(file);
          thumb.onload = () => URL.revokeObjectURL(thumb.src);
          card.appendChild(thumb);
        } else {
          const icon = document.createElement('div');
          icon.className = 'mp-gallery-icon';
          icon.textContent = file.type.startsWith('video/') ? '🎬'
                           : file.type.startsWith('audio/') ? '🎵'
                           : '📎';
          card.appendChild(icon);
        }

        const name = document.createElement('div');
        name.className = 'mp-gallery-name';
        name.textContent = file.name;
        name.title = file.name;

        const size = document.createElement('div');
        size.className = 'mp-gallery-size';
        size.textContent = formatBytes(file.size);

        card.appendChild(name);
        card.appendChild(size);
        gallery.appendChild(card);
      });

      // Add file tile at the end of the gallery
      const addCard = document.createElement('div');
      addCard.className = 'mp-gallery-card mp-gallery-add-card';
      addCard.title = 'Add more files';
      addCard.innerHTML = `
        <div class="mp-gallery-add-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
        <div class="mp-gallery-name">Add file</div>
      `;
      addCard.addEventListener('click', () => {
        document.getElementById('mp-file-input')?.click();
      });
      gallery.appendChild(addCard);

      area.appendChild(gallery);

      const totalEl = document.createElement('div');
      totalEl.className = 'mp-total-summary';
      totalEl.textContent = `${_pendingMediaFiles.length} files · Total ${formatBytes(totalBytes)}`;
      area.appendChild(totalEl);
    }
  };

  _updateGalleryFn = updateGalleryOrSingle;
  await updateGalleryOrSingle();

  const captionInput = document.getElementById('mp-caption');
  if (captionInput) captionInput.value = '';
  overlay.classList.remove('hidden');
  setTimeout(() => captionInput?.focus(), 100);
}

export function closeMediaPreview() {
  _pendingMediaFiles = [];
  _pendingOnConfirm  = null;
  _updateGalleryFn   = null;
  const overlay = document.getElementById('media-preview-overlay');
  if (overlay) {
    overlay.classList.remove('mp-drag-active');
    overlay.classList.add('hidden');
    const area = overlay.querySelector('#mp-preview-area');
    if (area) {
      // Pause all playing videos/audios and clean up object URLs
      area.querySelectorAll('video, audio').forEach(media => {
        try {
          media.pause();
          if (media.src) {
            URL.revokeObjectURL(media.src);
            media.src = '';
            media.load();
          }
        } catch {}
      });
      area.querySelectorAll('img').forEach(img => {
        if (img.src && img.src.startsWith('blob:')) {
          URL.revokeObjectURL(img.src);
        }
      });
      area.innerHTML = '';
    }
  }
}
