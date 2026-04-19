// src/app.js
// Nexus — main application logic.

import { initDB, settings, keyStore, queue, drafts, lockStore }
  from './db.js';
import { deriveKey, generateSalt, encrypt, decrypt,
         createVerificationVector, verifyKey, passphraseStrength }
  from './crypto.js';
import { initFirebase, signInWithGoogle, getCurrentAccount, listAccounts,
         signOut, switchToAccount, updateDeviceName,
         getDefaultDeviceName, detectPlatform, detectBrowser, browserLabel,
         platformIcon, getFirebaseApp }
  from './auth.js';
import { setupProfile, registerDevice, getProfile, sendMessage as fbSendMessage,
         subscribeMessages, subscribeTyping, subscribePresence, setupPresence,
         markRead, setTyping, subscribeDevices, touchDevice,
         deleteMessage, editMessage, reactToMessage, clearTypingTimer, clearMarkedRead,
         updateDeviceAvatar, getDeviceAvatarField }
  from './realtime.js';
import { setupPIN, verifyPIN, isLockSetUp, setupBiometrics,
         authenticateBiometrics, biometricsAvailable, isBiometricsEnabled,
         lock, unlock, loadAutoLockSetting, setupVisibilityLock,
         setAutoLockMinutes, startAutoLockTimer }
  from './lock.js';
import { THEMES, applyTheme, loadTheme, saveTheme } from './themes.js';
import { saveAccentColor, clearAccentColor, saveOwnBubbleColor, clearOwnBubbleColor,
         saveOtherBubbleColor, clearOtherBubbleColor,
         saveWallpaper, clearWallpaper, applyAccentColor, applyOwnBubbleColor,
         applyOtherBubbleColor, applyWallpaper, compressWallpaper, compressAvatar,
         applyStoredAppearance, loadAppearance,
         cropImage,
         applyVideoWallpaper, removeVideoWallpaper, saveVideoWallpaper,
         loadVideoWallpaper, clearVideoWallpaper,
         startSlideshowWallpaper, stopSlideshowWallpaper,
         saveSlideshowWallpaper, loadSlideshowWallpaper, clearSlideshowWallpaper,
         saveSlideshowOpts, loadSlideshowOpts, clearSlideshowOpts } from './appearance.js';
import { cancelCurrentUpload, storeDriveToken,
         uploadFile as driveUploadFile, downloadFile as driveDownloadFile,
         deleteFile as driveDeleteFile, ensureFolder as driveEnsureFolder,
         hasDriveToken, DriveAuthError } from './drive.js';
import { getSpineConfig, saveSpineConfig, addSpineAccount, removeSpineAccount,
         getStorageSummary, getManifestEntry,
         checkAndRestoreFolders, deleteMedia, drainPendingDriveDeletes } from './spine.js';
import { prepareMediaMessage, fetchMedia, decryptThumbnail,
         buildFileBubbleHTML, formatBytes } from './media.js';

// ============================================================
// STATE
// ============================================================
const S = {
  uid:           null,
  deviceId:      null,
  deviceKey:     null,   // composite key: uid + ':' + deviceId — used for ALL per-device settings
  deviceName:    null,
  platform:      null,
  browser:       null,
  encKey:        null,
  messages:      [],
  devices:       {},
  typingDevices: [],
  presenceMap:   {},
  unsubscribers: [],
  isOnline:      navigator.onLine,
  currentScreen: 's-loading',
  config:        null,
  sendInProgress:  false,
  spineConfig:     null,
  mediaUploading:  false,
  pendingMessages: new Map(),
  avatarDataUrl:   null,
  email:           null,
};

// Per-device decrypted avatar cache: deviceId → dataUrl (or null).
// Populated lazily as devices are seen; cleared on account switch.
const _deviceAvatarCache = new Map();

// ============================================================
// DOM HELPERS
// ============================================================
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
         ('ontouchstart' in window && navigator.maxTouchPoints > 1);
}

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function show(id)      { $(id)?.classList.remove('hidden'); }
function hide(id)      { $(id)?.classList.add('hidden'); }
function toggle(id, v) { $(id)?.classList.toggle('hidden', !v); }

// ============================================================
// SCREEN MANAGER
// ============================================================
function showScreen(id) {
  if (S.currentScreen === id) return;

  const prev = $(S.currentScreen);
  const next = $(id);
  if (!next) { console.warn('[screen] Unknown screen:', id); return; }

  if (prev) {
    prev.classList.add('screen-leaving');
    setTimeout(() => {
      prev.classList.add('hidden');
      prev.classList.remove('screen-leaving', 'screen-active');
    }, 280);
  }

  next.classList.remove('hidden');
  next.classList.add('screen-entering');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      next.classList.remove('screen-entering');
      next.classList.add('screen-active');
    });
  });

  S.currentScreen = id;
  document.dispatchEvent(new CustomEvent('nexus:screenchange', { detail: id }));
}

// ============================================================
// ============================================================
// CUSTOM CONFIRM DIALOG
// Replaces window.confirm() which is silently blocked in iOS PWA
// standalone mode. Returns a Promise<boolean>.
// ============================================================
function nexusConfirm(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    // Remove any existing confirm dialog
    document.getElementById('nexus-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'nexus-confirm-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(4px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'animation:fade-in 160ms ease forwards',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:var(--surface2)', 'border:1px solid var(--border2)',
      'border-radius:var(--radius-lg)', 'padding:24px 20px 20px',
      'max-width:320px', 'width:100%',
      'box-shadow:var(--shadow)', 'display:flex', 'flex-direction:column', 'gap:16px',
    ].join(';');

    const txt = document.createElement('p');
    txt.textContent = message;
    txt.style.cssText = 'margin:0;font-size:15px;line-height:1.5;color:var(--text);text-align:center';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.style.cssText = 'flex:1;max-width:140px';

    const okBtn = document.createElement('button');
    okBtn.textContent = confirmLabel;
    okBtn.className = 'btn';
    okBtn.style.cssText = `flex:1;max-width:140px;background:${danger ? 'var(--danger)' : 'var(--accent)'};color:#fff`;

    const done = (result) => { overlay.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click',     () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });

    btnRow.append(cancelBtn, okBtn);
    panel.append(txt, btnRow);
    overlay.append(panel);
    document.body.append(overlay);
    okBtn.focus();
  });
}

// ============================================================
// CUSTOM PROMPT DIALOG
// Replaces window.prompt() which is silently blocked in iOS PWA
// standalone mode. Returns a Promise<string|null>.
// ============================================================
function nexusPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    document.getElementById('nexus-prompt-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'nexus-prompt-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(4px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'animation:fade-in 160ms ease forwards',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:var(--surface2)', 'border:1px solid var(--border2)',
      'border-radius:var(--radius-lg)', 'padding:24px 20px 20px',
      'max-width:320px', 'width:100%',
      'box-shadow:var(--shadow)', 'display:flex', 'flex-direction:column', 'gap:14px',
    ].join(';');

    const txt = document.createElement('p');
    txt.textContent = message;
    txt.style.cssText = 'margin:0;font-size:15px;line-height:1.5;color:var(--text)';

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = defaultValue;
    inp.className = 'text-input';
    inp.style.marginBottom = '0';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.style.cssText = 'flex:1;max-width:140px';

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.className = 'btn';
    okBtn.style.cssText = 'flex:1;max-width:140px;background:var(--accent);color:#fff';

    const done = result => { overlay.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => done(null));
    okBtn.addEventListener('click', () => done(inp.value));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(inp.value);
      if (e.key === 'Escape') done(null);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });

    btnRow.append(cancelBtn, okBtn);
    panel.append(txt, inp, btnRow);
    overlay.append(panel);
    document.body.append(overlay);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  });
}

// TOAST
// ============================================================
let _toastTimer = null;
function toast(msg, duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ============================================================
// FONT SIZE
// ============================================================
function applyFontSize(px) {
  document.documentElement.style.setProperty('--msg-font-size', px + 'px');
  // Avatar scales proportionally: base is 30px at 14px font.
  const avatarPx = Math.round(px * (30 / 14));
  document.documentElement.style.setProperty('--msg-avatar-size', avatarPx + 'px');
}

async function loadAndApplyFontSize(uid) {
  const stored = await settings.get(`font_size:${uid}`);
  const px = stored ?? 14;
  applyFontSize(px);
  const inp = $('settings-font-size');
  if (inp) inp.value = String(px);
}

// ============================================================
// LOADING MESSAGE
// ============================================================
function setLoading(msg) {
  const el = $('loading-msg');
  if (el) el.textContent = msg;
}

// ============================================================
// INITIALIZATION SEQUENCE
// ============================================================
async function init() {
  try {
    setLoading('Opening local storage…');
    await initDB();

    setLoading('Loading theme…');
    const themeId = await loadTheme(null);
    applyTheme(themeId);

    setLoading('Checking setup…');
    const config = await settings.get('firebase_config');
    if (!config) { showScreen('s-welcome'); return; }

    S.config = config;
    setLoading('Connecting to Firebase…');
    await initFirebase(config);

    setLoading('Checking account…');
    const account = await getCurrentAccount();
    if (!account) { showScreen('s-signin'); return; }

    const _earlyDeviceKey = `${account.uid}:${account.deviceId}`;
    const accountTheme = await loadTheme(_earlyDeviceKey);
    applyTheme(accountTheme);

    S.uid        = account.uid;
    S.deviceId   = account.deviceId;
    S.deviceName = account.deviceName;
    S.platform   = account.platform ?? detectPlatform();

    setLoading('Checking lock…');
    // Pre-load the encryption key from IndexedDB so the profile picture can be
    // decrypted and shown on the lock screen. The lock screen is UI-only
    // protection; the derived key already lives in IDB regardless.
    const earlyKeyData = await keyStore.get(account.uid);
    if (earlyKeyData?.key) S.encKey = earlyKeyData.key;

    const lockSetUp = await isLockSetUp(account.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(account.uid);
      setupVisibilityLock();
      if (S.encKey) await loadAndApplyAvatar();   // decrypt avatar before lock screen shows
      showLockScreen();
    } else {
      await tryAutoInit();
    }

    // Install prompt removed — the browser's own "Add to Home Screen" flow

    // iOS Safari ignores interactive-widget=resizes-content.
    // Use visualViewport to track the keyboard height and push the
    // fixed input area up manually via a CSS custom property.
    if (window.visualViewport) {
      const vpHandler = () => {
        const kbH = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
        document.body.style.setProperty('--keyboard-h', kbH + 'px');
        // Also nudge the s-app screen height so messages-list gets the right flex space
        const sApp = $('s-app');
        if (sApp) sApp.style.height = window.visualViewport.height + 'px';
      };
      window.visualViewport.addEventListener('resize', vpHandler, { passive: true });
      window.visualViewport.addEventListener('scroll', vpHandler, { passive: true });
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => {
          navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'NEXUS_DRAIN_QUEUE') drainQueue();
          });
        })
        .catch(e => console.warn('[sw] Registration failed:', e));
    }

  } catch (err) {
    console.error('[init]', err);
    setLoading('Something went wrong: ' + err.message);
    const loadingEl = $('s-loading');
    if (loadingEl && !loadingEl.querySelector('.retry-btn')) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost retry-btn';
      btn.style.cssText = 'margin-top:28px;max-width:200px;';
      btn.textContent = 'Try Again';
      btn.addEventListener('click', () => location.reload());
      loadingEl.appendChild(btn);
    }
  }
}

async function tryAutoInit() {
  const keyData = await keyStore.get(S.uid);
  if (keyData?.key) {
    S.encKey = keyData.key;
    const lockSetUp = await isLockSetUp(S.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(S.uid);
      setupVisibilityLock();
      await loadAndApplyAvatar();   // decrypt avatar before lock screen shows
      showLockScreen();
    } else {
      showScreen('s-pin-setup');
    }
  } else {
    showScreen('s-passphrase-entry');
  }
}

// ============================================================
// LOCK SCREEN
// ============================================================
async function showLockScreen() {
  const account = await getCurrentAccount();
  if (account) {
    const lockAv = $('lock-avatar');
    if (lockAv) {
      // Use the per-device custom avatar if set; otherwise show the username initial.
      // Never use the Google account photo — the user controls the avatar here.
      if (S.avatarDataUrl) {
        lockAv.innerHTML = `<img src="${S.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        lockAv.textContent = avatarLetter(account.deviceName ?? account.email);
      }
    }

    // Show device name (profile name) above the email
    const lockName = $('lock-name');
    if (lockName) lockName.textContent = account.deviceName ?? '';
    $('lock-email').textContent = account.email;
  }

  // Restore persisted lockout state so a page reload can't bypass the attempt limit.
  const uid = S.uid ?? account?.uid;
  if (uid) {
    try {
      const ld = await lockStore.get(uid);
      if (ld?.failedAttempts) {
        _pinAttempts = ld.failedAttempts;
        if (ld.lockedUntil && ld.lockedUntil > Date.now()) {
          _pinLockedUntil = ld.lockedUntil;
          // Restart the countdown display
          const promptEl = document.querySelector('.lock-prompt');
          if (promptEl) {
            const origText = 'Enter PIN to unlock';
            const interval = setInterval(() => {
              const left = Math.ceil((_pinLockedUntil - Date.now()) / 1000);
              if (left <= 0) { clearInterval(interval); if (promptEl) promptEl.textContent = origText; }
              else           { if (promptEl) promptEl.textContent = `Locked — wait ${left}s`; }
            }, 500);
          }
        }
        // Show passphrase fallback if already in lockout territory
        if (_pinAttempts >= 5) {
          $('lock-use-passphrase-btn')?.classList.remove('hidden');
        }
      } else {
        // Fresh show — reset in-memory counters and hide the fallback button
        _pinAttempts    = 0;
        _pinLockedUntil = 0;
        $('lock-use-passphrase-btn')?.classList.add('hidden');
      }
    } catch {
      _pinAttempts    = 0;
      _pinLockedUntil = 0;
      $('lock-use-passphrase-btn')?.classList.add('hidden');
    }
  }

  const bioAvail   = await biometricsAvailable();
  const bioEnabled = await isBiometricsEnabled(S.uid ?? account?.uid);
  toggle('lock-bio-btn',  bioAvail && bioEnabled);
  toggle('lock-bio-hint', bioAvail && bioEnabled);

  clearPINDisplay();
  showScreen('s-lock');

  // Hide the on-screen numpad — native keyboard is used on all platforms.
  $('lock-numpad')?.classList.add('hidden');
  // Always hide the static hint text; the button is more discoverable on all platforms.
  $('lock-keyboard-hint')?.classList.add('hidden');
  const kbBtn = $('lock-keyboard-btn');
  if (kbBtn) {
    kbBtn.classList.remove('hidden');
    // Relabel for pointer-based devices
    if (!isMobileDevice()) {
      kbBtn.childNodes[kbBtn.childNodes.length - 1].textContent = ' Click to type PIN';
    }
  }

  const inp = $('lock-pin-input');
  if (inp) inp.value = '';

  const dotsRow    = $('pin-dots-row');
  const newDotsRow = dotsRow?.cloneNode(true);
  const newKbBtn   = kbBtn?.cloneNode(true);
  if (dotsRow && newDotsRow) dotsRow.parentNode.replaceChild(newDotsRow, dotsRow);
  if (kbBtn   && newKbBtn)   kbBtn.parentNode.replaceChild(newKbBtn,   kbBtn);

  function focusLockInput() {
    const i = $('lock-pin-input');
    if (i) i.focus();
  }

  $('pin-dots-row')?.addEventListener('click', focusLockInput);
  $('lock-keyboard-btn')?.addEventListener('click', focusLockInput);

  if (!isMobileDevice()) setTimeout(focusLockInput, 350);

  if (bioAvail && bioEnabled) setTimeout(() => attemptBiometricUnlock(), 400);
}

async function attemptBiometricUnlock() {
  const uid = S.uid ?? (await getCurrentAccount())?.uid;
  if (!uid) return;
  try {
    const ok = await authenticateBiometrics(uid);
    if (ok) await afterUnlock(uid);
    else toast('Biometric authentication failed — enter PIN');
  } catch {
    toast('Biometrics unavailable');
  }
}

async function afterUnlock(uid) {
  const keyData = await keyStore.get(uid);
  if (!keyData?.key) {
    S.uid = uid;
    showScreen('s-passphrase-entry');
    return;
  }
  S.encKey = keyData.key;
  unlock();
  await startChat();
}

let _pinBuffer     = '';
let _pinAttempts   = 0;
let _pinLockedUntil = 0;

function clearPINDisplay() {
  _pinBuffer = '';
  updatePINDots();
  const inp = $('lock-pin-input');
  if (inp) inp.value = '';
}

function updatePINDots(state) {
  const dots = $$('.pin-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('filled', i < _pinBuffer.length);
    d.classList.remove('pin-dot-error', 'pin-dot-success');
    if (state === 'error')   d.classList.add('pin-dot-error');
    if (state === 'success') d.classList.add('pin-dot-success');
  });
}

function onPINDigit(d) {
  if (_pinBuffer.length >= 6) return;
  if (Date.now() < _pinLockedUntil) return;
  _pinBuffer += d;
  updatePINDots();
  if (_pinBuffer.length === 6) setTimeout(submitPIN, 150);
}

function onPINBackspace() {
  _pinBuffer = _pinBuffer.slice(0, -1);
  updatePINDots();
}

function onLockPINInput(e) {
  if (Date.now() < _pinLockedUntil) { e.target.value = ''; return; }
  const raw = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
  e.target.value = raw;
  _pinBuffer = raw;
  updatePINDots();
  if (_pinBuffer.length === 6) setTimeout(submitPIN, 150);
}

async function submitPIN() {
  const remaining = _pinLockedUntil - Date.now();
  if (remaining > 0) {
    toast(`Too many attempts — try again in ${Math.ceil(remaining / 1000)}s`);
    clearPINDisplay();
    return;
  }

  const uid = S.uid ?? (await getCurrentAccount())?.uid;
  if (!uid) return;
  const ok = await verifyPIN(uid, _pinBuffer);
  if (ok) {
    _pinAttempts = 0;
    // Clear persisted attempt counter on success
    try {
      const ld = await lockStore.get(uid);
      if (ld) await lockStore.set(uid, { ...ld, failedAttempts: 0, lockedUntil: 0 });
    } catch {}
    updatePINDots('success');
    setTimeout(() => afterUnlock(uid), 180);
  } else {
    _pinAttempts++;

    // Persist the attempt count so page-reload can't reset the lockout.
    try {
      const ld = await lockStore.get(uid);
      if (ld) {
        await lockStore.set(uid, {
          ...ld,
          failedAttempts: _pinAttempts,
          lockedUntil: _pinAttempts >= 5
            ? Date.now() + Math.min(30000 * Math.pow(2, _pinAttempts - 5), 300000)
            : 0,
        });
      }
    } catch {}

    updatePINDots('error');

    $('pin-dots-row')?.classList.add('shake');
    setTimeout(() => {
      $('pin-dots-row')?.classList.remove('shake');
      clearPINDisplay();
      updatePINDots();
    }, 500);

    if (_pinAttempts >= 5) {
      const lockMs = Math.min(30000 * Math.pow(2, _pinAttempts - 5), 300000);
      _pinLockedUntil = Date.now() + lockMs;
      const secs = Math.ceil(lockMs / 1000);
      toast(`Too many incorrect attempts — locked for ${secs}s`);
      const promptEl = document.querySelector('.lock-prompt');
      if (promptEl) {
        const origText = promptEl.textContent;
        const interval = setInterval(() => {
          const left = Math.ceil((_pinLockedUntil - Date.now()) / 1000);
          if (left <= 0) { clearInterval(interval); if (promptEl) promptEl.textContent = origText; }
          else           { if (promptEl) promptEl.textContent = `Locked — wait ${left}s`; }
        }, 500);
      }
      // Reveal the passphrase fallback button after the first lockout
      $('lock-use-passphrase-btn')?.classList.remove('hidden');
    } else {
      const left = 5 - _pinAttempts;
      toast(`Incorrect PIN — ${left} attempt${left !== 1 ? 's' : ''} left`);
    }
  }
}

// ============================================================
// SILENT DRIVE TOKEN REFRESH
// Google OAuth access tokens expire after ~1 hour. Firebase restores
// its own session automatically, but Drive tokens must be re-fetched
// explicitly. This function attempts a silent popup (prompt:'none')
// for each Spine account whose Drive token has expired.
// On success: fresh token stored in localStorage, no UI shown.
// On failure: silently ignored — user sees the Re-authenticate button
// in Settings → Storage when they actually need Drive.
// ============================================================
async function trySilentDriveRefresh(accounts) {
  const { GoogleAuthProvider, signInWithPopup, getAuth } =
    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
  const auth         = getAuth();
  const originalUser = auth.currentUser;

  for (const acc of accounts) {
    if (hasDriveToken(acc.driveUid)) continue;  // still valid — skip

    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/drive.file');
      provider.setCustomParameters({
        login_hint: acc.email,
        prompt:     'none',  // silent — fails instead of showing a dialog
      });

      const result = await signInWithPopup(auth, provider);
      const cred   = GoogleAuthProvider.credentialFromResult(result);
      if (cred?.accessToken) {
        storeDriveToken(acc.driveUid, cred.accessToken, 3600);
        console.log('[drive] Silently refreshed token for', acc.email);
      }

      // Always restore the original Firebase user so we don't switch sessions
      if (originalUser && result.user?.uid !== S.uid) {
        try { await auth.updateCurrentUser(originalUser); } catch {}
      }
    } catch {
      // prompt:'none' throws when silent auth isn't possible — that's expected
    }
  }
}

// ============================================================
// CHAT INITIALIZATION
// ============================================================
async function startChat() {
  const account = await getCurrentAccount();
  if (!account) { showScreen('s-signin'); return; }

  S.uid        = account.uid;
  S.deviceId   = account.deviceId;
  S.deviceKey  = `${account.uid}:${account.deviceId}`;
  S.deviceName = account.deviceName;
  S.platform   = account.platform ?? detectPlatform();
  S.browser    = account.browser  ?? detectBrowser();
  S.email      = account.email;

  $('header-avatar').textContent = avatarLetter(account.deviceName ?? account.email);
  $('header-title').textContent  = S.deviceName ?? 'Nexus';

  const draft = await drafts.get(S.uid);
  $('msg-input').value = draft ?? '';
  autoResizeInput();

  try {
    // Touch lastSeen and also write the current browser so stale Firebase
    // device records (registered before the browser field was added) get fixed.
    await touchDevice(S.uid, S.deviceId, { browser: S.browser ?? detectBrowser() });
    await setupPresence(S.uid, S.deviceId, S.deviceName);
  } catch (e) { console.warn('[presence]', e); }

  clearUnsubscribers();

  S.unsubscribers.push(subscribeMessages(S.uid, handleIncomingMessages));
  S.unsubscribers.push(subscribeTyping(S.uid, S.deviceId, devs => {
    S.typingDevices = devs;
    renderTypingIndicator();
  }));
  S.unsubscribers.push(subscribePresence(S.uid, S.deviceId, map => {
    S.presenceMap = map;
    renderOnlineStatus();
  }));
  S.unsubscribers.push(subscribeDevices(S.uid, async devMap => {
    const prevDevices = S.devices;
    S.devices = devMap;
    if (S.deviceId && S.uid && !(S.deviceId in devMap)) {
      toast('This device was removed by another device. Signing out…');
      setTimeout(async () => {
        clearUnsubscribers();
        await signOut();
        showScreen('s-signin');
      }, 2000);
    }
    if (!$('overlay-settings')?.classList.contains('hidden')) renderDevicesList();

    // ---- Patch rendered message rows when a device's name changes ----------
    // buildMessageHTML now prefers S.devices[did].name at render time, so new
    // full-rebuilds pick up the new name automatically.  For rows that are
    // already in the DOM we do a targeted patch so the user sees the update
    // immediately without waiting for the next full rebuild.
    const container = $('messages-list');
    if (container) {
      // If this is the first devices snapshot (page just loaded), S.messages has
      // likely already been rendered with an empty S.devices — force a full rebuild
      // now that real names are available. This fixes the post-refresh stale-name bug.
      const wasEmpty = Object.keys(prevDevices).length === 0;
      if (wasEmpty && S.messages.length > 0) {
        renderMessages(S.messages).catch(() => {});
      } else {
        for (const [did, dev] of Object.entries(devMap)) {
          const prev = prevDevices[did];
          if (!prev || dev.name === prev.name) continue; // name unchanged
          container.querySelectorAll('.msg-row').forEach(row => {
            const msgId = row.dataset.id;
            const msg   = S.messages.find(m => m.id === msgId);
            if (!msg || msg.deviceId !== did) return;
            // Patch the device-name badge
            const badge = row.querySelector('.msg-device');
            if (badge) {
              badge.innerHTML = `${platformIcon(dev.platform ?? 'unknown')} ${escHtml(dev.name ?? 'Unknown device')}`;
            }
            // Patch the avatar letter (only when no custom photo is cached)
            const avatarEl = row.querySelector('.msg-avatar-img');
            if (avatarEl && !_deviceAvatarCache.get(did)) {
              avatarEl.textContent = avatarLetter(dev.name ?? '?');
            }
          });
        }
      }
    }

    // Decrypt avatars for devices that have a new or changed avatar field.
    if (S.encKey) {
      let anyChanged = false;
      for (const [did, dev] of Object.entries(devMap)) {
        const prev = prevDevices[did];
        const avatarChanged = dev.avatar !== prev?.avatar;
        if (avatarChanged || (!_deviceAvatarCache.has(did) && dev.avatar)) {
          if (dev.avatar) {
            try {
              const parsed = typeof dev.avatar === 'string' ? JSON.parse(dev.avatar) : dev.avatar;
              const url = await decrypt(S.encKey, parsed.ciphertext, parsed.iv);
              _deviceAvatarCache.set(did, url);
              if (did === S.deviceId) S.avatarDataUrl = url;
              anyChanged = true;
            } catch {}
          } else if (_deviceAvatarCache.has(did)) {
            _deviceAvatarCache.delete(did);
            if (did === S.deviceId) S.avatarDataUrl = null;
            anyChanged = true;
          }
        }
      }
      if (anyChanged) updateAvatarDisplay();
    }
  }));

  window.removeEventListener('online',  onOnline);
  window.removeEventListener('offline', onOffline);
  window.addEventListener('online',     onOnline);
  window.addEventListener('offline',    onOffline);
  updateConnectivityUI();

  showScreen('s-app');
  setupLongPress();
  setupScrollToBottom();
  setupReplyQuoteClick();

  // Per-device settings (theme, appearance, font, animation, wallpaper) are now
  // keyed by S.deviceKey and stored only in local IndexedDB. They are NOT synced
  // from Firebase prefs, which are a per-account shared hint only. This ensures
  // full isolation: PC Chrome and Phone Chrome have completely independent settings.

  const themeId = await loadTheme(S.deviceKey);
  applyTheme(themeId);
  await applyStoredAppearance(S.deviceKey);
  await loadAndApplyAnimStyle(S.deviceKey);
  await loadAndApplyFontSize(S.deviceKey);
  await loadAndApplyAvatar();

  startAutoLockTimer();
  checkAndRestoreFolders(S.uid).catch(() => {});
  drainPendingDriveDeletes(S.uid).catch(() => {});

  try {
    S.spineConfig = await getSpineConfig(S.uid);
  } catch {
    S.spineConfig = { accounts: [] };
  }

  // Silently refresh any expired Drive OAuth tokens in the background.
  // Google OAuth tokens expire after ~1 hour; Firebase auto-restores its own
  // session but does not re-fetch Drive access tokens on page reload.
  // We attempt a silent sign-in (prompt:'none') — if the browser still has
  // a valid Google session cookie this succeeds without showing any popup.
  // Failures are ignored; the user can manually re-auth from Settings → Storage.
  if (S.isOnline && S.spineConfig?.accounts?.length) {
    trySilentDriveRefresh(S.spineConfig.accounts).catch(() => {});
  }

  if (S.isOnline) drainQueue();
}

function clearUnsubscribers() {
  S.unsubscribers.forEach(fn => { try { fn(); } catch {} });
  S.unsubscribers = [];
  _renderedMsgs.clear();
  _deviceAvatarCache.clear();
  S.pendingMessages.clear();
  clearTypingTimer();
  clearMarkedRead();
  clearTimeout(_typingTimeout);
  P4.editingMsgId = null;
  P4.replyToMsg   = null;
  hideReplyEditBanner();
  if (SEL.active) exitSelectMode();
}

// ============================================================
// SCROLL-TO-BOTTOM BUTTON
// ============================================================
let _unreadScrollCount = 0;

// Delegated click handler for reply-quote divs. Using a delegated listener on
// the container (rather than inline onclick) is more reliable on Android Chrome
// where inline onclick inside a touch-scrollable div can be swallowed.
function setupReplyQuoteClick() {
  const list = $('messages-list');
  if (!list || list.dataset.rqWired) return;
  list.dataset.rqWired = '1';

  // Prevent mousedown from starting a text-selection drag on the reply quote.
  // Without this, on desktop the browser treats the mousedown as the beginning
  // of a selection gesture (because .msg-bubble has user-select:text), which
  // consumes the event and the click never fires.
  // preventDefault() on mousedown blocks selection without blocking click.
  list.addEventListener('mousedown', e => {
    if (e.target.closest('[data-reply-id]')) e.preventDefault();
  });

  list.addEventListener('click', e => {
    if (SEL.active) return;
    const rq = e.target.closest('[data-reply-id]');
    if (!rq) return;
    e.stopPropagation();
    window.Nexus.scrollToMsg(rq.dataset.replyId);
  });
}

function setupScrollToBottom() {
  // Remove any existing button (account switch)
  $('scroll-to-bottom')?.remove();

  const btn = document.createElement('button');
  btn.id = 'scroll-to-bottom';
  btn.setAttribute('aria-label', 'Scroll to bottom');
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 3v10M4 8l5 5 5-5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span id="scroll-unread-badge" class="scroll-unread-badge"></span>`;

  // Append into #chat-area so the button stays inside the message area
  // and its bottom CSS offset correctly tracks the input bar gap.
  const chatArea = $('chat-area');
  if (chatArea) chatArea.appendChild(btn);

  btn.addEventListener('click', () => {
    _unreadScrollCount = 0;
    updateScrollBadge();
    scrollToBottom(true);
  });

  const list = $('messages-list');
  if (!list) return;

  list.addEventListener('scroll', () => {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    btn.classList.toggle('s2b-visible', !nearBottom);
    if (nearBottom) {
      _unreadScrollCount = 0;
      updateScrollBadge();
    }
  }, { passive: true });
}

function updateScrollBadge() {
  const badge = $('scroll-unread-badge');
  if (!badge) return;
  if (_unreadScrollCount > 0) {
    badge.textContent = _unreadScrollCount > 99 ? '99+' : String(_unreadScrollCount);
    badge.classList.add('badge-visible');
  } else {
    badge.textContent = '';
    badge.classList.remove('badge-visible');
  }
}

// ============================================================
// MESSAGES
// ============================================================
async function handleIncomingMessages(messages) {
  if (S.pendingMessages.size > 0) {
    for (const msg of messages) {
      if (msg.deviceId === S.deviceId && msg.ciphertext) {
        removePendingBubble(msg.ciphertext);
      }
    }
  }

  // Count new incoming messages from other devices for the scroll badge
  const prevVisibleIds = new Set(S.messages.filter(m => !m.deleted).map(m => m.id));
  const newOtherMsgs = messages.filter(m =>
    !m.deleted &&
    m.deviceId !== S.deviceId &&
    !prevVisibleIds.has(m.id)
  );

  S.messages = messages;
  await renderMessages(messages);

  // If new messages arrived while user is scrolled up, increment badge
  const list = $('messages-list');
  if (list && newOtherMsgs.length > 0) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (!nearBottom) {
      _unreadScrollCount += newOtherMsgs.length;
      updateScrollBadge();
    }
  }

  const unread = messages.filter(m =>
    m.deviceId !== S.deviceId &&
    m.id &&
    !m.readBy?.[S.deviceId]
  );
  for (const m of unread) {
    markRead(S.uid, m.id, S.deviceId).catch(() => {});
  }

  scrollToBottom(false);
}

// Track rendered message IDs to avoid re-rendering
const _renderedMsgs = new Map(); // msgId → { readByOthers, edited, deleted }

async function renderMessages(messages) {
  const container = $('messages-list');

  // ----------------------------------------------------------------
  // DELETED MESSAGES VANISH COMPLETELY — filter before any rendering
  // ----------------------------------------------------------------
  const visible = messages.filter(m => !m.deleted);

  if (!visible.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#128274;</div>
        <div class="empty-title">No messages yet</div>
        <div class="empty-sub">Messages are encrypted end-to-end.<br>Only your devices can read them.</div>
      </div>`;
    _renderedMsgs.clear();
    return;
  }

  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const incomingIds = visible.map(m => m.id);

  const existingIds = Array.from(container.querySelectorAll('.msg-row'))
    .map(el => el.dataset.id);

  // Full rebuild needed when:
  // - first render
  // - a message was deleted (visible count shrank — catches all deletions)
  // - order changed
  const needsFullRebuild = existingIds.length === 0 ||
    existingIds.length > incomingIds.length ||
    incomingIds.slice(0, existingIds.length).some((id, i) => id !== existingIds[i]);

  if (needsFullRebuild) {
    // Capture select state before destroying DOM — rows are about to be wiped.
    const _wasSelectActive = SEL.active;
    const _prevSelected    = _wasSelectActive ? new Set(SEL.selected) : null;
    if (_wasSelectActive) exitSelectMode();

    _renderedMsgs.clear();
    container.classList.add('anim-none');

    // Preserve scroll position when the user is scrolled up (e.g. a message was
    // deleted or edited while they were reading history). Only force-jump to the
    // bottom on the very first render or when already near the bottom.
    const isFirstRender  = existingIds.length === 0;
    const atBottom = isFirstRender ||
      (container.scrollHeight - container.scrollTop - container.clientHeight < 160);
    const prevScrollTop    = container.scrollTop;
    const prevScrollHeight = container.scrollHeight;

    const decrypted = await decryptBatch(visible);
    container.innerHTML = buildFullHTML(decrypted);

    if (atBottom) {
      scrollToBottom(true);
    } else {
      container.scrollTop = prevScrollTop - (prevScrollHeight - container.scrollHeight);
    }

    // Restore select mode if it was active before the rebuild.
    if (_wasSelectActive && _prevSelected) {
      enterSelectMode(null);
      const newVisibleIds = new Set(visible.map(m => m.id));
      for (const id of _prevSelected) {
        if (!newVisibleIds.has(id)) continue;
        SEL.selected.add(id);
        const row = container.querySelector(`.msg-row[data-id="${CSS.escape(id)}"]`);
        if (row) row.classList.add('msg-selected');
      }
      updateSelectToolbar();
    }

    requestAnimationFrame(() => container.classList.remove('anim-none'));
    for (const msg of decrypted) {
      if (msg.type === 'image' && msg.encThumb && S.encKey) loadThumbnailAsync(msg);
      if ((!msg.type || msg.type === 'text') && msg.id) {
        const url = extractFirstUrl(msg._decryptedText ?? msg.text ?? '');
        if (url) injectLinkPreview(msg.id, url).catch(() => {});
      }
    }
    return;
  }

  // ----------------------------------------------------------------
  // Incremental update — patch existing rows (ticks, reactions, edits)
  // ----------------------------------------------------------------
  const newMsgs = visible.slice(existingIds.length);

  for (const msg of visible.slice(0, existingIds.length)) {
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    const prev = _renderedMsgs.get(msg.id);
    if (!prev) continue;

    const row = container.querySelector(`.msg-row[data-id="${msg.id}"]`);
    if (!row) continue;

    // Patch read tick
    if (prev.readByOthers !== readByOthers) {
      const tickEl = row.querySelector('.read-tick');
      if (tickEl) {
        tickEl.className = `read-tick${readByOthers ? ' read' : ''}`;
        tickEl.innerHTML = readByOthers ? '&#10003;&#10003;' : '&#10003;';
      }
      prev.readByOthers = readByOthers;
    }

    // Patch reactions
    const reactEl = row.querySelector('.msg-reactions');
    const newReactHTML = buildReactionsHTML(msg.reactions, msg.id);
    const prevReactHTML = reactEl ? reactEl.outerHTML : '';
    if (newReactHTML !== prevReactHTML) {
      if (reactEl) reactEl.remove();
      if (newReactHTML) {
        const meta = row.querySelector('.msg-meta');
        if (meta) meta.insertAdjacentHTML('beforebegin', newReactHTML);
      }
    }

    // Patch edit — rebuild this row when first edited
    if (!!msg.edited && !prev.edited) {
      prev.edited = true;
      const hadDeviceBadge = !!row.querySelector('.msg-device');
      const decrypted = await decryptBatch([msg]);
      const isOwn = msg.deviceId === S.deviceId;
      const ts    = msg.timestamp ? new Date(msg.timestamp) : new Date();
      const time  = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });
      const newRowHTML = buildMessageHTML(decrypted[0], isOwn, hadDeviceBadge, time, readByOthers);
      const tmp = document.createElement('div');
      tmp.innerHTML = newRowHTML;
      row.replaceWith(tmp.firstElementChild);
    }
  }

  if (!newMsgs.length) return;

  // Register existing messages in _renderedMsgs so future patches work.
  // (Full rebuild already registers them; incremental appends did not — BUG FIX)
  for (const msg of visible.slice(0, existingIds.length)) {
    if (!_renderedMsgs.has(msg.id)) {
      const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
      _renderedMsgs.set(msg.id, { readByOthers, edited: !!msg.edited, deleted: false });
    }
  }

  // ----------------------------------------------------------------
  // Append new messages to the bottom
  // ----------------------------------------------------------------
  const decryptedNew = await decryptBatch(newMsgs);

  const lastExistingMsg = visible[existingIds.length - 1];
  let lastDevice = lastExistingMsg?.deviceId ?? '';
  let lastDate   = '';
  if (existingIds.length > 0 && lastExistingMsg?.timestamp) {
    lastDate = new Date(lastExistingMsg.timestamp)
      .toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  }

  let html = '';
  for (const msg of decryptedNew) {
    const isOwn = msg.deviceId === S.deviceId;
    const ts    = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const date  = ts.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    const time  = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

    if (date !== lastDate) {
      html += `<div class="date-sep"><span>${date}</span></div>`;
      lastDate   = date;
      lastDevice = '';
    }

    const showDeviceName = !isOwn && msg.deviceId !== lastDevice;
    lastDevice = msg.deviceId;
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers);
  }

  container.insertAdjacentHTML('beforeend', html);

  // Register newly appended messages in _renderedMsgs (BUG FIX — was missing before)
  for (const msg of decryptedNew) {
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    _renderedMsgs.set(msg.id, { readByOthers, edited: !!msg.edited, deleted: false });
  }

  // Async thumbnail loads and link previews
  for (const msg of decryptedNew) {
    if (msg.type === 'image' && msg.encThumb && S.encKey) loadThumbnailAsync(msg);
    if ((!msg.type || msg.type === 'text') && msg.id) {
      const url = extractFirstUrl(msg._decryptedText ?? msg.text ?? '');
      if (url) injectLinkPreview(msg.id, url).catch(() => {});
    }
  }
}

async function decryptBatch(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.deleted) {
      out.push({ ...msg, text: null, isDeleted: true });
      continue;
    }
    try {
      const text = await decrypt(S.encKey, msg.ciphertext, msg.iv);
      const live = S.messages.find(m => m.id === msg.id);
      if (live) live._decryptedText = text;
      out.push({ ...msg, text, _decryptedText: text });
    } catch {
      out.push({ ...msg, text: '[Unable to decrypt]', decryptError: true });
    }
  }
  return out;
}

function buildFullHTML(decrypted) {
  let html = '', lastDate = '', lastDevice = '';
  for (const msg of decrypted) {
    const isOwn = msg.deviceId === S.deviceId;
    const ts   = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const date = ts.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    const time = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

    if (date !== lastDate) {
      html += `<div class="date-sep"><span>${date}</span></div>`;
      lastDate = date; lastDevice = '';
    }

    const showDeviceName = !isOwn && msg.deviceId !== lastDevice;
    lastDevice = msg.deviceId;
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    _renderedMsgs.set(msg.id, { readByOthers, edited: !!msg.edited, deleted: false });
    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers);
  }
  return html;
}

function loadThumbnailAsync(msg) {
  decryptThumbnail(S.encKey, msg.encThumb).then(thumb => {
    if (!thumb) return;
    const el = document.getElementById(`thumb-${msg.id}`);
    if (!el) return;
    el.innerHTML = `<img class="msg-thumb" src="${thumb}" alt="${escHtml(msg.fileName ?? 'Image')}"
      loading="lazy" onclick="Nexus.openMedia('${escHtml(msg.uuid)}')">
      <div class="media-caption">${escHtml(msg.fileName ?? '')}</div>`;
  }).catch(() => {});
}

function buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers) {
  const side        = isOwn ? 'own' : 'other';
  const devPlatform = S.devices[msg.deviceId]?.platform ?? 'unknown';
  // Always prefer the live device-record name so that username renames are
  // reflected retroactively in already-rendered message rows on the next
  // full rebuild, and in all new incremental appends.
  const liveName    = S.devices[msg.deviceId]?.name ?? msg.deviceName ?? 'Unknown device';

  let replyQuote = '';
  if (msg.replyTo) {
    const quoted = S.messages.find(m => m.id === msg.replyTo);
    const qName  = S.devices[quoted?.deviceId]?.name ?? quoted?.deviceName ?? 'Unknown';

    let qText;
    if (!quoted || quoted.deleted) {
      qText = quoted?.deleted ? 'Message deleted' : '…';
    } else {
      const type = quoted.type;
      // Media messages encrypt a JSON descriptor as ciphertext — _decryptedText
      // will be that raw JSON string, not human-readable. Detect it and use a
      // friendly label instead.
      const rawDecrypted = quoted._decryptedText ?? '';
      const isMediaJson  = (type === 'image' || type === 'file') &&
                           rawDecrypted.startsWith('{');
      if (isMediaJson || !rawDecrypted) {
        qText = type === 'image' ? '📷 Photo'
              : type === 'file'  ? `📎 ${escHtml(quoted.fileName ?? 'File')}`
              : '…';
      } else {
        qText = escHtml(rawDecrypted.slice(0, 80));
      }
    }

    replyQuote = `<div class="reply-quote" data-reply-id="${escHtml(msg.replyTo)}" style="cursor:pointer">
      <div class="rq-name">${escHtml(qName)}</div>
      <div class="rq-text">${qText}</div>
    </div>`;
  }

  let content = '';
  if (msg.decryptError) {
    content = `<span class="decrypt-error">${escHtml(msg.text)}</span>`;
  } else if (msg.type === 'image' && msg.uuid) {
    const thumbId = `thumb-${escHtml(msg.id)}`;
    content = `<div id="${thumbId}" class="media-bubble media-image" data-uuid="${escHtml(msg.uuid)}">
      <div class="media-placeholder" onclick="Nexus.openMedia('${escHtml(msg.uuid)}')">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        <span>${escHtml(msg.fileName ?? 'Image')}</span>
      </div>
    </div>`;
  } else if (msg.type === 'file' && msg.uuid) {
    content = buildFileBubbleHTML(msg);
  } else {
    content = formatText(escHtml(msg.text ?? ''));
  }

  const editedLabel   = msg.edited ? `<span class="msg-edited">edited</span>` : '';
  const reactionsHTML = buildReactionsHTML(msg.reactions, msg.id);

  const deviceBadge = showDeviceName
    ? `<div class="msg-device">${platformIcon(devPlatform)} ${escHtml(liveName)}</div>`
    : '';

  const readTick = isOwn
    ? `<span class="read-tick ${readByOthers ? 'read' : ''}" title="${readByOthers ? 'Read' : 'Sent'}">
        ${readByOthers ? '&#10003;&#10003;' : '&#10003;'}
       </span>`
    : '';

  const avatarHtml = !isOwn ? (() => {
    if (showDeviceName) {
      const devAvatar = _deviceAvatarCache.get(msg.deviceId);
      const imgInner  = devAvatar
        ? `<img src="${devAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;">`
        : avatarLetter(S.devices[msg.deviceId]?.name ?? msg.deviceName ?? '?');
      return `<div class="msg-avatar-col"><div class="msg-avatar-img">${imgInner}</div></div>`;
    }
    return `<div class="msg-avatar-spacer"></div>`;
  })() : '';

  const bubbleHtml = `
    <div class="msg-bubble">
      ${replyQuote}
      ${content}
      ${reactionsHTML}
      <div class="msg-meta">
        ${editedLabel}
        <span class="msg-time">${time}</span>
        ${readTick}
      </div>
    </div>`;

  const innerHtml = !isOwn
    ? `<div class="msg-with-avatar">${avatarHtml}${bubbleHtml}</div>`
    : bubbleHtml;

  return `
    <div class="msg-row ${side}" data-id="${escHtml(msg.id)}">
      ${deviceBadge}
      ${innerHtml}
    </div>`;
}

// ============================================================
// MEDIA OPEN
// ============================================================
window.Nexus = window.Nexus ?? {};

window.Nexus.openMedia = async function(uuid) {
  if (!S.encKey || !S.uid) return;
  try {
    const entry = await getManifestEntry(S.uid, uuid);
    if (!entry) { toast('Media not found'); return; }
    const url = await fetchMedia(S.uid, S.encKey, uuid);
    if (entry.mimeType?.startsWith('image/')) {
      showLightbox(url, entry.fileName);
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = entry.fileName ?? 'download'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    toast('Could not load media: ' + err.message);
  }
};

function showLightbox(url, title) {
  let lb = document.getElementById('media-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'media-lightbox';
    lb.innerHTML = `
      <div class="lb-backdrop"></div>
      <div class="lb-content">
        <button class="lb-close">&times;</button>
        <img id="lb-img" src="" alt="">
        <div id="lb-title" class="lb-title"></div>
      </div>`;
    document.body.appendChild(lb);

    const closeLightbox = () => {
      const activeUrl = lb.dataset.activeUrl;
      if (activeUrl) { URL.revokeObjectURL(activeUrl); delete lb.dataset.activeUrl; }
      lb.querySelector('#lb-img').src = '';
      lb.classList.add('hidden');
    };
    lb.querySelector('.lb-backdrop').addEventListener('click', closeLightbox);
    lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !lb.classList.contains('hidden')) closeLightbox();
    });
    let _touchStartY = 0;
    lb.addEventListener('touchstart', e => { _touchStartY = e.touches[0].clientY; }, { passive: true });
    lb.addEventListener('touchend', e => {
      if (e.changedTouches[0].clientY - _touchStartY > 80) closeLightbox();
    }, { passive: true });
  }

  if (lb.dataset.activeUrl) URL.revokeObjectURL(lb.dataset.activeUrl);
  lb.dataset.activeUrl = url;
  lb.querySelector('#lb-img').src = url;
  lb.querySelector('#lb-title').textContent = title ?? '';
  lb.classList.remove('hidden');
}

function formatText(escaped) {
  return escaped
    .replace(/\*([^*\n]+)\*/g,    '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g,      '<em>$1</em>')
    .replace(/`([^`\n]+)`/g,      '<code>$1</code>')
    .replace(/https?:\/\/[^\s<>"]+/g, url =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\n/g, '<br>');
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// SEND MEDIA
// ============================================================
async function handleMediaSend(file) {
  if (S.mediaUploading) { toast('Please wait — upload in progress'); return; }
  if (!S.spineConfig?.accounts?.length) {
    toast('No Drive accounts linked. Add one in Settings → Storage.');
    return;
  }

  S.mediaUploading = true;
  setSendBtnState(false);
  const attachBtn = $('attach-btn');
  if (attachBtn) attachBtn.disabled = true;
  showUploadProgress(0);

  try {
    const mediaPayload = await prepareMediaMessage(S.uid, S.encKey, file, updateUploadProgress);
    const metaText = JSON.stringify({
      uuid:      mediaPayload.uuid,
      mediaType: mediaPayload.mediaType,
      fileName:  mediaPayload.fileName,
      fileSize:  mediaPayload.fileSize,
      mimeType:  mediaPayload.mimeType,
    });
    const { ciphertext, iv } = await encrypt(S.encKey, metaText);

    const payload = {
      ciphertext,
      iv,
      type:       mediaPayload.mediaType,
      deviceId:   S.deviceId,
      deviceName: S.deviceName,
      uuid:       mediaPayload.uuid,
      fileName:   mediaPayload.fileName,
      fileSize:   mediaPayload.fileSize,
      mimeType:   mediaPayload.mimeType,
      encThumb:   mediaPayload.encThumb,
    };

    if (S.isOnline) {
      await fbSendMessage(S.uid, payload);
      toast('Sent');
    } else {
      await queue.add(S.uid, payload);
      toast('Queued — will send when online');
    }
  } catch (err) {
    console.error('[media send]', err);
    toast(err.message === 'Upload cancelled' ? 'Upload cancelled' : 'Upload failed: ' + err.message);
  } finally {
    hideUploadProgress();
    S.mediaUploading = false;
    setSendBtnState(true);
    if (attachBtn) attachBtn.disabled = false;
  }
}

// ============================================================
// SEND MESSAGE
// ============================================================
async function handleSend() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || S.sendInProgress) return;

  if (P4.editingMsgId) { await commitEdit(); return; }

  S.sendInProgress = true;
  setSendBtnState(false);

  const replyTo = P4.replyToMsg ? P4.replyToMsg.id : null;
  if (P4.replyToMsg) { P4.replyToMsg = null; hideReplyEditBanner(); }

  input.value = '';
  autoResizeInput();
  await drafts.delete(S.uid);
  try { await setTyping(S.uid, S.deviceId, false); } catch {}

  try {
    const { ciphertext, iv } = await encrypt(S.encKey, text);
    const payload = {
      ciphertext,
      iv,
      type:       'text',
      deviceId:   S.deviceId,
      deviceName: S.deviceName,
      ...(replyTo ? { replyTo } : {}),
    };

    renderPendingBubble(payload, text);

    try {
      await fbSendMessage(S.uid, payload);
    } catch (err) {
      await queue.add(S.uid, payload);
      toast('No connection — will send when online');
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg.sync) reg.sync.register('nexus-send-queue').catch(() => {});
      }
    }
  } catch (err) {
    console.error('[send]', err);
    toast('Failed to send message');
    input.value = text;
  } finally {
    S.sendInProgress = false;
    setSendBtnState(true);
  }
}

function setSendBtnState(enabled) {
  const btn = $('send-btn');
  if (btn) btn.disabled = !enabled;
}

// ============================================================
// PENDING (OPTIMISTIC) BUBBLE
// ============================================================
function renderPendingBubble(payload, plaintextForDisplay) {
  const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now     = new Date();
  const time    = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

  S.pendingMessages.set(payload.ciphertext, localId);

  const container = $('messages-list');
  if (!container) return;
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  container.insertAdjacentHTML('beforeend', `
    <div class="msg-row own pending-bubble" data-pending-id="${localId}" data-id="${localId}">
      <div class="msg-bubble">
        ${formatText(escHtml(plaintextForDisplay))}
        <div class="msg-meta">
          <span class="msg-time">${time}</span>
          <span class="read-tick pending-tick" title="Pending">&#128336;</span>
        </div>
      </div>
    </div>`);
  scrollToBottom(true);
  return localId;
}

function removePendingBubble(ciphertext) {
  const localId = S.pendingMessages.get(ciphertext);
  if (!localId) return;
  S.pendingMessages.delete(ciphertext);
  document.querySelector(`.pending-bubble[data-pending-id="${localId}"]`)?.remove();
}

// ============================================================
// UPLOAD PROGRESS
// ============================================================
function showUploadProgress(frac) {
  $('upload-progress-wrap')?.classList.remove('hidden');
  const p = Math.round(frac * 100);
  const fill = $('upload-progress-fill');
  const pct  = $('upload-progress-pct');
  if (fill) fill.style.width = p + '%';
  if (pct)  pct.textContent  = p + '%';
}

function updateUploadProgress(frac) {
  const p = Math.round(frac * 100);
  const fill = $('upload-progress-fill');
  const pct  = $('upload-progress-pct');
  if (fill) fill.style.width = p + '%';
  if (pct)  pct.textContent  = p + '%';
}

function hideUploadProgress() {
  $('upload-progress-wrap')?.classList.add('hidden');
  const fill = $('upload-progress-fill');
  if (fill) fill.style.width = '0%';
}

// ============================================================
// PROFILE PICTURE
// ============================================================
async function loadAndApplyAvatar() {
  if (!S.uid || !S.encKey || !S.deviceId) return;
  try {
    // Primary: device-specific avatar (new per-device storage)
    let encAvatar = await getDeviceAvatarField(S.uid, S.deviceId);

    // Migration: if no device avatar yet, check legacy profile-level avatar
    // and move it to the device record so other devices stop seeing it.
    if (!encAvatar) {
      const profile = await getProfile(S.uid);
      if (profile?.avatar) {
        encAvatar = profile.avatar;
        // Migrate silently — store under the device record; leave profile copy
        // so other already-loaded clients don't lose their cached value.
        await updateDeviceAvatar(S.uid, S.deviceId,
          typeof encAvatar === 'string' ? encAvatar : JSON.stringify(encAvatar));
      }
    }

    if (encAvatar) {
      const parsed = typeof encAvatar === 'string' ? JSON.parse(encAvatar) : encAvatar;
      S.avatarDataUrl = await decrypt(S.encKey, parsed.ciphertext, parsed.iv);
    } else {
      S.avatarDataUrl = null;
    }
    _deviceAvatarCache.set(S.deviceId, S.avatarDataUrl);
  } catch {
    S.avatarDataUrl = null;
  }
  updateAvatarDisplay();
}

function updateAvatarDisplay() {
  const letter = avatarLetter(S.deviceName ?? S.email ?? '');
  const imgHtml = S.avatarDataUrl
    ? `<img src="${S.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
    : letter;

  const headerEl = $('header-avatar');
  if (headerEl) {
    if (S.avatarDataUrl) headerEl.innerHTML = imgHtml;
    else headerEl.textContent = letter;
  }
  const settingsEl = $('settings-avatar-preview');
  if (settingsEl) {
    if (S.avatarDataUrl) settingsEl.innerHTML = imgHtml;
    else settingsEl.textContent = letter;
  }
  $('settings-avatar-remove-btn')?.classList.toggle('hidden', !S.avatarDataUrl);

  // Update every other-device avatar bubble using the per-device cache.
  // Each message's avatar corresponds to its sender's device, not the local device.
  document.querySelectorAll('.msg-avatar-img').forEach(el => {
    const row   = el.closest('.msg-row');
    const msgId = row?.dataset.id;
    const msg   = S.messages.find(m => m.id === msgId);
    if (!msg) return;
    const devAvatar = _deviceAvatarCache.get(msg.deviceId);
    if (devAvatar) {
      el.innerHTML = `<img src="${devAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      el.textContent = avatarLetter(S.devices[msg.deviceId]?.name ?? msg.deviceName ?? '?');
    }
  });

  // Always update lock screen name and avatar — whether or not a photo is set.
  // This ensures username renames are immediately reflected on the lock screen
  // and that the photo shows up after an in-session avatar upload.
  const lockName = $('lock-name');
  if (lockName) lockName.textContent = S.deviceName ?? '';
  const lockAv = $('lock-avatar');
  if (lockAv) {
    if (S.avatarDataUrl) {
      lockAv.innerHTML = `<img src="${S.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      lockAv.textContent = avatarLetter(S.deviceName ?? S.email ?? '');
    }
  }

  // Refresh linked-devices list if it's open
  if (!$('overlay-settings')?.classList.contains('hidden')) renderDevicesList();
}

// ============================================================
// OFFLINE QUEUE DRAIN
// ============================================================
async function drainQueue() {
  if (!S.uid || !S.encKey || !S.isOnline) return;
  const items = await queue.byAccount(S.uid);
  if (!items.length) return;

  let sent = 0;
  for (const item of items) {
    try {
      await fbSendMessage(S.uid, item.payload);
      await queue.remove(item.id);
      sent++;
    } catch (err) {
      console.warn('[queue] Send failed, will retry:', err);
      break;
    }
  }
  if (sent) toast(`${sent} queued message${sent > 1 ? 's' : ''} sent`);
}

// ============================================================
// CONNECTIVITY
// ============================================================
function onOnline()  { S.isOnline = true;  updateConnectivityUI(); drainQueue(); }
function onOffline() { S.isOnline = false; updateConnectivityUI(); }

function updateConnectivityUI() {
  const dot = $('status-dot');
  if (!dot) return;
  dot.classList.toggle('offline', !S.isOnline);
  dot.title = S.isOnline ? 'Connected' : 'Offline';
}

// ============================================================
// TYPING INDICATOR
// ============================================================
function renderTypingIndicator() {
  const el = $('typing-indicator');
  if (!el) return;
  if (!S.typingDevices.length) { el.classList.add('hidden'); return; }

  const names = S.typingDevices.map(did => {
    const pres = S.presenceMap[did];
    const dev  = S.devices[did];
    return pres?.deviceName ?? dev?.name ?? 'Another device';
  });

  el.textContent = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.length} devices are typing…`;
  el.classList.remove('hidden');
}

// ============================================================
// ONLINE STATUS
// ============================================================
function renderOnlineStatus() {
  const STALE_MS = 3 * 60 * 1000;
  const now = Date.now();
  const onlineDevices = Object.values(S.presenceMap).filter(p =>
    p.online && (!p.lastSeen || (now - p.lastSeen) < STALE_MS)
  );
  const uniqueNames = [...new Set(onlineDevices.map(p => p.deviceName ?? 'device'))];

  const sub = $('header-sub');
  if (!sub) return;
  if (uniqueNames.length) {
    sub.textContent = uniqueNames.length === 1
      ? `${uniqueNames[0]} online`
      : `${uniqueNames.join(', ')} online`;
    sub.classList.remove('hidden');
  } else {
    sub.classList.add('hidden');
  }
}

// ============================================================
// SCROLL
// ============================================================
function scrollToBottom(force) {
  const list = $('messages-list');
  if (!list) return;

  const doScroll = () => {
    if (force) {
      list.scrollTop = list.scrollHeight;
    } else {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      doScroll();
      if (force) {
        setTimeout(doScroll, 150);
        setTimeout(doScroll, 600);
      }
    });
  });
}

// ============================================================
// INPUT AREA
// ============================================================
function autoResizeInput() {
  const el = $('msg-input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

let _typingTimeout = null;
function onInputChange() {
  autoResizeInput();
  const val = $('msg-input').value;
  if (S.uid) drafts.set(S.uid, val).catch(() => {});

  if (S.uid && S.deviceId && val.trim()) {
    setTyping(S.uid, S.deviceId, true).catch(() => {});
    clearTimeout(_typingTimeout);
    _typingTimeout = setTimeout(() => setTyping(S.uid, S.deviceId, false).catch(() => {}), 4000);
  } else if (S.uid && S.deviceId) {
    clearTimeout(_typingTimeout);
    setTyping(S.uid, S.deviceId, false).catch(() => {});
  }
}

// ============================================================
// ACCOUNT SWITCHER
// ============================================================
async function openAccountSwitcher() {
  const accounts = await listAccounts();
  const list     = $('account-list');
  list.innerHTML = accounts.map(a => `
    <div class="account-row ${a.isCurrentAccount ? 'current' : ''}"
         data-switch-uid="${escHtml(a.uid)}">
      <div class="account-avatar">${avatarLetter(a.email)}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(a.displayName ?? a.email)}</div>
        <div class="account-email">${escHtml(a.email)}</div>
        <div class="account-device">${platformIcon(a.platform ?? 'unknown')} ${escHtml(a.deviceName)}</div>
      </div>
      ${a.isCurrentAccount ? '<div class="account-current-badge">Active</div>' : ''}
    </div>`
  ).join('');

  // Use delegated click on the list container — inline onclick is unreliable
  // on Android Chrome inside a touch-scrollable div.
  list.onclick = e => {
    const row = e.target.closest('[data-switch-uid]');
    if (row) window.Nexus.switchAccount(row.dataset.switchUid);
  };

  show('overlay-accounts');
  pushBackEntry();
}

window.Nexus.switchAccount = async function(uid) {
  if (uid === S.uid) { hide('overlay-accounts'); return; }
  try {
    hide('overlay-accounts');
    showScreen('s-loading');
    setLoading('Switching account…');

    clearUnsubscribers();
    await switchToAccount(uid);

    S.uid = uid;
    const account = await getCurrentAccount();
    S.deviceId   = account.deviceId;
    S.deviceKey  = `${account.uid}:${account.deviceId}`;
    S.deviceName = account.deviceName;
    S.browser    = account.browser ?? detectBrowser();
    S.encKey     = null;

    const keyData = await keyStore.get(uid);
    if (keyData?.key) {
      S.encKey = keyData.key;
      await loadAutoLockSetting(uid);
      await startChat();
    } else {
      showScreen('s-passphrase-entry');
    }
  } catch (err) {
    toast('Switch failed: ' + err.message);
    showScreen('s-signin');
  }
};

// ============================================================
// STORAGE SUMMARY
// ============================================================
async function renderStorageSummary() {
  const el = $('storage-summary');
  if (!el) return;
  try {
    const summary = await getStorageSummary(S.uid);
    if (!summary.length) {
      el.innerHTML = `<div class="storage-empty">No Drive accounts linked yet.</div>`;
      return;
    }
    el.innerHTML = summary.map(acc => `
      <div class="storage-row">
        <div class="storage-account-info">
          <div class="storage-email">${escHtml(acc.email)}</div>
          <div class="storage-bar-wrap">
            <div class="storage-bar" style="width:${Math.min(100, acc.nexusUsed / acc.cap * 100).toFixed(1)}%"></div>
          </div>
          <div class="storage-numbers">
            Nexus: ${formatBytes(acc.nexusUsed)} / ${formatBytes(acc.cap)}
            ${acc.driveQuota ? ` &nbsp;·&nbsp; Drive free: ${formatBytes(acc.driveQuota.free)}` : ''}
            ${!acc.authOk ? ` &nbsp;<button class="storage-reauth-btn" onclick="Nexus.reAuthDrive('${escHtml(acc.driveUid)}')">Re-authenticate</button>` : ''}
            &nbsp;·&nbsp; <button class="storage-reauth-btn" onclick="Nexus.editDriveCap('${escHtml(acc.driveUid)}', ${acc.cap})">Edit cap</button>
          </div>
        </div>
        <button class="btn-remove-drive" onclick="Nexus.removeSpineDrive('${escHtml(acc.driveUid)}')" title="Remove">&times;</button>
      </div>`
    ).join('');
  } catch {
    el.innerHTML = `<div class="storage-empty">Could not load storage info.</div>`;
  }
}

window.Nexus.reAuthDrive = async function(driveUid) {
  try {
    const { GoogleAuthProvider, signInWithPopup, getAuth } =
      await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
    const config = await getSpineConfig(S.uid);
    const acc = config.accounts.find(a => a.driveUid === driveUid);
    if (!acc) { toast('Account not found in Spine'); return; }

    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    provider.setCustomParameters({ login_hint: acc.email });

    const auth = getAuth();
    const originalUser = auth.currentUser;
    const result = await signInWithPopup(auth, provider);
    const cred   = GoogleAuthProvider.credentialFromResult(result);

    if (result.user.uid !== S.uid && originalUser) {
      try { await auth.updateCurrentUser(originalUser); } catch {}
    }

    if (cred?.accessToken) {
      storeDriveToken(driveUid, cred.accessToken, 3600);
      S.spineConfig = await getSpineConfig(S.uid);
      toast('Drive account re-authenticated');
      renderStorageSummary();
      // Flush any Drive files that couldn't be deleted while this token was expired
      drainPendingDriveDeletes(S.uid).catch(() => {});
    } else {
      toast('Could not get Drive access — try again');
    }
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    toast('Re-auth failed: ' + err.message);
  }
};

window.Nexus.removeSpineDrive = async function(driveUid) {
  if (!await nexusConfirm('Remove this Drive account from your Spine? Files on it will become inaccessible.', { confirmLabel: 'Remove', danger: true })) return;
  try {
    await removeSpineAccount(S.uid, driveUid);
    S.spineConfig = await getSpineConfig(S.uid);
    toast('Drive account removed');
    renderStorageSummary();
  } catch (err) {
    toast('Error: ' + err.message);
  }
};

// ============================================================
// SETTINGS PANEL
// ============================================================
async function openSettings() {
  const grid = $('theme-grid');
  if (grid) {
    grid.innerHTML = Object.entries(THEMES).map(([id, t]) => `
      <button class="theme-swatch ${document.documentElement.getAttribute('data-theme') === id ? 'active' : ''}"
              onclick="Nexus.setTheme('${id}')"
              title="${t.label}"
              style="background:${t.vars['--bg']};border-color:${t.vars['--accent']}">
        <div class="swatch-bubble" style="background:${t.vars['--own-bg']}"></div>
        <div class="swatch-label" style="color:${t.vars['--text']}">${t.label}</div>
      </button>`
    ).join('');
  }

  const devInput = $('settings-device-name');
  if (devInput) devInput.value = S.deviceName ?? '';

  let lockData = null;
  try { lockData = await lockStore.get(S.uid); } catch {}
  const autolockSel = $('settings-autolock');
  if (autolockSel && lockData?.autoLockMinutes !== undefined) {
    autolockSel.value = String(lockData.autoLockMinutes);
  }

  updateAvatarDisplay();

  const { accent, ownBubble, otherBubble, wallpaper } = await loadAppearance(S.deviceKey);
  const thId       = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
  const accentPicker = $('settings-accent-color');
  if (accentPicker) accentPicker.value = accent ?? (THEMES[thId]?.vars['--accent'] ?? '#8b5cf6');
  const bubblePicker = $('settings-own-bubble-color');
  if (bubblePicker) bubblePicker.value = ownBubble ?? (THEMES[thId]?.vars['--own-bg'] ?? '#6d44d4');
  const otherPicker = $('settings-other-bubble-color');
  if (otherPicker) otherPicker.value = otherBubble ?? (THEMES[thId]?.vars['--other-bg'] ?? '#141422');

  const videoUrl = await loadVideoWallpaper(S.deviceKey);
  const slides   = await loadSlideshowWallpaper(S.deviceKey);
  const hasWall  = !!(wallpaper || videoUrl || slides.length);
  const wpPreview = $('settings-wallpaper-preview');
  if (wpPreview) {
    if (wallpaper && !videoUrl && !slides.length) { wpPreview.src = wallpaper; wpPreview.classList.remove('hidden'); }
    else wpPreview.classList.add('hidden');
  }
  $('settings-wallpaper-remove')?.classList.toggle('hidden', !hasWall);

  const storedInterval = await settings.get(`anim_slideshow_interval:${S.deviceKey}`);
  const intSel = $('settings-slideshow-interval');
  if (intSel && storedInterval) intSel.value = String(storedInterval);
  $('slideshow-settings-block')?.classList.toggle('hidden', !slides.length);

  // Load and display current transition settings
  if (slides.length) {
    const opts = await loadSlideshowOpts(S.deviceKey);
    const tranSel = $('settings-slideshow-transition');
    if (tranSel) tranSel.value = opts.transition;
    const durSel = $('settings-slideshow-duration');
    if (durSel) durSel.value = String(opts.duration ?? 800);
    const isWaterdrop = opts.transition === 'waterdrop';
    $('slideshow-waterdrop-row')?.classList.toggle('hidden', !isWaterdrop);
    if (isWaterdrop) {
      const sx = $('settings-waterdrop-x'), sy = $('settings-waterdrop-y');
      if (sx) { sx.value = String(opts.waterdropX ?? 50); $('waterdrop-x-val').textContent = `${opts.waterdropX ?? 50}%`; }
      if (sy) { sy.value = String(opts.waterdropY ?? 50); $('waterdrop-y-val').textContent = `${opts.waterdropY ?? 50}%`; }
      _updateWaterdropDot(opts.waterdropX ?? 50, opts.waterdropY ?? 50);
    }
  }

  const lpEnabled = await settings.get(`link_previews:${S.deviceKey}`);
  const lpToggle = $('settings-link-previews');
  if (lpToggle) lpToggle.checked = lpEnabled !== false;

  renderStorageSummary();
  await loadAndApplyFontSize(S.deviceKey);
  renderDevicesList();
  refreshPushUI();
  await loadAndApplyAnimStyle(S.deviceKey);

  // Show the Firebase index notice if the warning has been detected and not yet dismissed.
  const noticeDismissed = await settings.get('firebase_index_notice_dismissed');
  const noticeDetected  = await settings.get('firebase_index_warning_detected');
  const noticeEl = $('firebase-index-notice');
  if (noticeEl) {
    noticeEl.classList.toggle('hidden', !!(noticeDismissed || !noticeDetected));
  }
  show('overlay-settings');
  pushBackEntry();
}

window.Nexus.setTheme = async function(themeId) {
  applyTheme(themeId);                                      // apply immediately
  await saveTheme(S.deviceKey, themeId);
  
  await applyStoredAppearance(S.deviceKey);                       // reapply any accent/bubble overrides on top
  $$('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.title === THEMES[themeId]?.label);
  });
};

// ============================================================
// ONBOARDING: FIREBASE CONFIG
// ============================================================
async function handleFirebaseConfigSubmit() {
  const raw = $('firebase-config-input').value.trim();
  let config;
  try {
    const cleaned = raw.replace(/^\s*const\s+\w+\s*=\s*/, '').replace(/;?\s*$/, '');
    config = JSON.parse(cleaned);
  } catch {
    try { config = Function(`"use strict"; return (${raw})`)(); }
    catch { toast('Invalid config — paste the JSON from Firebase console'); return; }
  }

  const missing = ['apiKey', 'authDomain', 'databaseURL', 'projectId'].filter(f => !config[f]);
  if (missing.length) { toast('Missing fields: ' + missing.join(', ')); return; }

  await settings.set('firebase_config', config);
  S.config = config;
  try {
    await initFirebase(config);
    showScreen('s-signin');
  } catch (err) {
    toast('Firebase error: ' + err.message);
  }
}

// ============================================================
// ONBOARDING: SIGN IN
// ============================================================
async function handleGoogleSignIn() {
  try {
    $('signin-btn').disabled = true;
    $('signin-btn').textContent = 'Signing in…';

    const { user, deviceId } = await signInWithGoogle();
    S.uid      = user.uid;
    S.deviceId = deviceId;

    $('signin-btn').textContent = 'Checking account…';
    const profile = await getProfile(user.uid).catch(() => null);
    const isNewAccount = !profile?.encryptionSalt;

    if (isNewAccount) {
      showScreen('s-passphrase-setup');
    } else {
      const keyData = await keyStore.get(user.uid);
      if (keyData?.key) {
        S.encKey = keyData.key;
        const lockSetUp = await isLockSetUp(user.uid);
        if (lockSetUp) {
          await loadAutoLockSetting(user.uid);
          setupVisibilityLock();
          showLockScreen();
        } else {
          showScreen('s-pin-setup');
        }
      } else {
        showScreen('s-passphrase-entry');
      }
    }
  } catch (err) {
    toast('Sign-in failed: ' + err.message);
  } finally {
    const btn = $('signin-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = googleSignInHTML(); }
  }
}

function googleSignInHTML() {
  return `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
  Continue with Google`;
}

// ============================================================
// ONBOARDING: PASSPHRASE SETUP
// ============================================================
async function handlePassphraseSetup() {
  const p1 = $('passphrase-1').value;
  const p2 = $('passphrase-2').value;
  if (!p1) { toast('Enter a passphrase'); return; }
  if (p1 !== p2) { toast('Passphrases do not match'); return; }
  if (p1.length < 8) { toast('Passphrase must be at least 8 characters'); return; }

  const btn = $('passphrase-setup-btn');
  btn.disabled = true; btn.textContent = 'Setting up…';

  try {
    const salt   = generateSalt();
    const key    = await deriveKey(p1, salt);
    const vector = await createVerificationVector(key);
    await keyStore.set(S.uid, key, salt, vector);
    S.encKey = key;

    const account = await getCurrentAccount();
    await setupProfile(S.uid, S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform(),
      salt, vector,
      S.browser ?? detectBrowser());
    showScreen('s-pin-setup');
  } catch (err) {
    toast('Setup failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Set Passphrase';
  }
}

// ============================================================
// ONBOARDING: PASSPHRASE ENTRY
// ============================================================
async function handlePassphraseEntry() {
  const p = $('passphrase-entry-input').value;
  if (!p) { toast('Enter your passphrase'); return; }

  const btn = $('passphrase-entry-btn');
  btn.disabled = true; btn.textContent = 'Verifying…';

  try {
    const profile = await getProfile(S.uid);
    if (!profile?.encryptionSalt) throw new Error('Account profile not found on Firebase');

    const key    = await deriveKey(p, profile.encryptionSalt);
    const vector = JSON.parse(profile.verificationVector);
    const valid  = await verifyKey(key, vector);

    if (!valid) {
      toast('Wrong passphrase — try again');
      btn.disabled = false; btn.textContent = 'Decrypt & Continue';
      return;
    }

    await keyStore.set(S.uid, key, profile.encryptionSalt, vector);
    S.encKey = key;

    const account = await getCurrentAccount();
    await registerDevice(S.uid, S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform(),
      S.browser ?? detectBrowser());

    const lockSetUp = await isLockSetUp(S.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(S.uid);
      setupVisibilityLock();
      showLockScreen();
    } else {
      showScreen('s-pin-setup');
    }
  } catch (err) {
    toast('Error: ' + err.message);
    btn.disabled = false; btn.textContent = 'Decrypt & Continue';
  }
}

// ============================================================
// ONBOARDING: PIN SETUP
// ============================================================
let _pinSetupBuffer    = '';
let _pinSetupFirstEntry = '';
let _pinSetupPhase     = 'create';

function onPINSetupDigit(d) {
  if (_pinSetupBuffer.length >= 6) return;
  _pinSetupBuffer += d;
  updatePINSetupDots();
  if (_pinSetupBuffer.length === 6) setTimeout(advancePINSetup, 200);
}

function onPINSetupBackspace() {
  _pinSetupBuffer = _pinSetupBuffer.slice(0, -1);
  updatePINSetupDots();
}

function updatePINSetupDots() {
  $$('.pin-setup-dot').forEach((d, i) => d.classList.toggle('filled', i < _pinSetupBuffer.length));
}

function advancePINSetup() {
  if (_pinSetupPhase === 'create') {
    _pinSetupFirstEntry = _pinSetupBuffer;
    _pinSetupBuffer = ''; _pinSetupPhase = 'confirm';
    $('pin-setup-prompt').textContent = 'Confirm your PIN';
    updatePINSetupDots();
    const inp = $('setup-pin-input');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  } else {
    if (_pinSetupBuffer !== _pinSetupFirstEntry) {
      toast('PINs do not match — try again');
      _pinSetupBuffer = ''; _pinSetupFirstEntry = ''; _pinSetupPhase = 'create';
      $('pin-setup-prompt').textContent = 'Create a 6-digit PIN';
      updatePINSetupDots();
      return;
    }
    completePINSetup(_pinSetupBuffer);
  }
}

function onSetupPINInput(e) {
  const raw = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
  e.target.value = raw;
  _pinSetupBuffer = raw;
  updatePINSetupDots();
  if (_pinSetupBuffer.length === 6) setTimeout(advancePINSetup, 200);
}

function initPINSetupScreen() {
  _pinSetupBuffer = ''; _pinSetupFirstEntry = ''; _pinSetupPhase = 'create';
  updatePINSetupDots();
  const prompt = $('pin-setup-prompt');
  if (prompt) prompt.textContent = 'Create a 6-digit PIN';
  $('setup-numpad')?.classList.add('hidden');
  $('setup-keyboard-hint')?.classList.remove('hidden');
  const inp = $('setup-pin-input');
  if (inp) inp.value = '';

  function focusSetupInput() {
    const i = $('setup-pin-input');
    if (i) { i.focus(); i.click(); }
  }
  document.getElementById('pin-setup-dots-row')?.addEventListener('click', focusSetupInput);
  $('setup-keyboard-btn')?.addEventListener('click', focusSetupInput);
  if (!isMobileDevice()) setTimeout(focusSetupInput, 350);
}

async function completePINSetup(pin) {
  try {
    await setupPIN(S.uid, pin);
    _pinSetupBuffer = ''; _pinSetupFirstEntry = ''; _pinSetupPhase = 'create';
    const inp = $('setup-pin-input');
    if (inp) inp.value = '';
    showScreen('s-biometrics-setup');
  } catch (err) {
    toast('PIN setup failed: ' + err.message);
  }
}

// ============================================================
// ONBOARDING: BIOMETRICS
// ============================================================
async function initBiometricsScreen() {
  const available = await biometricsAvailable();
  toggle('bio-setup-available',   available);
  toggle('bio-setup-unavailable', !available);
}

async function handleBiometricSetup() {
  const account = await getCurrentAccount();
  try {
    await setupBiometrics(S.uid, account?.email ?? '');
    toast('Biometrics set up successfully');
    showScreen('s-device-name');
  } catch (err) {
    toast('Biometrics failed: ' + err.message);
  }
}

// ============================================================
// ONBOARDING: DEVICE NAME
// ============================================================
async function handleDeviceNameDone() {
  const name = $('device-name-input').value.trim() || getDefaultDeviceName();
  S.deviceName = name;
  await updateDeviceName(name);
  // Write name into the Firebase device record immediately so Linked Devices
  // and msg.deviceName are correct from the very first session.
  try { await touchDevice(S.uid, S.deviceId, { name }); } catch {}
  await loadAutoLockSetting(S.uid);
  setupVisibilityLock();
  await startChat();
}

// ============================================================
// PASSPHRASE STRENGTH METER
// ============================================================
function updateStrengthMeter(val) {
  const score = passphraseStrength(val);
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['', '#ef4444', '#f59e0b', '#10b981', '#6d44d4'];
  $$('.strength-seg').forEach((seg, i) => {
    seg.style.background = i < score ? colors[score] : 'var(--border)';
  });
  const lbl = $('strength-label');
  if (lbl) { lbl.textContent = labels[score] ?? ''; lbl.style.color = colors[score] ?? ''; }
}

// ============================================================
// PHASE 4 — CONTEXT MENU, EDIT, REPLY, REACTIONS
// ============================================================
const P4 = {
  editingMsgId: null,
  replyToMsg:   null,
};

const SEL = {
  active:   false,
  selected: new Set(),
};
// Set to true for ~80ms after a long-press enters select mode, so the
// click event that fires immediately after pointerup doesn't unselect the message.
let _suppressNextSelectClick = false;

function enterSelectMode(firstMsgId) {
  SEL.active = true;
  SEL.selected.clear();
  if (firstMsgId) SEL.selected.add(firstMsgId);
  // Dismiss keyboard / blur the message input while selecting
  $('msg-input')?.blur();
  document.querySelectorAll('.msg-row:not([data-pending-id])').forEach(row => {
    row.classList.add('msg-selectable');
    if (!row.querySelector('.msg-select-check')) {
      const chk = document.createElement('div');
      chk.className = 'msg-select-check';
      chk.setAttribute('aria-hidden', 'true');
      chk.innerHTML = '✓';
      // Append (not insertBefore) — the checkmark is position:absolute so it
      // doesn't participate in the flex column flow. insertBefore was incorrectly
      // stacking it above the bubble as a flex child.
      row.appendChild(chk);
    }
    if (SEL.selected.has(row.dataset.id)) row.classList.add('msg-selected');
    row.addEventListener('click', onSelectRowClick);
  });
  showSelectToolbar();
  pushBackEntry();
}

function exitSelectMode() {
  SEL.active = false;
  SEL.selected.clear();
  document.querySelectorAll('.msg-row').forEach(row => {
    row.classList.remove('msg-selectable', 'msg-selected');
    row.querySelector('.msg-select-check')?.remove();
    row.removeEventListener('click', onSelectRowClick);
  });
  hideSelectToolbar();
}

function onSelectRowClick(e) {
  if (_suppressNextSelectClick) return;
  // Don't intercept clicks on interactive sub-elements
  if (e.target.closest('.reply-quote') ||
      e.target.closest('[data-reply-id]') ||
      e.target.closest('.msg-reactions') ||
      e.target.closest('.reaction-pill') ||
      e.target.tagName === 'A') return;
  const row = e.currentTarget;
  const msgId = row.dataset.id;
  if (!msgId || msgId.startsWith('pending-')) return;
  if (SEL.selected.has(msgId)) {
    SEL.selected.delete(msgId);
    row.classList.remove('msg-selected');
  } else {
    SEL.selected.add(msgId);
    row.classList.add('msg-selected');
  }
  updateSelectToolbar();
}

function showSelectToolbar() {
  let bar = $('select-toolbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'select-toolbar';

    const countEl  = document.createElement('span');
    countEl.className = 'select-toolbar-count';
    countEl.id = 'sel-count';

    const allBtn = document.createElement('button');
    allBtn.id = 'sel-all-btn';
    allBtn.className = 'select-toolbar-btn accent';
    allBtn.textContent = 'Select All';
    allBtn.addEventListener('click', () => {
      document.querySelectorAll('.msg-row.msg-selectable').forEach(row => {
        const id = row.dataset.id;
        if (id && !id.startsWith('pending-')) { SEL.selected.add(id); row.classList.add('msg-selected'); }
      });
      updateSelectToolbar();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'sel-cancel-btn';
    cancelBtn.className = 'select-toolbar-btn ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', exitSelectMode);

    const copyBtn = document.createElement('button');
    copyBtn.id = 'sel-copy-btn';
    copyBtn.className = 'select-toolbar-btn ghost hidden';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      if (SEL.selected.size !== 1) return;
      const msgId = [...SEL.selected][0];
      const msg   = S.messages.find(m => m.id === msgId);
      const text  = msg?._decryptedText ?? '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => { exitSelectMode(); toast('Copied'); })
          .catch(() => { legacyCopy(text); exitSelectMode(); });
      } else {
        legacyCopy(text); exitSelectMode();
      }
    });

    const editBtn = document.createElement('button');
    editBtn.id = 'sel-edit-btn';
    editBtn.className = 'select-toolbar-btn ghost hidden';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      if (SEL.selected.size !== 1) return;
      const msgId = [...SEL.selected][0];
      const msg   = S.messages.find(m => m.id === msgId);
      if (!msg) return;
      exitSelectMode();
      startEdit(msg);
    });

    const delBtn = document.createElement('button');
    delBtn.id = 'sel-delete-btn';
    delBtn.className = 'select-toolbar-btn danger';
    delBtn.addEventListener('click', async () => {
      if (!SEL.selected.size) return;
      const n = SEL.selected.size;
      if (!await nexusConfirm(
        `Delete ${n} message${n > 1 ? 's' : ''} for everyone?`,
        { confirmLabel: `Delete (${n})`, danger: true }
      )) return;
      const ids = [...SEL.selected];
      exitSelectMode();
      let failed = 0;
      for (const id of ids) {
        try {
          const msg = S.messages.find(m => m.id === id);
          if (msg?.uuid && (msg.type === 'image' || msg.type === 'file')) {
            try { await deleteMedia(S.uid, msg.uuid); }
            catch (err) { console.warn('[delete] Drive cleanup failed (queued):', err.message); }
          }
          await deleteMessage(S.uid, id);
        } catch { failed++; }
      }
      if (failed) toast(`${failed} message${failed > 1 ? 's' : ''} could not be deleted`);
      else toast(`${n} message${n > 1 ? 's' : ''} deleted`);
    });

    bar.append(countEl, allBtn, cancelBtn, copyBtn, editBtn, delBtn);
    document.body.appendChild(bar);
  }
  updateSelectToolbar();
  bar.classList.remove('hidden');
}

function updateSelectToolbar() {
  const n       = SEL.selected.size;
  const countEl = $('sel-count');
  const delBtn  = $('sel-delete-btn');
  const copyBtn = $('sel-copy-btn');
  const editBtn = $('sel-edit-btn');

  if (countEl) countEl.textContent = `${n} selected`;

  if (delBtn) {
    delBtn.textContent   = n > 0 ? `Delete (${n})` : 'Delete';
    delBtn.disabled      = n === 0;
    delBtn.style.opacity = n === 0 ? '0.4' : '';
  }

  // Copy and Edit only appear when exactly 1 message is selected
  if (n === 1) {
    const msgId = [...SEL.selected][0];
    const msg   = S.messages.find(m => m.id === msgId);
    const isText = !msg?.type || msg?.type === 'text';
    const isOwnText = isText && msg?.deviceId === S.deviceId && !msg?.deleted && msg?._decryptedText;

    if (copyBtn) copyBtn.classList.toggle('hidden', !isText);
    if (editBtn) editBtn.classList.toggle('hidden', !isOwnText);
  } else {
    copyBtn?.classList.add('hidden');
    editBtn?.classList.add('hidden');
  }
}

function hideSelectToolbar() { $('select-toolbar')?.remove(); }

// ---- Long-press detection ---------------------------------------------------
function setupLongPress() {
  const list = $('messages-list');
  if (!list || list.dataset.lpWired) return;
  list.dataset.lpWired = '1';

  let _lpTimer = null, _lpTarget = null, _moved = false;

  function startLP(el, e) {
    if (e.button !== undefined && e.button !== 0) return;
    _moved = false;
    _lpTarget = el.closest('.msg-row');
    if (!_lpTarget) return;
    _lpTimer = setTimeout(() => {
      if (_moved) return;
      if (SEL.active) {
        openContextMenu(_lpTarget, e);
      } else {
        const msgId = _lpTarget.dataset.id;
        if (msgId && !msgId.startsWith('pending-')) {
          if (navigator.vibrate) navigator.vibrate(30);
          // Suppress the click that fires after pointerup ends the long-press.
          // 600ms is needed for slow Android/Samsung devices where click can fire
          // 200-400ms after the long-press is detected.
          _suppressNextSelectClick = true;
          setTimeout(() => { _suppressNextSelectClick = false; }, 600);
          enterSelectMode(msgId);
        }
      }
    }, 500);
  }

  function cancelLP() { clearTimeout(_lpTimer); _lpTimer = null; _lpTarget = null; }

  list.addEventListener('pointerdown', e => {
    startLP(e.target, e);
    // NOTE: Do NOT call e.preventDefault() here for touch events.
    // preventDefault() on pointerdown suppresses the browser's native touch-scroll
    // gesture entirely, freezing the message list. Long-press detection is purely
    // timer-based and does not require preventing default pointer behaviour.
  });
  list.addEventListener('pointermove',  () => { _moved = true; cancelLP(); });
  list.addEventListener('pointerup',    cancelLP);
  list.addEventListener('pointercancel', cancelLP);
  list.addEventListener('contextmenu', e => {
    // Prevent the browser's own context menu unconditionally on the message list.
    e.preventDefault();
    cancelLP();

    const row = e.target.closest('.msg-row');
    if (!row) return;

    if (SEL.active) {
      onSelectRowClick({ currentTarget: row, target: e.target, stopPropagation: () => {} });
      return;
    }

    // Use isMobileDevice() — far more reliable than e.button on Samsung Chrome,
    // which sometimes sends button===2 for touch long-press.
    // On touch devices: long-press ALWAYS enters select mode (no Nexus popup menu).
    // On desktop: right-click opens the Nexus context menu.
    if (isMobileDevice()) {
      const msgId = row.dataset.id;
      if (msgId && !msgId.startsWith('pending-')) {
        if (navigator.vibrate) navigator.vibrate(30);
        _suppressNextSelectClick = true;
        setTimeout(() => { _suppressNextSelectClick = false; }, 600);
        enterSelectMode(msgId);
      }
    } else {
      openContextMenu(row, e);
    }
  });

  // Swipe right to reply (other-device messages only — own messages sit on the
  // right so swiping right pushes them off-screen and the icon appears on the
  // wrong side; use the context menu or double-click to reply to your own msgs)
  let _swipeStartX = 0, _swipeStartY = 0, _swipeRow = null, _swipeActive = false;
  list.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
    const row = e.target.closest('.msg-row');
    // Skip own messages and pending bubbles
    _swipeRow = (row && !row.classList.contains('own') && !row.dataset.pendingId) ? row : null;
    _swipeActive = false;
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!_swipeRow) return;
    const dx = e.touches[0].clientX - _swipeStartX;
    const dy = Math.abs(e.touches[0].clientY - _swipeStartY);
    if (dy > 30 || dx < 10) return;
    if (dx > 10) {
      _swipeActive = true;
      const bubble = _swipeRow.querySelector('.msg-bubble');
      if (bubble) {
        const capped = Math.min(dx, 72);
        bubble.style.transform = `translateX(${capped}px)`;
        bubble.style.transition = 'none';
        let icon = _swipeRow.querySelector('.swipe-reply-icon');
        if (!icon) {
          icon = document.createElement('span');
          icon.className = 'swipe-reply-icon';
          icon.textContent = '↩';
          _swipeRow.insertBefore(icon, _swipeRow.firstChild);
        }
        icon.style.opacity = Math.min(1, (capped - 10) / 40).toString();
      }
    }
  }, { passive: true });
  list.addEventListener('touchend', e => {
    if (!_swipeRow || !_swipeActive) return;
    const bubble = _swipeRow.querySelector('.msg-bubble');
    if (bubble) { bubble.style.transform = ''; bubble.style.transition = ''; }
    _swipeRow.querySelector('.swipe-reply-icon')?.remove();
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    if (dx >= 60) {
      const msgId = _swipeRow.dataset.id;
      if (msgId && !msgId.startsWith('pending-')) {
        const msg = S.messages.find(m => m.id === msgId);
        if (msg && !msg.deleted) startReply(msg);
      }
    }
    _swipeRow = null; _swipeActive = false;
  }, { passive: true });

  // Double-click to reply on desktop ONLY.
  // On touch devices the gesture fires dblclick too — but immediately calls
  // $('msg-input').focus() which opens the soft keyboard, causing a viewport
  // resize that fires pointermove, which calls cancelLP() and kills the
  // long-press timer before it can enter select mode.
  // Swipe-to-reply and the context-menu Reply option cover mobile instead.
  list.addEventListener('dblclick', e => {
    if (!window.matchMedia('(pointer: fine)').matches) return; // touch device → ignore
    if (SEL.active) return;
    const row = e.target.closest('.msg-row');
    if (!row) return;
    const msgId = row.dataset.id;
    if (!msgId || msgId.startsWith('pending-')) return;
    const msg = S.messages.find(m => m.id === msgId);
    if (!msg || msg.deleted) return;
    e.preventDefault();
    startReply(msg);
  });

  // Global keyboard shortcuts are registered once in bindEvents() below.
}

// ---- Context menu -----------------------------------------------------------
function openContextMenu(row, e) {
  if (!row) return;
  const msgId = row.dataset.id;
  if (!msgId || msgId.startsWith('pending-')) return;

  const msg = S.messages.find(m => m.id === msgId);
  if (!msg || msg.deleted) return;

  const isOwn    = msg.deviceId === S.deviceId;
  const isText   = !msg.type || msg.type === 'text';

  closeContextMenu();

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.className = 'ctx-menu';

  const EMOJIS = ['👍','❤️','😂','😮','😢','🙏'];
  const strip  = document.createElement('div');
  strip.className = 'ctx-reactions';
  EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'ctx-reaction-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      reactToMessage(S.uid, msgId, S.deviceId, emoji).catch(() => {});
      closeContextMenu();
    });
    strip.appendChild(btn);
  });
  menu.appendChild(strip);

  const divider = () => { const d = document.createElement('div'); d.className = 'ctx-divider'; return d; };
  const actions = [];

  actions.push({ label: '↩ Reply', fn: () => startReply(msg) });

  if (isText) {
    actions.push({ label: 'Copy', fn: () => {
      const text = msg._decryptedText ?? '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => legacyCopy(text));
      } else {
        legacyCopy(text);
      }
    }});
  }

  if (isOwn && isText) {
    actions.push({ label: 'Edit', fn: () => startEdit(msg) });
  }

  actions.push({ label: 'Delete', danger: true, fn: () => confirmDelete(msgId) });

  if (msg.type === 'image' || msg.type === 'file') {
    actions.push({ label: 'Download', fn: () => window.Nexus.openMedia(msg.uuid) });
  }

  if (actions.length) menu.appendChild(divider());
  actions.forEach(({ label, danger, fn }) => {
    const btn = document.createElement('button');
    btn.className = 'ctx-action' + (danger ? ' ctx-danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { fn(); closeContextMenu(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // Measure the menu after it's in the DOM but before revealing it.
  // Using a hardcoded mh estimate (e.g. 280) is wrong on mobile — the
  // actual height varies with the number of actions. We measure the real
  // size, then clamp so the menu never clips off any screen edge.
  const rect = menu.getBoundingClientRect();
  const mw   = rect.width  || 220;
  const mh   = rect.height || 280;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const MARGIN = 8;

  const rawX = e?.clientX ?? vw / 2;
  const rawY = e?.clientY ?? vh / 2;

  // Prefer opening below-right of tap; flip if not enough room.
  let cx = rawX;
  let cy = rawY;
  if (cx + mw + MARGIN > vw) cx = Math.max(MARGIN, rawX - mw);
  if (cy + mh + MARGIN > vh) cy = Math.max(MARGIN, rawY - mh);
  cx = Math.max(MARGIN, Math.min(cx, vw - mw - MARGIN));
  cy = Math.max(MARGIN, Math.min(cy, vh - mh - MARGIN));

  menu.style.left = cx + 'px';
  menu.style.top  = cy + 'px';
  menu.style.transformOrigin = `${cy < rawY ? 'bottom' : 'top'} ${cx < rawX ? 'right' : 'left'}`;
  menu.classList.add('ctx-menu-visible');

  setTimeout(() => {
    document.addEventListener('pointerdown', closeContextMenuOutside, { once: true });
  }, 10);
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied');
  } catch { toast('Copy failed'); }
}

function closeContextMenuOutside(e) {
  const menu = document.getElementById('ctx-menu');
  if (menu && !menu.contains(e.target)) closeContextMenu();
}

function closeContextMenu() {
  document.getElementById('ctx-menu')?.remove();
  document.removeEventListener('pointerdown', closeContextMenuOutside);
}

// ---- Delete -----------------------------------------------------------------
async function confirmDelete(msgId) {
  if (!await nexusConfirm('Delete this message for everyone?', { confirmLabel: 'Delete', danger: true })) return;
  try {
    const msg = S.messages.find(m => m.id === msgId);
    // Await Drive cleanup before removing the Firebase record so that if
    // Drive deletion fails it gets enqueued — not silently dropped.
    if (msg?.uuid && (msg.type === 'image' || msg.type === 'file')) {
      try {
        await deleteMedia(S.uid, msg.uuid);
      } catch (err) {
        // Non-fatal — file is queued for deletion; log for debugging
        console.warn('[delete] Drive cleanup failed (queued):', err.message);
      }
    }
    await deleteMessage(S.uid, msgId);
  } catch (err) {
    toast('Delete failed: ' + err.message);
  }
}

// ---- Edit -------------------------------------------------------------------
function startEdit(msg) {
  if (!msg._decryptedText) { toast('Cannot edit this message'); return; }
  P4.editingMsgId = msg.id;
  const input = $('msg-input');
  input.value = msg._decryptedText;
  autoResizeInput();
  input.focus();
  showReplyEditBanner('edit', null, msg._decryptedText);
}

async function commitEdit() {
  const msgId = P4.editingMsgId;
  if (!msgId || S.sendInProgress) return;

  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text) { toast('Cannot send an empty message'); return; }

  S.sendInProgress = true;
  setSendBtnState(false);
  P4.editingMsgId = null;
  hideReplyEditBanner();
  input.value = '';
  autoResizeInput();
  await drafts.delete(S.uid);

  try {
    const { ciphertext, iv } = await encrypt(S.encKey, text);
    await editMessage(S.uid, msgId, ciphertext, iv);
  } catch (err) {
    toast('Edit failed: ' + err.message);
  } finally {
    S.sendInProgress = false;
    setSendBtnState(true);
  }
}

// ---- Reply ------------------------------------------------------------------
function startReply(msg) {
  // Media messages store encrypted JSON metadata as _decryptedText. Detect it
  // and show a friendly label instead of the raw JSON string.
  const rawText    = msg._decryptedText ?? '';
  const isMediaMsg = (msg.type === 'image' || msg.type === 'file');
  const isMetaJson = isMediaMsg && rawText.startsWith('{');
  const displayText = isMetaJson || !rawText
    ? (msg.type === 'image' ? '📷 Photo'
     : msg.type === 'file'  ? `📎 ${msg.fileName ?? 'File'}`
     : '…')   // text message whose _decryptedText isn't loaded yet
    : rawText;

  P4.replyToMsg = {
    id:         msg.id,
    text:       displayText,
    deviceName: msg.deviceName ?? 'Unknown',
  };
  showReplyEditBanner('reply', P4.replyToMsg.deviceName, P4.replyToMsg.text);
  $('msg-input').focus();
}

function cancelReplyEdit() {
  const wasEditing = !!P4.editingMsgId;
  P4.editingMsgId = null;
  P4.replyToMsg   = null;
  hideReplyEditBanner();
  if (wasEditing) { $('msg-input').value = ''; autoResizeInput(); }
}

let _bannerObserver = null;

function showReplyEditBanner(mode, name, text) {
  let banner = $('reply-edit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reply-edit-banner';
    banner.className = 'reply-edit-banner';
    const inputRow = $('msg-input')?.closest('.input-area') ?? $('msg-input')?.parentElement;
    if (inputRow) inputRow.parentElement.insertBefore(banner, inputRow);
  }
  const modeLabel = mode === 'edit' ? 'Editing' : `Replying to ${escHtml(name ?? '')}`;
  banner.innerHTML = `
    <div class="reb-bar"></div>
    <div class="reb-content">
      <div class="reb-label">${modeLabel}</div>
      <div class="reb-text">${escHtml((text ?? '').slice(0, 80))}</div>
    </div>
    <button class="reb-cancel" aria-label="Cancel">✕</button>`;
  banner.classList.remove('hidden');
  banner.querySelector('.reb-cancel').addEventListener('click', cancelReplyEdit);

  // Keep --reply-banner-h in sync with the banner's actual rendered height.
  // A ResizeObserver handles font-scaling and multi-line text changes,
  // giving the scroll-to-bottom button a smooth animated lift each time.
  const update = () => {
    const h = banner.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--reply-banner-h', h + 'px');
  };

  if (_bannerObserver) _bannerObserver.disconnect();
  _bannerObserver = new ResizeObserver(update);
  _bannerObserver.observe(banner);
  // Also call immediately so the button moves on this frame
  requestAnimationFrame(update);
}

function hideReplyEditBanner() {
  if (_bannerObserver) { _bannerObserver.disconnect(); _bannerObserver = null; }
  $('reply-edit-banner')?.classList.add('hidden');
  document.documentElement.style.setProperty('--reply-banner-h', '0px');
}

// ---- Reactions rendering ----------------------------------------------------
function buildReactionsHTML(reactions, msgId) {
  if (!reactions || !Object.keys(reactions).length) return '';
  const agg = {};
  for (const [emoji, deviceMap] of Object.entries(reactions)) {
    if (!deviceMap) continue;
    const entries = Object.entries(deviceMap).filter(([, v]) => v);
    if (!entries.length) continue;
    agg[emoji] = { count: entries.length, mine: entries.some(([did]) => did === S.deviceId) };
  }
  if (!Object.keys(agg).length) return '';
  const safeId = escHtml(msgId);
  return `<div class="msg-reactions">${
    Object.entries(agg).map(([emoji, { count, mine }]) =>
      `<span class="reaction-pill${mine ? ' mine' : ''}"
             onclick="Nexus.toggleReaction('${safeId}','${emoji}')"
             title="${count} reaction${count > 1 ? 's' : ''}">${emoji}${count > 1 ? ` ${count}` : ''}</span>`
    ).join('')
  }</div>`;
}

window.Nexus.toggleReaction = function(msgId, emoji) {
  if (SEL.active) return; // don't react while in multi-select mode
  reactToMessage(S.uid, msgId, S.deviceId, emoji).catch(() => {});
};

window.Nexus.scrollToMsg = function(msgId) {
  // Use pure JS string equality instead of a CSS attribute-value selector.
  // CSS.escape() is designed for CSS identifiers, not quoted attribute values;
  // Firebase push keys start with '-' which can produce mismatching escaped
  // selectors in some browsers (Samsung Internet, older WebKit).
  const list = $('messages-list');
  const el = list
    ? Array.from(list.querySelectorAll('.msg-row[data-id]'))
        .find(row => row.dataset.id === msgId)
    : null;
  if (!el || !list) {
    // Replied-to message might be deleted or scrolled out of the 150-msg window
    toast('Original message not found');
    return;
  }
  const listRect = list.getBoundingClientRect();
  const elRect   = el.getBoundingClientRect();
  const offset   = elRect.top - listRect.top + list.scrollTop
                 - (list.clientHeight / 2) + (elRect.height / 2);
  list.scrollTo({ top: offset, behavior: 'smooth' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1200);
};

// ============================================================
// PHASE 5 — SEARCH
// ============================================================
let _searchDebounce = null;

function openSearch() {
  const header = document.querySelector('.app-header');
  if (!header || header.dataset.searchMode) return;
  header.dataset.searchMode = '1';
  header._origHTML = header.innerHTML;

  header.innerHTML = `
    <div class="search-bar-inline">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:var(--text-muted)">
        <circle cx="6.5" cy="6.5" r="4.5"/><path d="M11 11l3 3" stroke-linecap="round"/>
      </svg>
      <input id="search-input" class="search-input-inline" type="search"
        placeholder="Search messages…" autocomplete="off" autocorrect="off" spellcheck="false">
      <button id="search-close-btn" class="search-close-inline" aria-label="Close search">✕</button>
    </div>`;

  const inp = header.querySelector('#search-input');
  if (inp) { inp.addEventListener('input', onSearchInput); inp.focus(); }
  header.querySelector('#search-close-btn')?.addEventListener('click', closeSearch);

  let dropdown = $('search-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'search-dropdown';
    dropdown.className = 'search-dropdown hidden';
    const sApp = $('s-app');
    if (sApp) sApp.insertBefore(dropdown, sApp.children[1]);
  }
  dropdown.innerHTML = '<div class="search-empty" id="search-empty">Type to search your messages</div>';
  dropdown.classList.remove('hidden');
  pushBackEntry();
}

function closeSearch() {
  const header = document.querySelector('.app-header');
  if (header && header.dataset.searchMode) {
    delete header.dataset.searchMode;
    header.innerHTML = header._origHTML;
    delete header._origHTML;
    header.querySelector('#header-avatar')?.addEventListener('click', openAccountSwitcher);
    header.querySelector('#header-settings-btn')?.addEventListener('click', openSettings);
    header.querySelector('#header-search-btn')?.addEventListener('click', openSearch);
  }
  $('search-dropdown')?.classList.add('hidden');
}

function onSearchInput(e) {
  clearTimeout(_searchDebounce);
  const q = e.target.value.trim();
  if (!q) { renderSearchResults([]); return; }
  _searchDebounce = setTimeout(() => runSearch(q), 180);
}

async function runSearch(query) {
  if (!S.encKey || !S.messages.length) return;
  const q = query.toLowerCase();
  const results = [];
  for (const msg of S.messages) {
    if (msg.deleted || msg.type === 'image' || msg.type === 'file') continue;
    let text = msg._decryptedText;
    if (!text && msg.ciphertext) {
      try { text = await decrypt(S.encKey, msg.ciphertext, msg.iv); msg._decryptedText = text; }
      catch { continue; }
    }
    if (!text) continue;
    if (text.toLowerCase().includes(q)) results.push({ msg, text });
  }
  renderSearchResults(results, query);
}

function renderSearchResults(results, query = '') {
  const el    = $('search-dropdown');
  const empty = $('search-empty');
  if (!el) return;

  if (!results.length) {
    if (empty) {
      empty.textContent = query ? `No results for "${query}"` : 'Type to search your messages';
      empty.classList.remove('hidden');
    }
    Array.from(el.children).forEach(c => { if (c !== empty) c.remove(); });
    return;
  }

  if (empty) empty.classList.add('hidden');
  Array.from(el.children).forEach(c => { if (c !== empty) c.remove(); });

  const frag = document.createDocumentFragment();
  for (const { msg, text } of results) {
    const isOwn = msg.deviceId === S.deviceId;
    const ts    = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const date  = ts.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
    const time  = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    let preview;
    if (idx >= 0) {
      const start  = Math.max(0, idx - 30);
      const before = escHtml(text.slice(start, idx));
      const match  = escHtml(text.slice(idx, idx + query.length));
      const after  = escHtml(text.slice(idx + query.length, idx + query.length + 60));
      preview = `${start > 0 ? '…' : ''}${before}<mark class="search-match">${match}</mark>${after}`;
    } else {
      preview = escHtml(text.slice(0, 100));
    }

    const row = document.createElement('div');
    row.className = 'search-result-row';
    row.innerHTML = `
      <div class="sr-meta">
        <span class="sr-name">${isOwn ? 'You' : escHtml(S.devices[msg.deviceId]?.name ?? msg.deviceName ?? 'Other device')}</span>
        <span class="sr-date">${date} ${time}</span>
      </div>
      <div class="sr-text">${preview}</div>`;
    row.addEventListener('click', () => { closeSearch(); window.Nexus.scrollToMsg(msg.id); });
    frag.appendChild(row);
  }
  el.appendChild(frag);
}

// ============================================================
// PHASE 5 — EXPORT
// ============================================================
async function exportChat(format) {
  if (!S.encKey || !S.messages.length) { toast('No messages to export'); return; }
  const btn = format === 'json' ? $('export-json-btn') : $('export-txt-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Decrypting…'; }

  try {
    const decrypted = [];
    for (const msg of S.messages) {
      const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
      let text = msg._decryptedText;
      if (!text && !msg.deleted) {
        if (msg.type === 'image') text = `[Image: ${msg.fileName ?? 'photo'}]`;
        else if (msg.type === 'file') text = `[File: ${msg.fileName ?? 'file'}]`;
        else if (msg.ciphertext) {
          try { text = await decrypt(S.encKey, msg.ciphertext, msg.iv); }
          catch { text = '[Unable to decrypt]'; }
        }
      }
      if (msg.deleted) continue; // skip deleted messages in export
      decrypted.push({
        id:         msg.id,
        timestamp:  ts.toISOString(),
        sender:     msg.deviceId === S.deviceId ? 'You' : (msg.deviceName ?? 'Other'),
        deviceId:   msg.deviceId,
        type:       msg.type ?? 'text',
        text:       text ?? '',
        edited:     !!msg.edited,
        replyTo:    msg.replyTo ?? null,
        fileName:   msg.fileName ?? null,
        fileSize:   msg.fileSize ?? null,
      });
    }

    let blob, filename;
    if (format === 'json') {
      blob     = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), account: S.email, messageCount: decrypted.length, messages: decrypted }, null, 2)], { type: 'application/json' });
      filename = `nexus-export-${new Date().toISOString().slice(0,10)}.json`;
    } else {
      const lines = decrypted.map(m => {
        const ts = new Date(m.timestamp).toLocaleString();
        return `[${ts}] ${m.sender}:\n  ${m.text}`;
      });
      blob     = new Blob([lines.join('\n\n')], { type: 'text/plain' });
      filename = `nexus-export-${new Date().toISOString().slice(0,10)}.txt`;
    }

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Exported ${decrypted.length} messages`);
  } catch (err) {
    toast('Export failed: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = format === 'json' ? 'Export JSON' : 'Export Text';
    }
  }
}

// ============================================================
// PHASE 5 — PUSH NOTIFICATIONS
// ============================================================
async function handlePushToggle() {
  const btn    = $('settings-push-btn');
  const status = $('settings-push-status');

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (status) status.textContent = 'Push notifications are not supported in this browser.';
    return;
  }

  const current = Notification.permission;
  if (current === 'denied') {
    if (status) status.textContent = 'Notifications blocked. Enable them in your browser site settings.';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      await settings.set(`push_enabled:${S.deviceKey}`, false);
      if (btn) btn.textContent = 'Enable';
      if (status) status.textContent = 'Push notifications disabled on this device.';
      toast('Push notifications off');
      return;
    }

    if (current !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        if (status) status.textContent = 'Permission not granted. You can enable it in browser settings.';
        return;
      }
    }

    const vapidKey = S.config?.vapidKey;
    if (!vapidKey) {
      await settings.set(`push_enabled:${S.deviceKey}`, true);
      if (btn) btn.textContent = 'Disable';
      if (status) status.textContent = 'Notifications enabled (browser alerts when Nexus is open). Add FCM VAPID key for background delivery.';
      toast('Push notifications on');
      return;
    }

    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
    const { getDatabase, ref: dbRef, set: dbSet } =
      await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
    const db = getDatabase(getFirebaseApp());
    await dbSet(dbRef(db, `accounts/${S.uid}/pushSubscriptions/${S.deviceId}`), {
      endpoint:   sub.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
        auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))),
      },
      deviceName: S.deviceName,
      updatedAt:  Date.now(),
    });
    await settings.set(`push_enabled:${S.deviceKey}`, true);
    if (btn) btn.textContent = 'Disable';
    if (status) status.textContent = 'Push notifications active — notified even when app is closed.';
    toast('Push notifications on');
  } catch (err) {
    if (status) status.textContent = 'Error: ' + err.message;
    toast('Push setup failed: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function refreshPushUI() {
  const btn    = $('settings-push-btn');
  const status = $('settings-push-status');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.disabled = true; btn.textContent = 'Not supported'; return;
  }
  if (Notification.permission === 'denied') {
    btn.textContent = 'Blocked';
    if (status) status.textContent = 'Notifications blocked in browser settings.';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.textContent = sub ? 'Disable' : 'Enable';
    if (status && sub) status.textContent = 'Push notifications active on this device.';
    else if (status) status.textContent = '';
  } catch {
    btn.textContent = 'Enable';
  }
}

// ============================================================
// PHASE 5 — MESSAGE ANIMATION STYLE
// ============================================================
function applyAnimStyle(style) {
  const list = $('messages-list');
  if (!list) return;
  list.classList.remove('anim-fade-up', 'anim-slide-in', 'anim-pop', 'anim-none');
  if (style && style !== 'none') list.classList.add(`anim-${style}`);
}

async function loadAndApplyAnimStyle(uid) {
  const style = (await settings.get(`anim_style:${uid}`)) ?? 'fade-up';
  applyAnimStyle(style);
  const sel = $('settings-anim-style');
  if (sel) sel.value = style;
}

// ============================================================
// LINK PREVIEWS
// ============================================================
const _linkPreviewCache = new Map();

async function fetchLinkPreview(url) {
  if (_linkPreviewCache.has(url)) return _linkPreviewCache.get(url);
  const enabled = await settings.get(`link_previews:${S.deviceKey}`);
  if (enabled === false) { _linkPreviewCache.set(url, null); return null; }

  try {
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res   = await fetch(proxy, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('proxy error');
    const json  = await res.json();
    const html  = json.contents ?? '';
    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const meta  = (prop) => {
      const el = doc.querySelector(`meta[property="${prop}"],meta[name="${prop}"]`);
      return el?.getAttribute('content')?.trim() || null;
    };
    const title = meta('og:title') || meta('twitter:title') || doc.title?.trim() || null;
    const desc  = meta('og:description') || meta('twitter:description') || meta('description') || null;
    const image = meta('og:image') || meta('twitter:image') || null;
    const host  = new URL(url).hostname.replace(/^www\./, '');
    if (!title && !image) { _linkPreviewCache.set(url, null); return null; }
    const preview = { title, desc, image, host, url };
    _linkPreviewCache.set(url, preview);
    return preview;
  } catch {
    _linkPreviewCache.set(url, null);
    return null;
  }
}

function buildLinkPreviewHTML(preview) {
  if (!preview) return '';
  // Strictly allow only http/https URLs — reject javascript:, data:, etc.
  const rawUrl = preview.url ?? '';
  if (!/^https?:\/\//i.test(rawUrl)) return '';
  const rawImg = preview.image ?? '';
  const safeImgSrc = /^https?:\/\//i.test(rawImg) ? escHtml(rawImg) : '';

  const safeUrl   = escHtml(rawUrl);
  const safeTitle = escHtml(preview.title ?? '');
  const safeDesc  = escHtml((preview.desc ?? '').slice(0, 160));
  const safeHost  = escHtml(preview.host ?? '');
  const imgHtml   = safeImgSrc
    ? `<img class="lp-image" src="${safeImgSrc}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
  return `<div class="link-preview" onclick="window.open('${safeUrl}','_blank','noopener')">
    ${imgHtml}
    <div class="lp-body">
      ${safeTitle ? `<div class="lp-title">${safeTitle}</div>` : ''}
      ${safeDesc  ? `<div class="lp-desc">${safeDesc}</div>`   : ''}
      <div class="lp-host">${safeHost}</div>
    </div>
  </div>`;
}

function extractFirstUrl(text) {
  const m = text?.match(/https?:\/\/[^\s<>"]+/);
  return m ? m[0] : null;
}

async function injectLinkPreview(msgId, url) {
  const preview = await fetchLinkPreview(url);
  if (!preview) return;
  const bubble = document.querySelector(`.msg-row[data-id="${CSS.escape(msgId)}"] .msg-bubble`);
  if (!bubble || bubble.querySelector('.link-preview')) return;
  const meta = bubble.querySelector('.msg-meta');
  if (meta) meta.insertAdjacentHTML('beforebegin', buildLinkPreviewHTML(preview));
}

// ============================================================
// DRIVE CAP EDITING
// ============================================================
window.Nexus.editDriveCap = async function(driveUid, currentCap) {
  const gbNow = (currentCap / (1024 ** 3)).toFixed(1);
  const input = await nexusPrompt(`New storage cap in GB (current: ${gbNow} GB):`, gbNow);
  if (input === null) return;
  const gb = parseFloat(input);
  if (isNaN(gb) || gb <= 0) { toast('Enter a valid number of GB'); return; }
  try {
    const { updateSpineCap } = await import('./spine.js');
    await updateSpineCap(S.uid, driveUid, Math.round(gb * 1024 ** 3));
    S.spineConfig = await getSpineConfig(S.uid);
    toast(`Cap updated to ${gb} GB`);
    renderStorageSummary();
  } catch (err) {
    toast('Error: ' + err.message);
  }
};

// ============================================================
// DEVICE MANAGEMENT
// ============================================================
function renderDevicesList() {
  const el = $('devices-list');
  if (!el) return;
  const entries = Object.entries(S.devices);
  if (!entries.length) {
    el.innerHTML = '<div class="storage-empty">No devices found. They appear after each device opens the app.</div>';
    return;
  }
  el.innerHTML = entries.map(([did, dev]) => {
    const isThis   = did === S.deviceId;
    const lastSeen = dev.lastSeen
      ? new Date(dev.lastSeen).toLocaleString(undefined, { dateStyle:'short', timeStyle:'short' })
      : 'Unknown';

    // Browser: fall back to detectBrowser() style labels so old records
    // that only have 'browser' stored still get a readable name.
    const rawBrowser = dev.browser ?? 'browser';
    const browserLabelStr = browserLabel(rawBrowser);

    const platformLabel = {
      android: 'Android', ios: 'iOS', windows: 'Windows PC',
      linux: 'Linux PC', mac: 'Mac', unknown: 'Unknown',
    }[dev.platform ?? 'unknown'] ?? 'Unknown';

    // Main title = profile/device name; fallback to platform label
    const displayName = escHtml(dev.name ?? platformLabel);

    // Avatar: use the decrypted per-device cache if available
    const devAvatar = _deviceAvatarCache.get(did);
    const avatarHtml = devAvatar
      ? `<div class="dev-list-avatar"><img src="${devAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`
      : `<div class="dev-list-avatar dev-list-avatar-letter">${avatarLetter(dev.name ?? '?')}</div>`;

    // Email: stored in account object. S.email is only this device's email,
    // but all devices under a UID share the same email address.
    const emailStr = escHtml(S.email ?? '');

    return `<div class="storage-row" style="align-items:flex-start;gap:12px">
      ${avatarHtml}
      <div class="storage-account-info">
        <div class="storage-email" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${platformIcon(dev.platform ?? 'unknown')}
          <span>${displayName}</span>
          ${isThis ? '<span style="font-size:11px;color:var(--accent);background:var(--accent-glow);padding:2px 8px;border-radius:99px">This device</span>' : ''}
        </div>
        <div class="storage-numbers" style="margin-top:4px">
          ${emailStr ? `${emailStr} &nbsp;·&nbsp; ` : ''}${platformLabel} &nbsp;·&nbsp; ${browserLabelStr}
          &nbsp;·&nbsp; Last seen: ${lastSeen}
        </div>
      </div>
      ${!isThis
        ? `<button class="btn-remove-drive" data-remove-device="${escHtml(did)}" title="Remove device">&times;</button>`
        : ''}
    </div>`;
  }).join('');

  // Delegated handler (avoids inline onclick with arbitrary IDs)
  el.onclick = e => {
    const btn = e.target.closest('[data-remove-device]');
    if (btn) window.Nexus.removeLinkedDevice(btn.dataset.removeDevice);
  };
}

window.Nexus.removeLinkedDevice = async function(deviceId) {
  const dev  = S.devices[deviceId];
  const name = dev?.name ?? 'this device';
  if (!await nexusConfirm(`Remove "${name}"? It will be signed out immediately.`, { confirmLabel: 'Remove', danger: true })) return;
  try {
    const { removeDevice } = await import('./realtime.js');
    await removeDevice(S.uid, deviceId);
    toast(`${name} removed`);
    renderDevicesList();
  } catch (err) {
    toast('Error: ' + err.message);
  }
};

// ============================================================
// CHANGE PASSPHRASE
// ============================================================
async function openChangePassphrase() {
  const modal = document.createElement('div');
  modal.className = 'migrate-modal';
  modal.id = 'pcp-modal';
  modal.innerHTML = `
    <div class="migrate-panel">
      <div class="migrate-title">Change Passphrase</div>
      <div id="pcp-step1">
        <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px;line-height:1.6">
          All messages will be re-encrypted with the new passphrase.
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

      const msgs = S.messages.filter(m => !m.deleted && m.ciphertext);
      logLine(`Re-encrypting ${msgs.length} messages…`);
      const updates = {};
      let msgDone = 0;
      for (const msg of msgs) {
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
        } catch (e) { logLine(`  Could not re-encrypt ${msg.id}: ${e.message}`); }
      }

      logLine('Writing to Firebase…');
      const { getDatabase: gdb, ref: dbRef, update: dbUpdate } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
      const fireDb = gdb(getFirebaseApp());
      const updateEntries = Object.entries(updates);
      for (let i = 0; i < updateEntries.length; i += 400) {
        await dbUpdate(dbRef(fireDb, '/'), Object.fromEntries(updateEntries.slice(i, i + 400)));
      }
      logLine(`${msgDone} messages re-encrypted`);

      logLine('Updating profile…');
      await dbUpdate(dbRef(fireDb, `accounts/${S.uid}/profile`), {
        encryptionSalt:     newSalt,
        verificationVector: JSON.stringify(newVector),
      });
      logLine('Profile updated');

      await keyStore.set(S.uid, newKey, newSalt, newVector);
      S.encKey = newKey;
      logLine('Local key updated');
      logLine('\nPassphrase changed successfully!');
      toast('Passphrase changed successfully');
    } catch (err) {
      logLine(`\nERROR: ${err.message}`);
    } finally {
      bindClose();
    }
  });
}

async function openSpineMigration() {
  const config = await getSpineConfig(S.uid);
  if (config.accounts.length < 2) { toast('You need at least 2 Drive accounts to migrate files.'); return; }

  const modal = document.createElement('div');
  modal.className = 'migrate-modal';

  const accountOptions = config.accounts.map(a =>
    `<option value="${escHtml(a.driveUid)}">${escHtml(a.email)}</option>`
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
        Moves all files from the source account to the destination. Source files are deleted after transfer.
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
    const logLine = msg => { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; };

    const startBtn = modal.querySelector('#mg-start');
    startBtn.disabled = true; startBtn.textContent = 'Migrating…';
    modal.querySelector('#mg-cancel').disabled = true;

    try {
      const { getFullManifest } = await import('./spine.js');
      if (!hasDriveToken(fromUid)) { logLine('ERROR: Source account needs re-authentication.'); return; }
      if (!hasDriveToken(toUid))   { logLine('ERROR: Destination account needs re-authentication.'); return; }

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

      let ok = 0, failed = 0;
      for (const [uuid, entry] of entries) {
        logLine(`  Copying ${uuid.slice(0, 8)}…`);
        try {
          const buf     = await driveDownloadFile(fromUid, entry.driveFileId);
          const encBlob = new Blob([buf], { type: 'application/octet-stream' });
          const newFileId = await driveUploadFile(toUid, toFolderId, uuid, encBlob, () => {});

          const { update, ref: dbRef, getDatabase } =
            await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
          const db = getDatabase(getFirebaseApp());
          await update(dbRef(db, `accounts/${S.uid}/mediaManifest/${uuid}`), {
            driveUid: toUid, driveFileId: newFileId, folderId: toFolderId,
          });
          try { await driveDeleteFile(fromUid, entry.driveFileId); } catch {}
          ok++;
          logLine(`  OK ${uuid.slice(0, 8)}`);
        } catch (err) { failed++; logLine(`  FAIL ${uuid.slice(0, 8)}: ${err.message}`); }
      }

      logLine(`\nDone. ${ok} migrated, ${failed} failed.`);
      S.spineConfig = await getSpineConfig(S.uid);
      renderStorageSummary();
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
// SLIDESHOW WALLPAPER EDITOR
// ============================================================
async function openSlideshowEditor(slides) {
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
          <select id="ss-transition" class="settings-select" style="flex:1">
            <option value="crossfade" ${existingOpts.transition==='crossfade'?'selected':''}>Crossfade</option>
            <option value="slide"     ${existingOpts.transition==='slide'    ?'selected':''}>Slide</option>
            <option value="zoom"      ${existingOpts.transition==='zoom'     ?'selected':''}>Zoom in</option>
            <option value="waterdrop" ${existingOpts.transition==='waterdrop'?'selected':''}>Waterdrop ✦</option>
          </select>
        </div>

        <div class="color-row" style="gap:10px">
          <label style="font-size:13px;color:var(--text-dim);min-width:70px">Speed</label>
          <select id="ss-duration" class="settings-select" style="flex:1">
            <option value="300"  ${existingOpts.duration===300  ?'selected':''}>Fast (0.3s)</option>
            <option value="600"  ${existingOpts.duration===600  ?'selected':''}>Normal (0.6s)</option>
            <option value="800"  ${!existingOpts.duration || existingOpts.duration===800?'selected':''}>Smooth (0.8s)</option>
            <option value="1200" ${existingOpts.duration===1200 ?'selected':''}>Slow (1.2s)</option>
            <option value="2000" ${existingOpts.duration===2000 ?'selected':''}>Very slow (2s)</option>
          </select>
        </div>

        <div class="color-row" style="gap:10px">
          <label style="font-size:13px;color:var(--text-dim);min-width:70px">Interval</label>
          <select id="ss-interval" class="settings-select" style="flex:1">
            <option value="5"   ${storedInterval==5  ?'selected':''}>5 sec</option>
            <option value="15"  ${storedInterval==15 ?'selected':''}>15 sec</option>
            <option value="30"  ${storedInterval==30 ?'selected':''}>30 sec</option>
            <option value="60"  ${storedInterval==60 ?'selected':''}>1 min</option>
            <option value="300" ${storedInterval==300?'selected':''}>5 min</option>
          </select>
        </div>

        <!-- Waterdrop origin — only shown when waterdrop is selected -->
        <div id="ss-waterdrop-section" class="${isWD ? '' : 'hidden'}" style="flex-direction:column;gap:8px">
          <label style="font-size:13px;color:var(--text-dim)">Waterdrop origin — click to set</label>
          <div id="ss-wd-picker"
               style="width:100%;height:80px;background:var(--surface2);border:1.5px solid var(--border2);
                      border-radius:var(--radius-sm);cursor:crosshair;position:relative;overflow:hidden">
            <div id="ss-wd-dot"
                 style="position:absolute;width:12px;height:12px;border-radius:50%;
                        background:var(--accent);transform:translate(-50%,-50%);
                        box-shadow:0 0 0 2px rgba(255,255,255,0.6);pointer-events:none;
                        left:${existingOpts.waterdropX??50}%;top:${existingOpts.waterdropY??50}%"></div>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <label style="font-size:12px;color:var(--text-muted)">X</label>
            <input type="range" id="ss-wd-x" min="0" max="100" value="${existingOpts.waterdropX??50}"
                   style="flex:1;accent-color:var(--accent)">
            <span id="ss-wd-x-val" style="font-size:12px;color:var(--text-dim);min-width:30px">${existingOpts.waterdropX??50}%</span>
            <label style="font-size:12px;color:var(--text-muted)">Y</label>
            <input type="range" id="ss-wd-y" min="0" max="100" value="${existingOpts.waterdropY??50}"
                   style="flex:1;accent-color:var(--accent)">
            <span id="ss-wd-y-val" style="font-size:12px;color:var(--text-dim);min-width:30px">${existingOpts.waterdropY??50}%</span>
          </div>
        </div>
      </div>

      <div class="migrate-btn-row" style="margin-top:14px;flex-wrap:wrap;gap:8px">
        <button id="ss-cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="ss-save-btn" class="btn btn-sm" style="background:var(--accent);color:#fff">Save</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  let current = [...slides];

  // Thumbnail grid interaction
  const refresh = () => {
    modal.querySelector('#ss-thumb-grid').innerHTML = renderThumbs(current);
    modal.querySelectorAll('.ss-move-up').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.dataset.index;
      if (i > 0) { [current[i-1], current[i]] = [current[i], current[i-1]]; refresh(); }
    }));
    modal.querySelectorAll('.ss-move-down').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.dataset.index;
      if (i < current.length-1) { [current[i], current[i+1]] = [current[i+1], current[i]]; refresh(); }
    }));
    modal.querySelectorAll('.ss-delete').forEach(btn => btn.addEventListener('click', () => {
      current.splice(+btn.dataset.index, 1); refresh();
    }));
  };
  refresh();

  modal.querySelector('#ss-add-btn').addEventListener('click', () => $('slideshow-file-input')?.click());

  const addHandler = async (e) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = '';
    toast('Processing…', 3000);
    for (const f of files) { try { current.push(await compressWallpaper(f)); } catch {} }
    refresh();
  };
  const orig = $('slideshow-file-input')._nexusAddHandler;
  if (orig) $('slideshow-file-input').removeEventListener('change', orig);
  $('slideshow-file-input')._nexusAddHandler = addHandler;
  $('slideshow-file-input').addEventListener('change', addHandler);

  // Transition selector — show/hide waterdrop section
  const wdSection = modal.querySelector('#ss-waterdrop-section');
  modal.querySelector('#ss-transition').addEventListener('change', e => {
    const isWaterdrop = e.target.value === 'waterdrop';
    if (wdSection) wdSection.classList.toggle('hidden', !isWaterdrop);
  });

  // Waterdrop sliders
  const wdXSlider = modal.querySelector('#ss-wd-x');
  const wdYSlider = modal.querySelector('#ss-wd-y');
  const wdDot     = modal.querySelector('#ss-wd-dot');
  const wdXVal    = modal.querySelector('#ss-wd-x-val');
  const wdYVal    = modal.querySelector('#ss-wd-y-val');
  const wdPicker  = modal.querySelector('#ss-wd-picker');

  const updateWdDot = (x, y) => {
    if (wdDot) { wdDot.style.left = `${x}%`; wdDot.style.top = `${y}%`; }
    if (wdXVal) wdXVal.textContent = `${Math.round(x)}%`;
    if (wdYVal) wdYVal.textContent = `${Math.round(y)}%`;
  };
  wdXSlider?.addEventListener('input', e => { updateWdDot(+e.target.value, +wdYSlider.value); });
  wdYSlider?.addEventListener('input', e => { updateWdDot(+wdXSlider.value, +e.target.value); });
  wdPicker?.addEventListener('click', e => {
    const rect = wdPicker.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width)  * 100);
    const y = Math.round(((e.clientY - rect.top)  / rect.height) * 100);
    if (wdXSlider) wdXSlider.value = String(x);
    if (wdYSlider) wdYSlider.value = String(y);
    updateWdDot(x, y);
  });

  modal.querySelector('#ss-cancel-btn').addEventListener('click', () => {
    $('slideshow-file-input').removeEventListener('change', addHandler);
    modal.remove();
  });

  modal.querySelector('#ss-save-btn').addEventListener('click', async () => {
    if (!current.length) { toast('Add at least one image'); return; }
    $('slideshow-file-input').removeEventListener('change', addHandler);
    try {
      const interval   = parseInt(modal.querySelector('#ss-interval')?.value ?? '30', 10);
      const transition = modal.querySelector('#ss-transition')?.value ?? 'crossfade';
      const duration   = parseInt(modal.querySelector('#ss-duration')?.value ?? '800', 10);
      const wdX        = parseInt(wdXSlider?.value ?? '50', 10);
      const wdY        = parseInt(wdYSlider?.value ?? '50', 10);
      const opts       = { transition, duration, waterdropX: wdX, waterdropY: wdY };

      await clearWallpaper(S.deviceKey);
      await clearVideoWallpaper(S.deviceKey);
      await saveSlideshowWallpaper(S.deviceKey, current);
      await saveSlideshowOpts(S.deviceKey, opts);
      await settings.set(`anim_slideshow_interval:${S.deviceKey}`, interval);
      startSlideshowWallpaper(current, interval * 1000, opts);

      // Sync settings panel controls
      $('settings-wallpaper-preview')?.classList.add('hidden');
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      $('slideshow-settings-block')?.classList.remove('hidden');
      const sTran = $('settings-slideshow-transition');
      if (sTran) sTran.value = transition;
      const sDur = $('settings-slideshow-duration');
      if (sDur) sDur.value = String(duration);
      const sInt = $('settings-slideshow-interval');
      if (sInt) sInt.value = String(interval);
      $('slideshow-waterdrop-row')?.classList.toggle('hidden', transition !== 'waterdrop');
      if (transition === 'waterdrop') {
        const sx = $('settings-waterdrop-x'), sy = $('settings-waterdrop-y');
        if (sx) { sx.value = String(wdX); $('waterdrop-x-val').textContent = `${wdX}%`; }
        if (sy) { sy.value = String(wdY); $('waterdrop-y-val').textContent = `${wdY}%`; }
        _updateWaterdropDot(wdX, wdY);
      }

      toast(`Slideshow saved — ${current.length} image${current.length > 1 ? 's' : ''}`);
    } catch (err) { toast('Save failed: ' + err.message); }
    modal.remove();
  });
}

// ============================================================
// VIDEO WALLPAPER EDITOR
// ============================================================
function openVideoEditor() {
  const modal = document.createElement('div');
  modal.className = 'migrate-modal';
  modal.innerHTML = `
    <div class="migrate-panel" style="max-width:380px">
      <div class="migrate-title">Video Wallpaper</div>
      <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px;line-height:1.6">
        A video is already set. You can replace or remove it.
      </p>
      <div class="migrate-btn-row" style="flex-wrap:wrap;gap:8px">
        <button id="vw-replace-btn" class="btn btn-ghost btn-sm">Replace Video</button>
        <button id="vw-remove-btn"  class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger)">Remove</button>
        <button id="vw-cancel-btn"  class="btn btn-ghost btn-sm">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#vw-replace-btn').addEventListener('click', () => { modal.remove(); $('video-wall-file-input')?.click(); });
  modal.querySelector('#vw-remove-btn').addEventListener('click', async () => {
    await clearVideoWallpaper(S.deviceKey);
    removeVideoWallpaper();
    $('settings-wallpaper-remove')?.classList.add('hidden');
    toast('Video wallpaper removed');
    modal.remove();
  });
  modal.querySelector('#vw-cancel-btn').addEventListener('click', () => modal.remove());
}

function avatarLetter(emailOrName) {
  return (emailOrName?.[0] ?? '?').toUpperCase();
}

// Sync the visual dot on the origin picker in the settings panel.
// Called from openSettings, openSlideshowEditor, and bindEvents handlers.
function _updateWaterdropDot(x, y) {
  const dot = $('waterdrop-origin-dot');
  if (dot) { dot.style.left = `${x}%`; dot.style.top = `${y}%`; }
}

// ============================================================
// EVENT BINDING
// ============================================================
function bindEvents() {
  $('get-started-btn')?.addEventListener('click', () => showScreen('s-firebase'));

  $('firebase-next-btn')?.addEventListener('click', handleFirebaseConfigSubmit);
  $('firebase-instructions-toggle')?.addEventListener('click', () => {
    $('firebase-instructions').classList.toggle('hidden');
  });

  $('signin-btn')?.addEventListener('click', handleGoogleSignIn);

  $('passphrase-1')?.addEventListener('input', e => updateStrengthMeter(e.target.value));
  $('passphrase-1')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('passphrase-2')?.focus(); }
  });
  $('passphrase-2')?.addEventListener('input', () => {
    const match = $('passphrase-1').value === $('passphrase-2').value;
    $('passphrase-2').style.borderColor = $('passphrase-2').value
      ? (match ? 'var(--success)' : 'var(--danger)') : '';
  });
  $('passphrase-2')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handlePassphraseSetup(); }
  });
  $('passphrase-setup-btn')?.addEventListener('click', handlePassphraseSetup);

  $('passphrase-entry-btn')?.addEventListener('click', handlePassphraseEntry);
  $('passphrase-entry-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handlePassphraseEntry();
  });

  $$('.pin-setup-key').forEach(key => {
    key.addEventListener('click', () => {
      const val = key.dataset.val;
      if (val === 'back') onPINSetupBackspace();
      else onPINSetupDigit(val);
    });
  });
  $('setup-pin-input')?.addEventListener('input', onSetupPINInput);
  $('setup-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _pinSetupBuffer.length === 6) advancePINSetup();
  });
  initPINSetupScreen();

  $('bio-setup-btn')?.addEventListener('click', handleBiometricSetup);
  $('bio-skip-btn')?.addEventListener('click',  () => showScreen('s-device-name'));
  $('bio-skip-btn-2')?.addEventListener('click', () => showScreen('s-device-name'));

  $('device-name-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleDeviceNameDone(); });
  $('device-name-done-btn')?.addEventListener('click', handleDeviceNameDone);

  $$('.pin-lock-key').forEach(key => {
    key.addEventListener('click', () => {
      const val = key.dataset.val;
      if (val === 'back') onPINBackspace();
      else onPINDigit(val);
    });
  });
  $('lock-pin-input')?.addEventListener('input', onLockPINInput);
  $('lock-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _pinBuffer.length > 0) submitPIN();
    // Samsung keyboard sometimes fires keydown for Backspace but not an input
    // event on a 1×1 hidden input. Handle it explicitly.
    if (e.key === 'Backspace') {
      onPINBackspace();
      // Also truncate the input value to stay in sync
      const inp = $('lock-pin-input');
      if (inp) inp.value = _pinBuffer;
    }
  });
  $('lock-bio-btn')?.addEventListener('click', attemptBiometricUnlock);

  // Passphrase fallback — shown after 5 failed PIN attempts.
  // Clears the lockout state and takes the user to passphrase entry so they
  // can get back in without needing to remember the PIN.
  $('lock-use-passphrase-btn')?.addEventListener('click', async () => {
    const uid = S.uid ?? (await getCurrentAccount())?.uid;
    if (uid) {
      try {
        // Clear the persisted lockout so the next successful passphrase login
        // isn't immediately followed by a locked-out lock screen.
        const ld = await lockStore.get(uid);
        if (ld) await lockStore.set(uid, { ...ld, failedAttempts: 0, lockedUntil: 0 });
      } catch {}
    }
    _pinAttempts    = 0;
    _pinLockedUntil = 0;
    showScreen('s-passphrase-entry');
  });

  $('attach-btn')?.addEventListener('click', () => $('file-input')?.click());
  $('file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await handleMediaSend(file);
  });

  $('send-btn')?.addEventListener('click', handleSend);
  $('msg-input')?.addEventListener('keydown', e => {
    // On desktop: Enter sends, Shift+Enter inserts newline.
    // On mobile:  the keyboard's action key (labelled "Send" via enterkeyhint)
    //             fires Enter — honour it the same way.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); handleSend();
    }
  });
  $('msg-input')?.addEventListener('input', onInputChange);

  // Image paste from clipboard
  document.addEventListener('paste', async e => {
    if (S.currentScreen !== 's-app') return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    if (!S.spineConfig?.accounts?.length) { toast('No Drive accounts linked. Add one in Settings → Storage.'); return; }
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    await handleMediaSend(file);
  });

  $('header-avatar')?.addEventListener('click', openAccountSwitcher);
  $('header-settings-btn')?.addEventListener('click', openSettings);
  $('header-search-btn')?.addEventListener('click', openSearch);

  // Note: search UI is inline (header-replacement) — no separate overlay bindings needed.

  $('account-overlay-close')?.addEventListener('click', () => hide('overlay-accounts'));
  $('add-account-btn')?.addEventListener('click', async () => {
    hide('overlay-accounts'); showScreen('s-signin');
  });

  $('settings-close-btn')?.addEventListener('click', () => hide('overlay-settings'));
  $('settings-device-name')?.addEventListener('change', async e => {
    const name = e.target.value.trim();
    if (name) {
      S.deviceName = name;
      await updateDeviceName(name);
      $('header-title').textContent = name;
      // Update the Firebase device record so the name is immediately reflected
      // in Linked Devices on all other sessions, and in msg.deviceName on new messages.
      try { await touchDevice(S.uid, S.deviceId, { name }); } catch {}
      try { await setupPresence(S.uid, S.deviceId, name); } catch {}
      // Refresh all avatar/name displays (header, settings preview, lock screen
      // name + initial, and message avatar initials) in one call.
      updateAvatarDisplay();
      toast('Username updated');
    }
  });
  $('settings-device-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  $('settings-signout-btn')?.addEventListener('click', async () => {
    hide('overlay-settings');
    clearUnsubscribers();
    await signOut();
    showScreen('s-signin');
  });

  $('export-json-btn')?.addEventListener('click', () => exportChat('json'));
  $('export-txt-btn')?.addEventListener('click',  () => exportChat('text'));
  $('settings-push-btn')?.addEventListener('click', handlePushToggle);

  $('settings-anim-style')?.addEventListener('change', async e => {
    const style = e.target.value;
    await settings.set(`anim_style:${S.deviceKey}`, style);
    
    applyAnimStyle(style);
    toast('Animation style updated');
  });

  $('settings-font-size')?.addEventListener('input', async e => {
    const px = Math.min(24, Math.max(10, parseInt(e.target.value, 10) || 14));
    applyFontSize(px);
  });
  $('settings-font-size')?.addEventListener('change', async e => {
    const px = Math.min(24, Math.max(10, parseInt(e.target.value, 10) || 14));
    e.target.value = String(px);
    applyFontSize(px);
    await settings.set(`font_size:${S.deviceKey}`, px);
    
    toast('Font size updated');
  });

  $('settings-change-passphrase-btn')?.addEventListener('click', () => {
    hide('overlay-settings'); openChangePassphrase();
  });

  $('settings-bio-setup-btn')?.addEventListener('click', async () => {
    const account = await getCurrentAccount();
    try { await setupBiometrics(S.uid, account?.email ?? ''); toast('Biometrics enabled'); }
    catch { toast('Biometrics setup failed'); }
  });

  $('settings-add-drive-btn')?.addEventListener('click', async () => {
    try {
      const { GoogleAuthProvider, signInWithPopup, getAuth } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/drive.file');
      const auth = getAuth();
      const originalUser = auth.currentUser;
      const result = await signInWithPopup(auth, provider);
      const cred   = GoogleAuthProvider.credentialFromResult(result);
      const driveUid = result.user.uid;
      const email    = result.user.email;

      if (result.user.uid !== S.uid && originalUser) {
        try { await auth.updateCurrentUser(originalUser); } catch {}
      }

      if (cred?.accessToken) storeDriveToken(driveUid, cred.accessToken, 3600);

      const gbInput = await nexusPrompt('How many GB should Nexus use on this Drive account?', '15');
      if (gbInput === null) return;
      const gb = parseFloat(gbInput);
      const capBytes = (isNaN(gb) || gb <= 0) ? 5 * 1024 * 1024 * 1024 : Math.round(gb * 1024 ** 3);
      await addSpineAccount(S.uid, driveUid, email, capBytes);
      S.spineConfig = await getSpineConfig(S.uid);
      toast('Drive account added to Spine');
      renderStorageSummary();
    } catch (err) {
      if (err.code === 'auth/cancelled-popup-request' || err.code === 'auth/popup-closed-by-user') return;
      toast('Error: ' + err.message);
    }
  });

  $('settings-autolock')?.addEventListener('change', async e => {
    const mins = parseInt(e.target.value, 10);
    await setAutoLockMinutes(S.uid, mins);
    startAutoLockTimer();
    toast('Auto-lock updated');
  });

  // install-btn removed

  document.addEventListener('nexus:screenchange', async e => {
    if (e.detail === 's-biometrics-setup') initBiometricsScreen();
    if (e.detail === 's-pin-setup')        initPINSetupScreen();
  });
  initBiometricsScreen();

  const devInput = $('device-name-input');
  if (devInput && !devInput.value) devInput.value = getDefaultDeviceName();

  $('overlay-settings')?.addEventListener('click', e => {
    if (e.target === $('overlay-settings')) hide('overlay-settings');
  });
  $('overlay-accounts')?.addEventListener('click', e => {
    if (e.target === $('overlay-accounts')) hide('overlay-accounts');
  });

  $('upload-cancel-btn')?.addEventListener('click', cancelCurrentUpload);

  $('settings-avatar-btn')?.addEventListener('click', () => $('avatar-file-input')?.click());
  $('avatar-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      let croppedDataUrl;
      try {
        croppedDataUrl = await cropImage(file, 'circle');
      } catch (cropErr) {
        if (cropErr.message === 'cancelled') return;
        croppedDataUrl = await compressAvatar(file);
      }
      const { ciphertext, iv } = await encrypt(S.encKey, croppedDataUrl);
      // Store avatar on the device record — not the shared profile — so each
      // (email × device × browser) combination has its own independent photo.
      await updateDeviceAvatar(S.uid, S.deviceId, JSON.stringify({ ciphertext, iv }));
      S.avatarDataUrl = croppedDataUrl;
      _deviceAvatarCache.set(S.deviceId, croppedDataUrl);
      updateAvatarDisplay();
      toast('Profile photo updated');
    } catch (err) { toast('Could not set photo: ' + err.message); }
  });

  $('settings-avatar-remove-btn')?.addEventListener('click', async () => {
    try {
      await updateDeviceAvatar(S.uid, S.deviceId, null);
      S.avatarDataUrl = null;
      _deviceAvatarCache.delete(S.deviceId);
      updateAvatarDisplay();
      toast('Profile photo removed');
    } catch (err) { toast('Error: ' + err.message); }
  });

  let _accentSaveTimer = null;
  $('settings-accent-color')?.addEventListener('input', async e => {
    const hex = e.target.value;
    applyAccentColor(hex);
    await saveAccentColor(S.deviceKey, hex);
    clearTimeout(_accentSaveTimer);
    _accentSaveTimer = null;
  });
  $('settings-accent-reset')?.addEventListener('click', async () => {
    await clearAccentColor(S.deviceKey);
    
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    applyTheme(thId);
    const { ownBubble } = await loadAppearance(S.deviceKey);
    if (ownBubble) applyOwnBubbleColor(ownBubble);
    const picker = $('settings-accent-color');
    if (picker) picker.value = THEMES[thId]?.vars['--accent'] ?? '#8b5cf6';
    toast('Accent colour reset');
  });

  let _ownBubbleSaveTimer = null;
  $('settings-own-bubble-color')?.addEventListener('input', async e => {
    const hex = e.target.value;
    applyOwnBubbleColor(hex);
    await saveOwnBubbleColor(S.deviceKey, hex);
    clearTimeout(_ownBubbleSaveTimer);
    _ownBubbleSaveTimer = null;
  });
  $('settings-own-bubble-reset')?.addEventListener('click', async () => {
    await clearOwnBubbleColor(S.deviceKey);
    
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    const def  = THEMES[thId]?.vars['--own-bg'] ?? '#6d44d4';
    applyOwnBubbleColor(def);
    const picker = $('settings-own-bubble-color');
    if (picker) picker.value = def;
    toast('Bubble colour reset');
  });

  let _otherBubbleSaveTimer = null;
  $('settings-other-bubble-color')?.addEventListener('input', async e => {
    applyOtherBubbleColor(e.target.value);
    await saveOtherBubbleColor(S.deviceKey, e.target.value);
    clearTimeout(_otherBubbleSaveTimer);
    _otherBubbleSaveTimer = null;
  });
  $('settings-other-bubble-reset')?.addEventListener('click', async () => {
    await clearOtherBubbleColor(S.deviceKey);
    
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    const def  = THEMES[thId]?.vars['--other-bg'] ?? '#141422';
    applyOtherBubbleColor(def);
    const picker = $('settings-other-bubble-color');
    if (picker) picker.value = def;
    toast('Received bubble colour reset');
  });

  $('settings-wallpaper-btn')?.addEventListener('click', () => $('wallpaper-file-input')?.click());
  $('wallpaper-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      toast('Processing…', 5000);
      let dataUrl;
      try {
        const cropped = await cropImage(file, 'rect');
        const res = await fetch(cropped); const blob = await res.blob();
        dataUrl = await compressWallpaper(new File([blob], 'wall.jpg', { type: 'image/jpeg' }));
      } catch (cropErr) {
        if (cropErr.message === 'cancelled') return;
        dataUrl = await compressWallpaper(file);
      }
      await clearVideoWallpaper(S.deviceKey);
      await clearSlideshowWallpaper(S.deviceKey);
      await clearSlideshowOpts(S.deviceKey);
      await saveWallpaper(S.deviceKey, dataUrl);
      applyWallpaper(dataUrl);
      const prev = $('settings-wallpaper-preview');
      if (prev) { prev.src = dataUrl; prev.classList.remove('hidden'); }
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      $('slideshow-settings-block')?.classList.add('hidden');
      toast('Wallpaper set');
    } catch (err) { toast('Could not set wallpaper: ' + err.message); }
  });

  $('settings-slideshow-btn')?.addEventListener('click', async () => {
    const existing = await loadSlideshowWallpaper(S.deviceKey);
    if (existing.length > 0) openSlideshowEditor(existing);
    else $('slideshow-file-input')?.click();
  });
  $('slideshow-file-input')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = '';
    try {
      toast('Processing…', 5000);
      const dataUrls = [];
      for (const f of files) { try { dataUrls.push(await compressWallpaper(f)); } catch {} }
      if (!dataUrls.length) { toast('No valid images'); return; }
      const existing = await loadSlideshowWallpaper(S.deviceKey);
      const merged   = [...existing, ...dataUrls];
      await clearWallpaper(S.deviceKey);
      await clearVideoWallpaper(S.deviceKey);
      await saveSlideshowWallpaper(S.deviceKey, merged);
      const interval = parseInt($('settings-slideshow-interval')?.value ?? '30', 10);
      await settings.set(`anim_slideshow_interval:${S.deviceKey}`, interval);
      const opts = await loadSlideshowOpts(S.deviceKey);
      startSlideshowWallpaper(merged, interval * 1000, opts);
      $('settings-wallpaper-preview')?.classList.add('hidden');
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      $('slideshow-settings-block')?.classList.remove('hidden');
      toast(`Slideshow updated — ${merged.length} image${merged.length > 1 ? 's' : ''}`);
    } catch (err) { toast('Could not set slideshow: ' + err.message); }
  });
  $('settings-slideshow-interval')?.addEventListener('change', async e => {
    const interval = parseInt(e.target.value, 10);
    await settings.set(`anim_slideshow_interval:${S.deviceKey}`, interval);
    const slides = await loadSlideshowWallpaper(S.deviceKey);
    if (slides.length) {
      const opts = await loadSlideshowOpts(S.deviceKey);
      startSlideshowWallpaper(slides, interval * 1000, opts);
    }
    toast('Slideshow interval updated');
  });

  // Shared helper: save opts and restart slideshow with current opts from settings panel
  async function _saveAndRestartSlideshow() {
    const slides = await loadSlideshowWallpaper(S.deviceKey);
    if (!slides.length) return;
    const transition = $('settings-slideshow-transition')?.value ?? 'crossfade';
    const duration   = parseInt($('settings-slideshow-duration')?.value ?? '800', 10);
    const wdX        = parseInt($('settings-waterdrop-x')?.value ?? '50', 10);
    const wdY        = parseInt($('settings-waterdrop-y')?.value ?? '50', 10);
    const interval   = parseInt($('settings-slideshow-interval')?.value ?? '30', 10);
    const opts       = { transition, duration, waterdropX: wdX, waterdropY: wdY };
    await saveSlideshowOpts(S.deviceKey, opts);
    startSlideshowWallpaper(slides, interval * 1000, opts);
  }

  $('settings-slideshow-transition')?.addEventListener('change', async e => {
    const isWaterdrop = e.target.value === 'waterdrop';
    $('slideshow-waterdrop-row')?.classList.toggle('hidden', !isWaterdrop);
    await _saveAndRestartSlideshow();
    toast('Transition updated');
  });

  $('settings-slideshow-duration')?.addEventListener('change', async () => {
    await _saveAndRestartSlideshow();
    toast('Transition speed updated');
  });

  $('settings-waterdrop-x')?.addEventListener('input', async e => {
    const x = +e.target.value;
    const y = +($('settings-waterdrop-y')?.value ?? 50);
    if ($('waterdrop-x-val')) $('waterdrop-x-val').textContent = `${x}%`;
    _updateWaterdropDot(x, y);
  });
  $('settings-waterdrop-x')?.addEventListener('change', async () => { await _saveAndRestartSlideshow(); });

  $('settings-waterdrop-y')?.addEventListener('input', async e => {
    const y = +e.target.value;
    const x = +($('settings-waterdrop-x')?.value ?? 50);
    if ($('waterdrop-y-val')) $('waterdrop-y-val').textContent = `${y}%`;
    _updateWaterdropDot(x, y);
  });
  $('settings-waterdrop-y')?.addEventListener('change', async () => { await _saveAndRestartSlideshow(); });

  $('waterdrop-origin-picker')?.addEventListener('click', async e => {
    const rect = $('waterdrop-origin-picker').getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width)  * 100);
    const y = Math.round(((e.clientY - rect.top)  / rect.height) * 100);
    const sx = $('settings-waterdrop-x'), sy = $('settings-waterdrop-y');
    if (sx) { sx.value = String(x); if ($('waterdrop-x-val')) $('waterdrop-x-val').textContent = `${x}%`; }
    if (sy) { sy.value = String(y); if ($('waterdrop-y-val')) $('waterdrop-y-val').textContent = `${y}%`; }
    _updateWaterdropDot(x, y);
    await _saveAndRestartSlideshow();
  });

  $('settings-video-wall-btn')?.addEventListener('click', async () => {
    const existing = await loadVideoWallpaper(S.deviceKey);
    if (existing) openVideoEditor(); else $('video-wall-file-input')?.click();
  });
  $('video-wall-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      toast('Loading video…', 5000);
      if (file.size > 50 * 1024 * 1024) toast('Video is large — may use significant memory');
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = () => res(reader.result);
        reader.onerror = () => rej(new Error('Read failed'));
        reader.readAsDataURL(file);
      });
      await clearWallpaper(S.deviceKey);
      await clearSlideshowWallpaper(S.deviceKey);
      await clearSlideshowOpts(S.deviceKey);
      await saveVideoWallpaper(S.deviceKey, dataUrl);
      applyVideoWallpaper(dataUrl);
      $('settings-wallpaper-preview')?.classList.add('hidden');
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      $('slideshow-settings-block')?.classList.add('hidden');
      toast('Video wallpaper set');
    } catch (err) { toast('Could not set video: ' + err.message); }
  });

  $('settings-wallpaper-remove')?.addEventListener('click', async () => {
    await clearWallpaper(S.deviceKey);
    await clearVideoWallpaper(S.deviceKey);
    await clearSlideshowWallpaper(S.deviceKey);
    await clearSlideshowOpts(S.deviceKey);
    stopSlideshowWallpaper();
    removeVideoWallpaper();
    applyWallpaper(null);
    const prev = $('settings-wallpaper-preview');
    if (prev) { prev.src = ''; prev.classList.add('hidden'); }
    $('settings-wallpaper-remove')?.classList.add('hidden');
    $('slideshow-settings-block')?.classList.add('hidden');
    toast('Wallpaper removed');
  });

  $('settings-link-previews')?.addEventListener('change', async e => {
    await settings.set(`link_previews:${S.deviceKey}`, e.target.checked);
    toast(e.target.checked ? 'Link previews on' : 'Link previews off');
  });

  $('settings-migrate-btn')?.addEventListener('click', openSpineMigration);

  // Firebase index notice dismiss
  $('firebase-index-dismiss-btn')?.addEventListener('click', async () => {
    await settings.set('firebase_index_notice_dismissed', true);
    $('firebase-index-notice')?.classList.add('hidden');
  });

  // Intercept Firebase's console warning about missing indexes so we can show
  // the notice in Settings the next time the panel is opened.
  const _origConsoleWarn = console.warn;
  console.warn = function(...args) {
    const msg = String(args[0] ?? '');
    if (msg.includes('Using an unspecified index') || msg.includes('.indexOn')) {
      settings.set('firebase_index_warning_detected', true).catch(() => {});
    }
    _origConsoleWarn.apply(console, args);
  };

  // ============================================================
  // KEYBOARD SHORTCUTS
  // Registered once here so they are always active regardless of
  // which sub-component last ran. Priority: Escape cascade first,
  // then modifier shortcuts, then bare keys in select mode.
  // ============================================================
  document.addEventListener('keydown', e => {
    const tag      = document.activeElement?.tagName ?? '';
    const inInput  = tag === 'INPUT' || tag === 'TEXTAREA' ||
                     !!document.activeElement?.isContentEditable;
    const ctrlOrCmd = e.ctrlKey || e.metaKey;

    // ---- Escape — priority cascade (always fires, even inside inputs) ----
    if (e.key === 'Escape') {
      // 1. Context menu
      if (document.getElementById('ctx-menu')) {
        e.preventDefault(); closeContextMenu(); return;
      }
      // 2. Lightbox
      const lb = document.getElementById('media-lightbox');
      if (lb && !lb.classList.contains('hidden')) {
        e.preventDefault(); lb.querySelector('.lb-close')?.click(); return;
      }
      // 3. Select mode
      if (SEL.active) {
        e.preventDefault(); exitSelectMode(); return;
      }
      // 4. Reply / edit banner
      if (P4.editingMsgId || P4.replyToMsg) {
        e.preventDefault(); cancelReplyEdit(); return;
      }
      // 5. Inline search
      const hdr = document.querySelector('.app-header');
      if (hdr?.dataset?.searchMode) {
        e.preventDefault(); closeSearch(); return;
      }
      // 6. Settings overlay
      if (!$('overlay-settings')?.classList.contains('hidden')) {
        e.preventDefault(); hide('overlay-settings'); return;
      }
      // 7. Account switcher overlay
      if (!$('overlay-accounts')?.classList.contains('hidden')) {
        e.preventDefault(); hide('overlay-accounts'); return;
      }
      return;
    }

    // ---- Delete / Backspace — delete selected messages ----
    if ((e.key === 'Delete' || e.key === 'Backspace') && SEL.active && !inInput) {
      e.preventDefault();
      $('sel-delete-btn')?.click();
      return;
    }

    // ---- Ctrl / Cmd shortcuts ----
    if (ctrlOrCmd) {
      // Ctrl+F — toggle search
      if ((e.key === 'f' || e.key === 'F') && S.currentScreen === 's-app') {
        e.preventDefault();
        const hdr = document.querySelector('.app-header');
        if (hdr?.dataset?.searchMode) closeSearch(); else openSearch();
        return;
      }
      // Ctrl+, — toggle settings
      if (e.key === ',' && S.currentScreen === 's-app') {
        e.preventDefault();
        if (!$('overlay-settings')?.classList.contains('hidden')) hide('overlay-settings');
        else openSettings();
        return;
      }
      // Ctrl+A — select all (only in select mode, not overriding browser default elsewhere)
      if ((e.key === 'a' || e.key === 'A') && SEL.active && !inInput) {
        e.preventDefault();
        document.querySelectorAll('.msg-row.msg-selectable').forEach(row => {
          const id = row.dataset.id;
          if (id && !id.startsWith('pending-')) {
            SEL.selected.add(id);
            row.classList.add('msg-selected');
          }
        });
        updateSelectToolbar();
        return;
      }
      // Ctrl+Enter — force-send even if composing multi-line text
      if (e.key === 'Enter' && S.currentScreen === 's-app' && inInput &&
          document.activeElement?.id === 'msg-input') {
        e.preventDefault();
        handleSend();
        return;
      }
    }
  });
}

// ============================================================
// ANDROID BACK BUTTON (History API)
// ============================================================
// On Android, the system back gesture/button fires a 'popstate' event when
// the page has a history entry to pop. We push a dummy entry whenever a
// closeable layer is open, so back navigates *within* the app instead of
// exiting it. The priority order mirrors the Escape cascade in bindEvents().
function pushBackEntry() {
  history.pushState({ nexusLayer: true }, '');
}

function handleBackGesture() {
  // Walk the same priority ladder as the Escape key handler.
  if (document.getElementById('ctx-menu'))               { closeContextMenu();  pushBackEntry(); return; }

  const lb = document.getElementById('media-lightbox');
  if (lb && !lb.classList.contains('hidden'))            { lb.querySelector('.lb-close')?.click(); pushBackEntry(); return; }

  // Any dynamic modal (migrate, crop, change-passphrase, etc.)
  const modal = document.querySelector('.migrate-modal, #crop-overlay, #nexus-confirm-overlay, #nexus-prompt-overlay, #pcp-modal, #slideshow-editor-modal');
  if (modal)                                             { modal.remove(); pushBackEntry(); return; }

  if (SEL.active)                                        { exitSelectMode();    pushBackEntry(); return; }
  if (P4.editingMsgId || P4.replyToMsg)                 { cancelReplyEdit();   pushBackEntry(); return; }

  const hdr = document.querySelector('.app-header');
  if (hdr?.dataset?.searchMode)                         { closeSearch();       pushBackEntry(); return; }

  if (!$('overlay-settings')?.classList.contains('hidden')) { hide('overlay-settings'); pushBackEntry(); return; }
  if (!$('overlay-accounts')?.classList.contains('hidden')) { hide('overlay-accounts'); pushBackEntry(); return; }

  // Nothing closeable — let the browser handle it (navigate back / exit).
}

// Push an initial history entry on load so the first back press can be caught.
// (Without this, the very first popstate has nothing to pop and the browser exits.)
history.replaceState({ nexusBase: true }, '');
window.addEventListener('popstate', e => {
  if (e.state?.nexusBase) {
    // We're at the base entry — push it back immediately so the next back press
    // can also be caught, then run the close logic.
    history.pushState({ nexusBase: true }, '');
    handleBackGesture();
  } else {
    handleBackGesture();
  }
});

// Whenever a closeable layer opens, push a history entry so back can pop it.
// We hook into the existing open functions by wrapping them after definition.
const _origOpenSettings       = typeof openSettings       !== 'undefined' ? openSettings       : null;
const _origOpenAccountSwitcher= typeof openAccountSwitcher!== 'undefined' ? openAccountSwitcher: null;
// Layers that push their own history entry:
document.addEventListener('nexus:layeropen', () => pushBackEntry());

// ============================================================
// LOCK EVENT LISTENER
// ============================================================
document.addEventListener('nexus:locked', () => {
  hide('overlay-settings');
  hide('overlay-accounts');
  const header = document.querySelector('.app-header');
  if (header?.dataset?.searchMode) closeSearch();
  const lockableScreens = ['s-app', 's-passphrase-entry', 's-pin-setup', 's-biometrics-setup', 's-device-name'];
  if (lockableScreens.includes(S.currentScreen)) showLockScreen();
});

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  init().catch(err => console.error('[boot]', err));
});
