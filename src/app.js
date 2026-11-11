// src/app.js
// Nexus — main application logic and coordinator.

import { initDB, settings, keyStore, queue, drafts, lockStore }
  from './db.js';
import { deriveKey, generateSalt, encrypt, decrypt,
         createVerificationVector, verifyKey, passphraseStrength }
  from './crypto.js';
import { initFirebase, signInWithGoogle, getCurrentAccount, listAccounts,
         signOut, switchToAccount, removeLocalAccount, updateDeviceName,
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
import { THEMES, applyTheme, loadTheme, saveTheme }
  from './themes.js';
import { saveAccentColor, clearAccentColor, saveOwnBubbleColor, clearOwnBubbleColor,
         saveOtherBubbleColor, clearOtherBubbleColor,
         saveWallpaper, clearWallpaper, applyAccentColor, applyOwnBubbleColor,
         applyOtherBubbleColor, applyWallpaper, compressWallpaper, compressAvatar,
         applyStoredAppearance, loadAppearance, cropImage,
         applyVideoWallpaper, removeVideoWallpaper, saveVideoWallpaper,
         loadVideoWallpaper, clearVideoWallpaper,
         pauseVideoWallpaper, resumeVideoWallpaper,
         startSlideshowWallpaper, stopSlideshowWallpaper,
         pauseSlideshowWallpaper, resumeSlideshowWallpaper,
         saveSlideshowWallpaper, loadSlideshowWallpaper, clearSlideshowWallpaper,
         saveSlideshowOpts, loadSlideshowOpts, clearSlideshowOpts }
  from './appearance.js';
import { cancelCurrentUpload, storeDriveToken,
         uploadFile as driveUploadFile, downloadFile as driveDownloadFile,
         deleteFile as driveDeleteFile, ensureFolder as driveEnsureFolder,
         hasDriveToken, DriveAuthError }
  from './drive.js';
import { getSpineConfig, saveSpineConfig, addSpineAccount, removeSpineAccount,
         getStorageSummary, getManifestEntry,
         checkAndRestoreFolders, deleteMedia, drainPendingDriveDeletes }
  from './spine.js';
import { prepareMediaMessage, fetchMedia, decryptThumbnail,
         buildFileBubbleHTML, formatBytes }
  from './media.js';
import { toast, nexusConfirm, nexusPrompt, showLightbox }
  from './dialogs.js';
import { openChangePassphrase, openSpineMigration, openSlideshowEditor,
         openVideoEditor, showMediaPreview, closeMediaPreview }
  from './modals.js';
import { escHtml, escAttr, avatarLetter, formatText,
         buildMessageHTML, buildReactionsHTML,
         SEL, enterSelectMode, exitSelectMode, updateSelectToolbar, showSelectToolbar, legacyCopy,
         openContextMenu, closeContextMenu,
         openSearch, closeSearch, injectLinkPreview, extractFirstUrl }
  from './chat-view.js';

// ============================================================
// STATE
// ============================================================
const S = {
  uid:             null,
  deviceId:        null,
  deviceKey:       null,   // composite key: uid + ':' + deviceId
  deviceName:      null,
  platform:        null,
  browser:         null,
  encKey:          null,
  messages:        [],
  devices:         {},
  typingDevices:   [],
  presenceMap:     {},
  unsubscribers:   [],
  isOnline:        navigator.onLine,
  currentScreen:   's-loading',
  config:          null,
  sendInProgress:  false,
  spineConfig:     null,
  mediaUploading:  false,
  pendingMessages: new Map(),
  avatarDataUrl:   null,
  email:           null,
};

// Expose deviceId globally for reactions checking in chat-view
window._nexusDeviceId = null;

// Per-device decrypted avatar cache: deviceId → dataUrl (or null).
const _deviceAvatarCache = new Map();

// Phase 4 Edit / Reply state (hoisted to avoid TDZ issues)
const P4 = {
  editingMsgId: null,
  replyToMsg:   null,
};
let _suppressNextSelectClick = false;
let _drainingQueue = false;
let _unreadScrollCount = 0;
let _typingTimeout = null;
const _renderedMsgs = new Map(); // msgId → { readByOthers, edited, deleted }

// ============================================================
// DOM HELPERS
// ============================================================
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
         ('ontouchstart' in window && navigator.maxTouchPoints > 1);
}

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) {
  $(id)?.classList.add('hidden');
  if ((id === 'overlay-settings' || id === 'overlay-accounts') &&
      $('overlay-settings')?.classList.contains('hidden') &&
      $('overlay-accounts')?.classList.contains('hidden')) {
    resumeVideoWallpaper();
    resumeSlideshowWallpaper();
  }
}
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
// FONT SIZE SCALING
// ============================================================
function applyFontSize(px) {
  document.documentElement.style.setProperty('--msg-font-size', px + 'px');
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

function setLoading(msg) {
  const el = $('loading-msg');
  if (el) el.textContent = msg;
}

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
  try {
    setLoading('Opening storage…');
    await initDB();

    const rawConfig = await settings.get('firebase_config');
    if (!rawConfig) {
      showScreen('s-welcome');
      return;
    }
    S.config = rawConfig;

    setLoading('Connecting to Firebase…');
    await initFirebase(rawConfig);

    const account = await getCurrentAccount();
    if (!account) {
      showScreen('s-signin');
      return;
    }

    S.uid        = account.uid;
    S.deviceId   = account.deviceId;
    window._nexusDeviceId = account.deviceId;
    S.deviceKey  = `${account.uid}:${account.deviceId}`;
    S.deviceName = account.deviceName;
    S.platform   = account.platform ?? detectPlatform();
    S.browser    = account.browser  ?? detectBrowser();
    S.email      = account.email;

    setLoading('Checking lock…');
    const earlyKeyData = await keyStore.get(account.uid);
    if (earlyKeyData?.key) S.encKey = earlyKeyData.key;

    const lockSetUp = await isLockSetUp(account.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(account.uid);
      setupVisibilityLock();
      if (S.encKey) await loadAndApplyAvatar();
      showLockScreen();
    } else {
      await tryAutoInit();
    }

    if (window.visualViewport) {
      const vpHandler = () => {
        const kbH = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
        document.body.style.setProperty('--keyboard-h', kbH + 'px');
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
      btn.className = 'btn btn-primary retry-btn';
      btn.style.cssText = 'margin-top:16px;max-width:160px';
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
      await loadAndApplyAvatar();
      showLockScreen();
    } else {
      showScreen('s-pin-setup');
    }
  } else {
    showScreen('s-passphrase-entry');
  }
}

// ============================================================
// LOCK SCREEN & PIN
// ============================================================
async function showLockScreen() {
  const account = await getCurrentAccount();
  if (account) {
    const nameEl = $('lock-name');
    if (nameEl) nameEl.textContent = account.deviceName ?? account.displayName ?? 'My Device';
  }

  clearPINDisplay();
  showScreen('s-lock');

  const bioAvail = await biometricsAvailable();
  const bioEnabled = await isBiometricsEnabled(S.uid);
  toggle('lock-bio-btn', bioAvail && bioEnabled);

  const lockData = await lockStore.get(S.uid);
  const now = Date.now();
  if (lockData?.lockedUntil && lockData.lockedUntil > now) {
    applyLockout(lockData.lockedUntil);
  } else {
    if (lockData?.lockedUntil) {
      await lockStore.set(S.uid, { ...lockData, failedAttempts: 0, lockedUntil: 0 });
    }
    if (bioAvail && bioEnabled) {
      setTimeout(() => attemptBiometricUnlock(), 300);
    }
  }

  requestAnimationFrame(() => {
    $('lock-pin-input')?.focus();
  });
}

let _lockoutTimer = null;
function applyLockout(until) {
  clearTimeout(_lockoutTimer);
  const update = () => {
    const rem = Math.ceil((until - Date.now()) / 1000);
    const errEl = $('lock-error');
    if (rem <= 0) {
      if (errEl) errEl.textContent = '';
      enablePINInputs(true);
      return;
    }
    if (errEl) errEl.textContent = `Too many attempts. Try again in ${rem}s.`;
    enablePINInputs(false);
    _lockoutTimer = setTimeout(update, 1000);
  };
  update();
  $('lock-use-passphrase-btn')?.classList.remove('hidden');
}

function enablePINInputs(enabled) {
  $$('.pin-lock-key').forEach(k => { k.disabled = !enabled; });
  const inp = $('lock-pin-input');
  if (inp) inp.disabled = !enabled;
}

let _pinBuffer = '';

function clearPINDisplay() {
  _pinBuffer = '';
  const inp = $('lock-pin-input');
  if (inp) inp.value = '';
  updatePINDots('idle');
  const errEl = $('lock-error');
  if (errEl) errEl.textContent = '';
}

function updatePINDots(state) {
  const dots = $$('.pin-dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('filled', i < _pinBuffer.length);
    dot.classList.toggle('error',  state === 'error');
  });
}

function onPINDigit(d) {
  if (_pinBuffer.length >= 6) return;
  _pinBuffer += d;
  const inp = $('lock-pin-input');
  if (inp) inp.value = _pinBuffer;
  updatePINDots('idle');
  if (_pinBuffer.length === 6) submitPIN();
}

function onPINBackspace() {
  _pinBuffer = _pinBuffer.slice(0, -1);
  const inp = $('lock-pin-input');
  if (inp) inp.value = _pinBuffer;
  updatePINDots('idle');
}

function onLockPINInput(e) {
  const val = e.target.value.replace(/\D/g, '').slice(0, 6);
  _pinBuffer = val;
  e.target.value = val;
  updatePINDots('idle');
  if (_pinBuffer.length === 6) submitPIN();
}

async function submitPIN() {
  const pin = _pinBuffer;
  const ok = await verifyPIN(S.uid, pin);
  if (ok) {
    unlock();
    clearPINDisplay();
    const ld = await lockStore.get(S.uid);
    if (ld) await lockStore.set(S.uid, { ...ld, failedAttempts: 0, lockedUntil: 0 });
    await startChat();
  } else {
    updatePINDots('error');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

    const ld = (await lockStore.get(S.uid)) ?? {};
    const attempts = (ld.failedAttempts ?? 0) + 1;
    let lockedUntil = 0;
    if (attempts >= 5) {
      lockedUntil = Date.now() + 30 * 1000;
      applyLockout(lockedUntil);
    } else {
      const remaining = 5 - attempts;
      const errEl = $('lock-error');
      if (errEl) errEl.textContent = `Incorrect PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} left.`;
    }
    await lockStore.set(S.uid, { ...ld, failedAttempts: attempts, lockedUntil });

    setTimeout(() => {
      _pinBuffer = '';
      const inp = $('lock-pin-input');
      if (inp) inp.value = '';
      updatePINDots('idle');
    }, 700);
  }
}

async function attemptBiometricUnlock() {
  const ok = await authenticateBiometrics(S.uid);
  if (ok) {
    unlock();
    clearPINDisplay();
    await startChat();
  }
}

// ============================================================
// DRIVE AUTO RE-AUTHENTICATION
// ============================================================
let _driveReAuthAttempted = new Set();

async function driveAutoReAuth(driveUid) {
  if (_driveReAuthAttempted.has(driveUid)) return false;
  _driveReAuthAttempted.add(driveUid);

  const config = S.spineConfig ?? await getSpineConfig(S.uid);
  const acc = config.accounts?.find(a => a.driveUid === driveUid);
  if (!acc) return false;

  try {
    const { GoogleAuthProvider, signInWithPopup, getAuth } =
      await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
    const auth = getAuth();
    const originalUser = auth.currentUser;

    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    provider.setCustomParameters({
      login_hint: acc.email,
      prompt:     'none',
    });

    const result = await signInWithPopup(auth, provider);
    const cred   = GoogleAuthProvider.credentialFromResult(result);
    if (cred?.accessToken) {
      storeDriveToken(driveUid, cred.accessToken, 3600);
      console.log('[drive] Auto-refreshed token for', acc.email);
    }

    if (originalUser && result.user?.uid !== S.uid) {
      try { await auth.updateCurrentUser(originalUser); } catch {}
    }

    return !!cred?.accessToken;
  } catch {
    return false;
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
  window._nexusDeviceId = account.deviceId;
  S.deviceKey  = `${account.uid}:${account.deviceId}`;
  S.deviceName = account.deviceName;
  S.platform   = account.platform ?? detectPlatform();
  S.browser    = account.browser  ?? detectBrowser();
  S.email      = account.email;

  if (!S.encKey) {
    const keyData = await keyStore.get(account.uid);
    if (keyData?.key) {
      S.encKey = keyData.key;
    } else {
      showScreen('s-passphrase-entry');
      return;
    }
  }

  $('header-avatar').textContent = avatarLetter(account.deviceName ?? account.email);
  $('header-title').textContent  = S.deviceName ?? 'Nexus';

  const draft = await drafts.get(S.uid);
  $('msg-input').value = draft ?? '';
  autoResizeInput();

  try {
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

    if (S.deviceId && S.uid && Object.keys(devMap).length > 0 && !(S.deviceId in devMap)) {
      toast('This device was removed by another device. Signing out…');
      setTimeout(async () => {
        clearUnsubscribers();
        await signOut();
        showScreen('s-signin');
      }, 2000);
      return;
    }

    if (!$('overlay-settings')?.classList.contains('hidden')) renderDevicesList();

    const container = $('messages-list');
    if (container) {
      const wasEmpty = Object.keys(prevDevices).length === 0;
      if (wasEmpty && S.messages.length > 0) {
        _renderedMsgs.clear();
        renderMessages(S.messages).catch(() => {});
      } else {
        for (const [did, dev] of Object.entries(devMap)) {
          const prev = prevDevices[did];
          if (!prev || dev.name === prev.name) continue;
          container.querySelectorAll(`.msg-row[data-device-id="${CSS.escape(did)}"]`).forEach(row => {
            const badge = row.querySelector('.msg-device');
            if (badge) {
              badge.innerHTML = `${platformIcon(dev.platform ?? 'unknown')} ${escHtml(dev.name ?? 'Unknown device')}`;
            }
            const avatarEl = row.querySelector('.msg-avatar-img');
            if (avatarEl && !_deviceAvatarCache.get(did)) {
              avatarEl.textContent = avatarLetter(dev.name ?? '?');
            }
          });
        }
      }
    }

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
  setupMessagesListInteractions();

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

  if (S.isOnline) drainQueue();
}

function clearUnsubscribers() {
  S.unsubscribers.forEach(fn => { try { fn(); } catch {} });
  S.unsubscribers = [];
  S.messages = [];
  _renderedMsgs.clear();
  _deviceAvatarCache.clear();
  S.pendingMessages.clear();
  clearTypingTimer();
  clearMarkedRead();
  clearTimeout(_typingTimeout);
  P4.editingMsgId = null;
  P4.replyToMsg   = null;
  hideReplyEditBanner();
  const list = $('messages-list');
  if (list) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128172;</div><div class="empty-text">No messages yet</div><div class="empty-sub">Send a message to begin</div></div>';
  }
}

// ============================================================
// SCROLL-TO-BOTTOM BUTTON & BADGE
// ============================================================

function setupScrollToBottom() {
  $('scroll-to-bottom')?.remove();

  const btn = document.createElement('button');
  btn.id = 'scroll-to-bottom';
  btn.setAttribute('aria-label', 'Scroll to bottom');
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 3v10M4 8l5 5 5-5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span id="scroll-unread-badge" class="scroll-unread-badge"></span>`;

  const targetParent = $('s-app') || $('chat-area');
  if (targetParent) targetParent.appendChild(btn);

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
// MESSAGES INCOMING & RENDERING (OPTIMIZED)
// ============================================================
async function handleIncomingMessages(messages) {
  if (S.pendingMessages.size > 0) {
    for (const msg of messages) {
      if (msg.deviceId === S.deviceId && msg.ciphertext) {
        removePendingBubble(msg.ciphertext);
      }
    }
  }

  const prevVisibleIds = new Set(S.messages.filter(m => !m.deleted).map(m => m.id));
  const newOtherMsgs = messages.filter(m =>
    !m.deleted &&
    m.deviceId !== S.deviceId &&
    !prevVisibleIds.has(m.id)
  );

  S.messages = messages;
  await renderMessages(messages);

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

async function renderMessages(messages) {
  const container = $('messages-list');
  if (!container) return;

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

  container.querySelector('.empty-state')?.remove();

  const incomingIds = visible.map(m => m.id);
  const existingRows = Array.from(container.querySelectorAll('.msg-row[data-id]'));
  const existingIds  = existingRows.map(el => el.dataset.id);

  const needsFullRebuild = existingIds.length === 0 ||
    existingIds.length > incomingIds.length ||
    incomingIds.slice(0, existingIds.length).some((id, i) => id !== existingIds[i]);

  if (needsFullRebuild) {
    const _wasSelectActive = SEL.active;
    const _prevSelected    = _wasSelectActive ? new Set(SEL.selected) : null;
    if (_wasSelectActive) exitSelectMode();

    _renderedMsgs.clear();
    container.classList.add('anim-none');

    const isFirstRender = existingIds.length === 0;
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

    if (_wasSelectActive && _prevSelected) {
      enterSelectMode(null, S);
      const newVisibleIds = new Set(visible.map(m => m.id));
      for (const id of _prevSelected) {
        if (!newVisibleIds.has(id)) continue;
        SEL.selected.add(id);
        const row = container.querySelector(`.msg-row[data-id="${CSS.escape(id)}"]`);
        if (row) row.classList.add('msg-selected');
      }
      updateSelectToolbar(S);
    }

    requestAnimationFrame(() => container.classList.remove('anim-none'));
    for (const msg of decrypted) {
      if (msg.type === 'image' && msg.encThumb && S.encKey) loadThumbnailAsync(msg);
      if ((!msg.type || msg.type === 'text') && msg.id) {
        const url = extractFirstUrl(msg._decryptedText ?? msg.text ?? '');
        if (url) injectLinkPreview(msg.id, url, S.deviceKey).catch(() => {});
      }
    }
    return;
  }

  // Fast O(1) indexed incremental updates
  const rowMap = new Map();
  existingRows.forEach(r => rowMap.set(r.dataset.id, r));

  const newMsgs = visible.slice(existingIds.length);

  for (const msg of visible.slice(0, existingIds.length)) {
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    const prev = _renderedMsgs.get(msg.id);
    if (!prev) continue;

    const row = rowMap.get(msg.id);
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

    // Patch edit
    if (!!msg.edited && !prev.edited) {
      prev.edited = true;
      const hadDeviceBadge = !!row.querySelector('.msg-device');
      const decrypted = await decryptBatch([msg]);
      const isOwn = msg.deviceId === S.deviceId;
      const ts    = msg.timestamp ? new Date(msg.timestamp) : new Date();
      const time  = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });
      const newRowHTML = buildMessageHTML(decrypted[0], isOwn, hadDeviceBadge, time, readByOthers, S, _deviceAvatarCache);
      const tmp = document.createElement('div');
      tmp.innerHTML = newRowHTML;
      row.replaceWith(tmp.firstElementChild);
    }
  }

  if (!newMsgs.length) return;

  for (const msg of visible.slice(0, existingIds.length)) {
    if (!_renderedMsgs.has(msg.id)) {
      const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
      _renderedMsgs.set(msg.id, { readByOthers, edited: !!msg.edited, deleted: false });
    }
  }

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
    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers, S, _deviceAvatarCache);
  }

  container.insertAdjacentHTML('beforeend', html);

  for (const msg of decryptedNew) {
    const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
    _renderedMsgs.set(msg.id, { readByOthers, edited: !!msg.edited, deleted: false });
  }

  for (const msg of decryptedNew) {
    if (msg.type === 'image' && msg.encThumb && S.encKey) loadThumbnailAsync(msg);
    if ((!msg.type || msg.type === 'text') && msg.id) {
      const url = extractFirstUrl(msg._decryptedText ?? msg.text ?? '');
      if (url) injectLinkPreview(msg.id, url, S.deviceKey).catch(() => {});
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
    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers, S, _deviceAvatarCache);
  }
  return html;
}

function loadThumbnailAsync(msg) {
  decryptThumbnail(S.encKey, msg.encThumb).then(thumb => {
    if (!thumb) return;
    const el = document.getElementById(`thumb-${msg.id}`);
    if (!el) return;
    const captionHtml = msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '';
    el.innerHTML = `<img class="msg-thumb" src="${escAttr(thumb)}" alt="${escHtml(msg.fileName ?? 'Image')}"
      loading="lazy" data-open-media="${escAttr(msg.uuid)}" style="cursor:pointer">
      ${captionHtml}`;
  }).catch(() => {});
}

// ============================================================
// MEDIA ACTIONS & LIGHTBOX
// ============================================================
window.Nexus = window.Nexus ?? {};

window.Nexus.openMedia = async function(uuid) {
  if (!S.encKey || !S.uid) return;
  try {
    const entry = await getManifestEntry(S.uid, uuid);
    if (!entry) { toast('Media not found'); return; }
    let url;
    try {
      url = await fetchMedia(S.uid, S.encKey, uuid);
    } catch (err) {
      if (err.name === 'DriveAuthError' && err.driveUid) {
        toast('Re-authenticating Drive…');
        const ok = await driveAutoReAuth(err.driveUid);
        if (ok) {
          url = await fetchMedia(S.uid, S.encKey, uuid);
        } else {
          toast('Drive session expired — re-authenticate in Settings → Storage');
          return;
        }
      } else {
        throw err;
      }
    }

    if (entry.mimeType?.startsWith('video/')) {
      showLightbox(url, entry.fileName, true);
    } else if (entry.mimeType?.startsWith('image/')) {
      showLightbox(url, entry.fileName, false);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.fileName ?? 'download';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    toast('Could not load media: ' + err.message);
  }
};

window.Nexus.loadAudio = async function(uuid, containerId) {
  if (!S.encKey || !S.uid) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  try {
    container.querySelector('.audio-load-btn')?.setAttribute('disabled', '');
    const entry = await getManifestEntry(S.uid, uuid);
    let url;
    try {
      url = await fetchMedia(S.uid, S.encKey, uuid);
    } catch (err) {
      if (err.name === 'DriveAuthError' && err.driveUid) {
        toast('Re-authenticating Drive…');
        const ok = await driveAutoReAuth(err.driveUid);
        if (ok) { url = await fetchMedia(S.uid, S.encKey, uuid); }
        else { toast('Drive session expired — re-authenticate in Settings → Storage'); return; }
      } else { throw err; }
    }
    const fname = entry?.fileName ?? 'audio';

    container.innerHTML = `
      <audio controls preload="metadata" style="width:100%;max-width:280px;margin-bottom:4px">
        <source src="${url}">
      </audio>
      <div class="audio-bottom-row">
        <div class="file-name">${escHtml(fname)}</div>
        <a class="audio-dl-btn" title="Download" href="${escAttr(url)}" download="${escAttr(fname)}">
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M9 3v9M5 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 14h12" stroke-linecap="round"/>
          </svg>
        </a>
      </div>`;
  } catch (err) {
    toast('Could not load audio: ' + err.message);
  }
};

window.Nexus.toggleReaction = function(msgId, emoji) {
  if (SEL.active) return;
  reactToMessage(S.uid, msgId, S.deviceId, emoji).catch(() => {});
};

window.Nexus.scrollToMsg = function(msgId) {
  const list = $('messages-list');
  const el = list ? list.querySelector(`.msg-row[data-id="${CSS.escape(msgId)}"]`) : null;
  if (!el || !list) {
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
// SEND MESSAGE & MEDIA
// ============================================================
async function handleSend() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || S.sendInProgress) return;

  if (P4.editingMsgId) { await commitEdit(); return; }

  if (!S.encKey) {
    const keyData = await keyStore.get(S.uid);
    if (keyData?.key) {
      S.encKey = keyData.key;
    } else {
      toast('Passphrase required to encrypt messages');
      showScreen('s-passphrase-entry');
      return;
    }
  }

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

function renderPendingBubble(payload, plaintextForDisplay) {
  const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now     = new Date();
  const time    = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

  S.pendingMessages.set(payload.ciphertext, localId);

  const container = $('messages-list');
  if (!container) return;
  container.querySelector('.empty-state')?.remove();

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

async function handleMediaSend(file, caption) {
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
    const mediaPayload = await prepareMediaMessage(S.uid, S.encKey, file, updateUploadProgress, caption);
    const metaText = JSON.stringify({
      uuid:      mediaPayload.uuid,
      mediaType: mediaPayload.mediaType,
      fileName:  mediaPayload.fileName,
      fileSize:  mediaPayload.fileSize,
      mimeType:  mediaPayload.mimeType,
      caption:   caption || null,
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
      caption:    caption || null,
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
    if (err.name === 'DriveAuthError' && err.driveUid) {
      toast('Re-authenticating Drive…');
      const ok = await driveAutoReAuth(err.driveUid);
      if (ok) {
        try {
          const retryPayload = await prepareMediaMessage(S.uid, S.encKey, file, updateUploadProgress, caption);
          const metaText2 = JSON.stringify({
            uuid: retryPayload.uuid, mediaType: retryPayload.mediaType,
            fileName: retryPayload.fileName, fileSize: retryPayload.fileSize,
            mimeType: retryPayload.mimeType, caption: caption || null
          });
          const { ciphertext: c2, iv: iv2 } = await encrypt(S.encKey, metaText2);
          const p2 = {
            ciphertext: c2, iv: iv2, type: retryPayload.mediaType,
            deviceId: S.deviceId, deviceName: S.deviceName, uuid: retryPayload.uuid,
            fileName: retryPayload.fileName, fileSize: retryPayload.fileSize,
            mimeType: retryPayload.mimeType, caption: caption || null,
            encThumb: retryPayload.encThumb
          };
          if (S.isOnline) { await fbSendMessage(S.uid, p2); toast('Sent'); }
          else { await queue.add(S.uid, p2); toast('Queued — will send when online'); }
        } catch (retryErr) {
          toast('Upload failed: ' + retryErr.message);
        }
      } else {
        toast('Drive session expired — re-authenticate in Settings → Storage');
      }
    } else {
      console.error('[media send]', err);
      toast(err.message === 'Upload cancelled' ? 'Upload cancelled' : 'Upload failed: ' + err.message);
    }
  } finally {
    hideUploadProgress();
    S.mediaUploading = false;
    setSendBtnState(true);
    if (attachBtn) attachBtn.disabled = false;
  }
}

// ============================================================
// PROFILE AVATAR
// ============================================================
async function loadAndApplyAvatar() {
  if (!S.uid || !S.encKey || !S.deviceId) return;
  try {
    let encAvatar = await getDeviceAvatarField(S.uid, S.deviceId);
    if (!encAvatar) {
      const profile = await getProfile(S.uid);
      if (profile?.avatar) {
        encAvatar = profile.avatar;
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
    ? `<img src="${escAttr(S.avatarDataUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
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

  // Fast O(1) row avatar update
  document.querySelectorAll('.msg-avatar-img').forEach(el => {
    const row = el.closest('.msg-row');
    const did = row?.dataset.deviceId;
    if (!did) return;
    const devAvatar = _deviceAvatarCache.get(did);
    if (devAvatar) {
      el.innerHTML = `<img src="${escAttr(devAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      el.removeAttribute('data-initial');
    } else {
      el.textContent = avatarLetter(S.devices[did]?.name ?? '?');
      el.setAttribute('data-initial', '1');
    }
  });

  const lockName = $('lock-name');
  if (lockName) lockName.textContent = S.deviceName ?? '';
  const lockAv = $('lock-avatar');
  if (lockAv) {
    if (S.avatarDataUrl) {
      lockAv.innerHTML = `<img src="${escAttr(S.avatarDataUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      lockAv.textContent = avatarLetter(S.deviceName ?? S.email ?? '');
    }
  }

  if (!$('overlay-settings')?.classList.contains('hidden')) renderDevicesList();
}

// ============================================================
// OFFLINE QUEUE DRAIN (RE-ENTRANCY SAFE)
// ============================================================
async function drainQueue() {
  if (_drainingQueue || !S.uid || !S.encKey || !S.isOnline) return;
  _drainingQueue = true;

  try {
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
  } finally {
    _drainingQueue = false;
  }
}

function onOnline()  { S.isOnline = true;  updateConnectivityUI(); drainQueue(); }
function onOffline() { S.isOnline = false; updateConnectivityUI(); }

function updateConnectivityUI() {
  const dot = $('status-dot');
  if (!dot) return;
  dot.classList.toggle('offline', !S.isOnline);
  dot.title = S.isOnline ? 'Connected' : 'Offline';
}

function renderTypingIndicator() {
  const el = $('typing-indicator');
  if (!el) return;
  if (!S.typingDevices.length) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const names = S.typingDevices.map(did => S.devices[did]?.name ?? 'Another device');
  const label = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.slice(0, 2).join(' and ')} are typing…`;
  el.textContent = label;
  el.classList.remove('hidden');
}

function renderOnlineStatus() {
  const sub = $('header-sub');
  if (!sub) return;
  const otherOnline = Object.entries(S.presenceMap).filter(([, p]) => p.online);
  if (otherOnline.length > 0) {
    const names = otherOnline.map(([, p]) => p.deviceName ?? 'Device');
    sub.textContent = `${names.slice(0, 2).join(', ')} online`;
    sub.classList.remove('hidden');
  } else {
    sub.classList.add('hidden');
  }
}

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

function autoResizeInput() {
  const el = $('msg-input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

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
      ${a.isCurrentAccount
        ? '<div class="account-current-badge">Active</div>'
        : `<button class="account-remove-btn" data-remove-uid="${escHtml(a.uid)}" title="Remove account from this device" aria-label="Remove account">&times;</button>`
      }
    </div>`
  ).join('');

  list.onclick = async e => {
    const remBtn = e.target.closest('[data-remove-uid]');
    if (remBtn) {
      e.stopPropagation();
      const targetUid = remBtn.dataset.removeUid;
      const targetAcc = accounts.find(a => a.uid === targetUid);
      const name = targetAcc?.displayName || targetAcc?.email || 'this account';
      if (await nexusConfirm(`Remove ${name} from this device? Local encryption keys and cache for this account will be erased.`, { confirmLabel: 'Remove', danger: true })) {
        await removeLocalAccount(targetUid);
        toast('Account removed');
        await openAccountSwitcher();
      }
      return;
    }
    const row = e.target.closest('[data-switch-uid]');
    if (row) window.Nexus.switchAccount(row.dataset.switchUid);
  };

  show('overlay-accounts');
  pauseVideoWallpaper();
  pauseSlideshowWallpaper();
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
    window._nexusDeviceId = account.deviceId;
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
// STORAGE SUMMARY (SPINE LINK)
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
            ${!acc.authOk ? ` &nbsp;<button class="storage-reauth-btn" data-reauth="${escHtml(acc.driveUid)}">Re-authenticate</button>` : ''}
            &nbsp;·&nbsp; <button class="storage-reauth-btn" data-edit-cap="${escHtml(acc.driveUid)}" data-cap="${acc.cap}">Edit cap</button>
          </div>
        </div>
        <button class="btn-remove-drive" data-remove-drive="${escHtml(acc.driveUid)}" title="Remove">&times;</button>
      </div>`
    ).join('');

    el.onclick = e => {
      const reauthBtn = e.target.closest('[data-reauth]');
      if (reauthBtn) { window.Nexus.reAuthDrive(reauthBtn.dataset.reauth); return; }

      const capBtn = e.target.closest('[data-edit-cap]');
      if (capBtn) { window.Nexus.editDriveCap(capBtn.dataset.editCap, Number(capBtn.dataset.cap)); return; }

      const rmBtn = e.target.closest('[data-remove-drive]');
      if (rmBtn) { window.Nexus.removeSpineDrive(rmBtn.dataset.removeDrive); return; }
    };
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
      _driveReAuthAttempted.delete(driveUid);
      S.spineConfig = await getSpineConfig(S.uid);
      toast('Drive account re-authenticated');
      renderStorageSummary();
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
// SETTINGS PANEL & THEMES
// ============================================================
async function openSettings() {
  const grid = $('theme-grid');
  if (grid) {
    grid.innerHTML = Object.entries(THEMES).map(([id, t]) => `
      <button class="theme-swatch ${document.documentElement.getAttribute('data-theme') === id ? 'active' : ''}"
              data-theme-id="${id}"
              title="${t.label}"
              style="background:${t.vars['--bg']};border-color:${t.vars['--accent']}">
        <div class="swatch-bubble" style="background:${t.vars['--own-bg']}"></div>
        <div class="swatch-label" style="color:${t.vars['--text']}">${t.label}</div>
      </button>`
    ).join('');

    grid.onclick = e => {
      const btn = e.target.closest('[data-theme-id]');
      if (btn) window.Nexus.setTheme(btn.dataset.themeId);
    };
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

  const noticeDismissed = await settings.get('firebase_index_notice_dismissed');
  const noticeDetected  = await settings.get('firebase_index_warning_detected');
  const noticeEl = $('firebase-index-notice');
  if (noticeEl) {
    noticeEl.classList.toggle('hidden', !!(noticeDismissed || !noticeDetected));
  }
  show('overlay-settings');
  pauseVideoWallpaper();
  pauseSlideshowWallpaper();
  pushBackEntry();
}

window.Nexus.setTheme = async function(themeId) {
  applyTheme(themeId);
  await saveTheme(S.deviceKey, themeId);
  await applyStoredAppearance(S.deviceKey);
  $$('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.title === THEMES[themeId]?.label);
  });
};

function _updateWaterdropDot(x, y) {
  const dot = $('waterdrop-origin-dot');
  if (dot) { dot.style.left = `${x}%`; dot.style.top = `${y}%`; }
}

// ============================================================
// ONBOARDING HANDLERS
// ============================================================
async function handleFirebaseConfigSubmit() {
  const raw = $('firebase-config-input').value.trim();
  let config;
  try {
    const cleaned = raw.replace(/^\s*const\s+\w+\s*=\s*/, '').replace(/;?\s*$/, '');
    config = JSON.parse(cleaned);
  } catch {
    try {
      // Safe sanitized object parsing
      config = Function(`"use strict"; return (${raw})`)();
    } catch {
      toast('Invalid config — paste the JSON from Firebase console');
      return;
    }
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

async function handleGoogleSignIn() {
  try {
    $('signin-btn').disabled = true;
    $('signin-btn').textContent = 'Signing in…';

    const { user, deviceId } = await signInWithGoogle();
    S.uid      = user.uid;
    S.deviceId = deviceId;
    window._nexusDeviceId = deviceId;

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
    console.error('[signin]', err);
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
      $('signin-btn').disabled = false;
      $('signin-btn').textContent = 'Sign in with Google';
      return;
    }
    toast('Sign in failed: ' + err.message);
    $('signin-btn').disabled = false;
    $('signin-btn').textContent = 'Sign in with Google';
  }
}

async function handlePassphraseSetup() {
  const p1 = $('passphrase-1').value;
  const p2 = $('passphrase-2').value;

  if (p1.length < 8) { toast('Passphrase must be at least 8 characters'); return; }
  if (p1 !== p2)     { toast('Passphrases do not match'); return; }

  $('passphrase-setup-btn').disabled = true;
  $('passphrase-setup-btn').textContent = 'Generating keys…';

  try {
    const salt   = generateSalt();
    const key    = await deriveKey(p1, salt);
    const vector = await createVerificationVector(key);

    await keyStore.set(S.uid, key, salt, vector);
    S.encKey = key;

    const account = await getCurrentAccount();
    await setupProfile(
      S.uid, S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform(),
      salt, vector,
      account?.browser    ?? detectBrowser()
    );

    showScreen('s-pin-setup');
  } catch (err) {
    console.error('[passphrase setup]', err);
    toast('Key setup failed: ' + err.message);
    $('passphrase-setup-btn').disabled = false;
    $('passphrase-setup-btn').textContent = 'Set Passphrase & Continue';
  }
}

async function handlePassphraseEntry() {
  const pass = $('passphrase-entry-input').value;
  if (!pass) return;

  $('passphrase-entry-btn').disabled = true;
  $('passphrase-entry-btn').textContent = 'Verifying…';

  try {
    const profile = await getProfile(S.uid);
    if (!profile?.encryptionSalt) throw new Error('Account profile not found in Firebase');

    const key = await deriveKey(pass, profile.encryptionSalt);
    const vector = JSON.parse(profile.verificationVector);
    const valid = await verifyKey(key, vector);

    if (!valid) {
      toast('Incorrect passphrase. Please try again.');
      $('passphrase-entry-btn').disabled = false;
      $('passphrase-entry-btn').textContent = 'Unlock & Continue';
      $('passphrase-entry-input').value = '';
      $('passphrase-entry-input').focus();
      return;
    }

    await keyStore.set(S.uid, key, profile.encryptionSalt, vector);
    S.encKey = key;

    const account = await getCurrentAccount();
    await registerDevice(
      S.uid, S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform(),
      account?.browser    ?? detectBrowser()
    );

    const lockSetUp = await isLockSetUp(S.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(S.uid);
      setupVisibilityLock();
      await startChat();
    } else {
      showScreen('s-pin-setup');
    }
  } catch (err) {
    console.error('[passphrase entry]', err);
    toast('Verification failed: ' + err.message);
    $('passphrase-entry-btn').disabled = false;
    $('passphrase-entry-btn').textContent = 'Unlock & Continue';
  }
}

// PIN Setup flow
let _pinSetupStage  = 'first'; // 'first' | 'confirm'
let _pinSetupFirst  = '';
let _pinSetupBuffer = '';

function onPINSetupDigit(d) {
  if (_pinSetupBuffer.length >= 6) return;
  _pinSetupBuffer += d;
  const inp = $('setup-pin-input');
  if (inp) inp.value = _pinSetupBuffer;
  updatePINSetupDots();
  if (_pinSetupBuffer.length === 6) advancePINSetup();
}

function onPINSetupBackspace() {
  _pinSetupBuffer = _pinSetupBuffer.slice(0, -1);
  const inp = $('setup-pin-input');
  if (inp) inp.value = _pinSetupBuffer;
  updatePINSetupDots();
}

function updatePINSetupDots() {
  $$('.pin-setup-dot').forEach((d, i) => d.classList.toggle('filled', i < _pinSetupBuffer.length));
}

function advancePINSetup() {
  if (_pinSetupStage === 'first') {
    _pinSetupFirst  = _pinSetupBuffer;
    _pinSetupBuffer = '';
    _pinSetupStage  = 'confirm';
    const titleEl = $('pin-setup-title');
    const subEl   = $('pin-setup-sub');
    if (titleEl) titleEl.textContent = 'Confirm your PIN';
    if (subEl)   subEl.textContent   = 'Enter the same 6-digit PIN once more';
    const inp = $('setup-pin-input');
    if (inp) inp.value = '';
    updatePINSetupDots();
  } else {
    if (_pinSetupBuffer === _pinSetupFirst) {
      handlePINComplete(_pinSetupBuffer);
    } else {
      toast('PINs do not match. Try again.');
      initPINSetupScreen();
    }
  }
}

function onSetupPINInput(e) {
  const val = e.target.value.replace(/\D/g, '').slice(0, 6);
  _pinSetupBuffer = val;
  e.target.value = val;
  updatePINSetupDots();
  if (_pinSetupBuffer.length === 6) advancePINSetup();
}

function initPINSetupScreen() {
  _pinSetupStage  = 'first';
  _pinSetupFirst  = '';
  _pinSetupBuffer = '';
  const title = $('pin-setup-title');
  const sub   = $('pin-setup-sub');
  const inp   = $('setup-pin-input');
  if (title) title.textContent = 'Set up a PIN';
  if (sub)   sub.textContent   = 'Choose a 6-digit PIN to lock Nexus when idle';
  if (inp)   inp.value = '';
  updatePINSetupDots();
  setTimeout(() => $('setup-pin-input')?.focus(), 200);
}

async function handlePINComplete(pin) {
  try {
    await setupPIN(S.uid, pin);
    const bioAvail = await biometricsAvailable();
    if (bioAvail) {
      showScreen('s-biometrics-setup');
    } else {
      showScreen('s-device-name');
    }
  } catch (err) {
    console.error('[pin complete]', err);
    toast('PIN setup failed');
    initPINSetupScreen();
  }
}

async function handleBiometricSetup() {
  try {
    $('bio-setup-btn').disabled = true;
    $('bio-setup-btn').textContent = 'Registering…';
    const account = await getCurrentAccount();
    await setupBiometrics(S.uid, account.email);
    toast('Biometrics registered');
    showScreen('s-device-name');
  } catch (err) {
    console.error('[biometrics]', err);
    toast('Biometrics failed: ' + err.message);
    $('bio-setup-btn').disabled = false;
    $('bio-setup-btn').textContent = 'Enable Fingerprint / Face ID';
  }
}

async function handleDeviceNameDone() {
  const input = $('device-name-input');
  const name  = input.value.trim() || getDefaultDeviceName();

  await updateDeviceName(name);
  S.deviceName = name;

  setupVisibilityLock();
  unlock();
  await startChat();
}

function updateStrengthMeter(val) {
  const s = passphraseStrength(val);
  const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  const colors = ['#ef4444', '#f59e0b', '#fbbf24', '#34d399', '#10b981'];

  $$('.strength-seg').forEach((seg, i) => {
    seg.style.background = i <= s ? colors[s] : 'var(--border)';
  });
  const label = $('strength-label');
  if (label) {
    label.textContent = val ? labels[s] : '';
    label.style.color = colors[s];
  }
}

// ============================================================
// PHASE 4: EDIT, REPLY, SELECTION, CONTEXT MENU
// ============================================================
function onSelectRowClick(row) {
  if (_suppressNextSelectClick) return;
  const msgId = row.dataset.id;
  if (!msgId || msgId.startsWith('pending-')) return;
  if (SEL.selected.has(msgId)) {
    SEL.selected.delete(msgId);
    row.classList.remove('msg-selected');
  } else {
    SEL.selected.add(msgId);
    row.classList.add('msg-selected');
  }
  updateSelectToolbar(S);
}

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
        openContextMenu(_lpTarget, e, S, startReply, startEdit, confirmDelete, window.Nexus.openMedia);
      } else {
        const msgId = _lpTarget.dataset.id;
        if (msgId && !msgId.startsWith('pending-')) {
          if (navigator.vibrate) navigator.vibrate(30);
          _suppressNextSelectClick = true;
          setTimeout(() => { _suppressNextSelectClick = false; }, 600);
          enterSelectMode(msgId, S);
        }
      }
    }, 500);
  }

  function cancelLP() { clearTimeout(_lpTimer); _lpTimer = null; _lpTarget = null; }

  list.addEventListener('pointerdown', e => startLP(e.target, e));
  list.addEventListener('pointermove',  () => { _moved = true; cancelLP(); });
  list.addEventListener('pointerup',    cancelLP);
  list.addEventListener('pointercancel', cancelLP);

  list.addEventListener('contextmenu', e => {
    e.preventDefault();
    cancelLP();
    const row = e.target.closest('.msg-row');
    if (!row) return;

    if (SEL.active) {
      onSelectRowClick(row);
      return;
    }

    if (isMobileDevice()) {
      const msgId = row.dataset.id;
      if (msgId && !msgId.startsWith('pending-')) {
        if (navigator.vibrate) navigator.vibrate(30);
        _suppressNextSelectClick = true;
        setTimeout(() => { _suppressNextSelectClick = false; }, 600);
        enterSelectMode(msgId, S);
      }
    } else {
      openContextMenu(row, e, S, startReply, startEdit, confirmDelete, window.Nexus.openMedia);
    }
  });

  // Swipe right to reply
  let _swipeStartX = 0, _swipeStartY = 0, _swipeRow = null, _swipeActive = false;
  list.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
    const row = e.target.closest('.msg-row');
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

  // Double click on desktop to reply
  list.addEventListener('dblclick', e => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
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
}

function setupMessagesListInteractions() {
  const list = $('messages-list');
  if (!list || list.dataset.interactionsWired) return;
  list.dataset.interactionsWired = '1';

  list.addEventListener('click', e => {
    if (SEL.active) {
      const row = e.target.closest('.msg-row');
      if (row) {
        if (e.target.closest('.reply-quote') || e.target.closest('[data-reply-id]') ||
            e.target.closest('.msg-reactions') || e.target.closest('.reaction-pill') ||
            e.target.tagName === 'A') return;
        onSelectRowClick(row);
      }
      return;
    }

    const openMediaEl = e.target.closest('[data-open-media]');
    if (openMediaEl) {
      const uuid = openMediaEl.dataset.openMedia;
      if (uuid) window.Nexus.openMedia(uuid);
      return;
    }

    const loadAudioBtn = e.target.closest('[data-load-audio]');
    if (loadAudioBtn) {
      const uuid = loadAudioBtn.dataset.loadAudio;
      const cid  = loadAudioBtn.dataset.containerId;
      if (uuid && cid) window.Nexus.loadAudio(uuid, cid);
      return;
    }

    const reactEl = e.target.closest('[data-react-msg]');
    if (reactEl) {
      const mid = reactEl.dataset.reactMsg;
      const emo = reactEl.dataset.reactEmoji;
      if (mid && emo) window.Nexus.toggleReaction(mid, emo);
      return;
    }

    const quoteEl = e.target.closest('[data-reply-id]');
    if (quoteEl) {
      const rid = quoteEl.dataset.replyId;
      if (rid) window.Nexus.scrollToMsg(rid);
      return;
    }
  });
}

async function confirmDelete(msgId) {
  if (!await nexusConfirm('Delete this message for everyone?', { confirmLabel: 'Delete', danger: true })) return;
  try {
    const msg = S.messages.find(m => m.id === msgId);
    if (msg?.uuid && (msg.type === 'image' || msg.type === 'file')) {
      try {
        await deleteMedia(S.uid, msg.uuid);
      } catch (err) {
        console.warn('[delete] Drive cleanup failed:', err.message);
      }
    }
    await deleteMessage(S.uid, msgId);
  } catch (err) {
    toast('Delete failed: ' + err.message);
  }
}

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

function startReply(msg) {
  const rawText    = msg._decryptedText ?? '';
  const isMediaMsg = (msg.type === 'image' || msg.type === 'file');
  const isMetaJson = isMediaMsg && rawText.startsWith('{');
  const isVideo    = msg.mimeType?.startsWith('video/');
  const isAudio    = msg.mimeType?.startsWith('audio/');
  const mediaLabel = isVideo ? `🎬 ${msg.fileName ?? 'Video'}`
                   : isAudio ? `🎵 ${msg.fileName ?? 'Audio'}`
                   : `📎 ${msg.fileName ?? 'File'}`;
  const displayText = isMediaJson || !rawText
    ? (msg.type === 'image' ? (msg.caption ? `📷 Photo: ${msg.caption}` : '📷 Photo')
     : msg.type === 'file'  ? (msg.caption ? `${mediaLabel}: ${msg.caption}` : mediaLabel)
     : '…')
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
  if (wasEditing) {
    $('msg-input').value = '';
    autoResizeInput();
    if (S.uid) drafts.delete(S.uid).catch(() => {});
  }
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

  const update = () => {
    const h = banner.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--reply-banner-h', h + 'px');
  };

  if (_bannerObserver) _bannerObserver.disconnect();
  _bannerObserver = new ResizeObserver(update);
  _bannerObserver.observe(banner);
  requestAnimationFrame(update);
}

function hideReplyEditBanner() {
  if (_bannerObserver) { _bannerObserver.disconnect(); _bannerObserver = null; }
  $('reply-edit-banner')?.classList.add('hidden');
  document.documentElement.style.setProperty('--reply-banner-h', '0px');
}

// ============================================================
// EXPORT CHAT
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
        if (msg.type === 'image') text = `[Image: ${msg.fileName ?? 'photo'}${msg.caption ? ` - ${msg.caption}` : ''}]`;
        else if (msg.type === 'file') text = `[File: ${msg.fileName ?? 'file'}${msg.caption ? ` - ${msg.caption}` : ''}]`;
        else if (msg.ciphertext) {
          try { text = await decrypt(S.encKey, msg.ciphertext, msg.iv); }
          catch { text = '[Unable to decrypt]'; }
        }
      }
      if (msg.deleted) continue;
      decrypted.push({
        id:         msg.id,
        timestamp:  ts.toISOString(),
        sender:     msg.deviceId === S.deviceId ? 'You' : (S.devices[msg.deviceId]?.name ?? msg.deviceName ?? 'Other'),
        deviceId:   msg.deviceId,
        type:       msg.type ?? 'text',
        text:       text ?? '',
        caption:    msg.caption ?? null,
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
// PUSH NOTIFICATIONS
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
      if (status) status.textContent = 'Notifications enabled. Add FCM VAPID key in Firebase for background push.';
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
    if (status) status.textContent = 'Push notifications active.';
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
  const binary  = atob(base64);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
// ANIMATION STYLE
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

    const rawBrowser = dev.browser ?? 'browser';
    const browserLabelStr = browserLabel(rawBrowser);
    const platformLabel = {
      android: 'Android', ios: 'iOS', windows: 'Windows PC',
      linux: 'Linux PC', mac: 'Mac', unknown: 'Unknown',
    }[dev.platform ?? 'unknown'] ?? 'Unknown';

    const displayName = escHtml(dev.name ?? platformLabel);
    const devAvatar = _deviceAvatarCache.get(did);
    const avatarHtml = devAvatar
      ? `<div class="dev-list-avatar"><img src="${escAttr(devAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`
      : `<div class="dev-list-avatar dev-list-avatar-letter">${avatarLetter(dev.name ?? '?')}</div>`;

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
  $('setup-keyboard-btn')?.addEventListener('click', () => $('setup-pin-input')?.focus());
  $('setup-pin-input')?.addEventListener('input', onSetupPINInput);
  $('setup-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _pinSetupBuffer.length === 6) advancePINSetup();
  });

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
  $('lock-keyboard-btn')?.addEventListener('click', () => $('lock-pin-input')?.focus());
  $('lock-pin-input')?.addEventListener('input', onLockPINInput);
  $('lock-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _pinBuffer.length > 0) submitPIN();
  });
  $('lock-bio-btn')?.addEventListener('click', attemptBiometricUnlock);

  $('lock-use-passphrase-btn')?.addEventListener('click', async () => {
    const uid = S.uid ?? (await getCurrentAccount())?.uid;
    if (uid) {
      try {
        const ld = await lockStore.get(uid);
        if (ld) await lockStore.set(uid, { ...ld, failedAttempts: 0, lockedUntil: 0 });
      } catch {}
    }
    clearPINDisplay();
    showScreen('s-passphrase-entry');
  });

  // App Header
  $('header-avatar')?.addEventListener('click', openAccountSwitcher);
  $('header-settings-btn')?.addEventListener('click', openSettings);
  $('header-search-btn')?.addEventListener('click', () => openSearch(S, window.Nexus.scrollToMsg));

  // Chat input
  $('send-btn')?.addEventListener('click', handleSend);
  $('msg-input')?.addEventListener('input', onInputChange);
  $('msg-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Attachments
  const fileInp = $('file-input') || $('media-file-input');
  $('attach-btn')?.addEventListener('click', () => fileInp?.click());
  fileInp?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    showMediaPreview(file, S, handleMediaSend);
  });
  $('upload-cancel-btn')?.addEventListener('click', cancelCurrentUpload);

  // Clipboard paste (images)
  document.addEventListener('paste', async e => {
    if (S.currentScreen !== 's-app') return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    if (!S.spineConfig?.accounts?.length) {
      toast('No Drive accounts linked. Add one in Settings → Storage.');
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    showMediaPreview(file, S, handleMediaSend);
  });

  // Drag and drop files onto the chat area
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evName => {
    document.addEventListener(evName, e => e.preventDefault());
  });
  const dropTarget = $('s-app') || document.body;
  dropTarget.addEventListener('dragover', e => {
    e.preventDefault();
    dropTarget.classList.add('drag-over');
  });
  dropTarget.addEventListener('dragleave', e => {
    if (e.target === dropTarget) dropTarget.classList.remove('drag-over');
  });
  dropTarget.addEventListener('drop', e => {
    e.preventDefault();
    dropTarget.classList.remove('drag-over');
    if (S.currentScreen !== 's-app') return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!S.spineConfig?.accounts?.length) {
      toast('No Drive accounts linked. Add one in Settings → Storage.');
      return;
    }
    showMediaPreview(file, S, handleMediaSend);
  });

  // Settings Panel events
  $('settings-close-btn')?.addEventListener('click', () => hide('overlay-settings'));
  $('overlay-settings')?.addEventListener('click', e => {
    if (e.target === $('overlay-settings')) hide('overlay-settings');
  });

  // Account Switcher events
  $('account-overlay-close')?.addEventListener('click', () => hide('overlay-accounts'));
  $('accounts-close-btn')?.addEventListener('click', () => hide('overlay-accounts'));
  $('overlay-accounts')?.addEventListener('click', e => {
    if (e.target === $('overlay-accounts')) hide('overlay-accounts');
  });
  $('add-account-btn')?.addEventListener('click', () => {
    hide('overlay-accounts');
    showScreen('s-signin');
  });

  $('settings-accent-color')?.addEventListener('input', e => applyAccentColor(e.target.value));
  $('settings-accent-color')?.addEventListener('change', async e => {
    await saveAccentColor(S.deviceKey, e.target.value);
    toast('Accent colour saved');
  });
  $('settings-accent-reset')?.addEventListener('click', async () => {
    await clearAccentColor(S.deviceKey);
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    applyTheme(thId);
    $('settings-accent-color').value = THEMES[thId]?.vars['--accent'] ?? '#8b5cf6';
    toast('Accent colour reset');
  });

  $('settings-own-bubble-color')?.addEventListener('input', e => applyOwnBubbleColor(e.target.value));
  $('settings-own-bubble-color')?.addEventListener('change', async e => {
    await saveOwnBubbleColor(S.deviceKey, e.target.value);
    toast('Sent bubble colour saved');
  });
  $('settings-own-bubble-reset')?.addEventListener('click', async () => {
    await clearOwnBubbleColor(S.deviceKey);
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    applyTheme(thId);
    $('settings-own-bubble-color').value = THEMES[thId]?.vars['--own-bg'] ?? '#6d44d4';
    toast('Sent bubble colour reset');
  });

  $('settings-other-bubble-color')?.addEventListener('input', e => applyOtherBubbleColor(e.target.value));
  $('settings-other-bubble-color')?.addEventListener('change', async e => {
    await saveOtherBubbleColor(S.deviceKey, e.target.value);
    toast('Received bubble colour saved');
  });
  $('settings-other-bubble-reset')?.addEventListener('click', async () => {
    await clearOtherBubbleColor(S.deviceKey);
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    applyTheme(thId);
    $('settings-other-bubble-color').value = THEMES[thId]?.vars['--other-bg'] ?? '#141422';
    toast('Received bubble colour reset');
  });

  // Wallpaper triggers
  $('settings-wallpaper-btn')?.addEventListener('click', async () => {
    const cur = await settings.get(`appearance:wallpaper:${S.deviceKey}`);
    if (cur) {
      if (await nexusConfirm('A single image wallpaper is already set. Replace it?', { confirmLabel: 'Replace' })) {
        $('wallpaper-file-input')?.click();
      }
    } else {
      $('wallpaper-file-input')?.click();
    }
  });

  $('wallpaper-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const cropped = await cropImage(file, 'rect');
      const dataUrl = cropped;
      applyWallpaper(dataUrl);
      await saveWallpaper(S.deviceKey, dataUrl);
      $('settings-wallpaper-preview').src = dataUrl;
      $('settings-wallpaper-preview').classList.remove('hidden');
      $('settings-wallpaper-remove').classList.remove('hidden');
      toast('Wallpaper saved');
    } catch (err) {
      if (err.message !== 'cancelled') toast('Wallpaper failed: ' + err.message);
    }
    e.target.value = '';
  });

  $('settings-slideshow-btn')?.addEventListener('click', async () => {
    const slides = await loadSlideshowWallpaper(S.deviceKey);
    if (slides.length > 0) {
      openSlideshowEditor(slides, S, async (updatedSlides, interval, opts) => {
        await saveSlideshowWallpaper(S.deviceKey, updatedSlides);
        startSlideshowWallpaper(updatedSlides, interval * 1000, opts);
        $('settings-wallpaper-remove')?.classList.remove('hidden');
      });
    } else {
      $('slideshow-file-input')?.click();
    }
  });

  $('slideshow-file-input')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      const dataUrls = [];
      for (const f of files) dataUrls.push(await compressWallpaper(f));
      const existing = await loadSlideshowWallpaper(S.deviceKey);
      const combined = [...existing, ...dataUrls];
      await saveSlideshowWallpaper(S.deviceKey, combined);
      const storedInterval = (await settings.get(`anim_slideshow_interval:${S.deviceKey}`)) ?? 30;
      const opts = await loadSlideshowOpts(S.deviceKey);
      startSlideshowWallpaper(combined, storedInterval * 1000, opts);
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      $('slideshow-settings-block')?.classList.remove('hidden');
      toast(`Slideshow updated (${combined.length} images)`);
    } catch (err) {
      toast('Slideshow failed: ' + err.message);
    }
    e.target.value = '';
  });

  $('settings-video-wall-btn')?.addEventListener('click', async () => {
    const cur = await loadVideoWallpaper(S.deviceKey);
    if (cur) {
      openVideoEditor(S, () => {
        $('settings-wallpaper-preview')?.classList.add('hidden');
      });
    } else {
      $('video-wall-file-input')?.click();
    }
  });

  $('video-wall-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result;
        applyVideoWallpaper(dataUrl);
        await saveVideoWallpaper(S.deviceKey, dataUrl);
        $('settings-wallpaper-remove')?.classList.remove('hidden');
        $('settings-wallpaper-preview')?.classList.add('hidden');
        toast('Video wallpaper set');
      };
      reader.readAsDataURL(file);
    } catch (err) {
      toast('Video wallpaper failed: ' + err.message);
    }
    e.target.value = '';
  });

  $('settings-wallpaper-remove')?.addEventListener('click', async () => {
    await clearWallpaper(S.deviceKey);
    await clearSlideshowWallpaper(S.deviceKey);
    await clearVideoWallpaper(S.deviceKey);
    applyWallpaper(null);
    stopSlideshowWallpaper();
    removeVideoWallpaper();
    $('settings-wallpaper-preview')?.classList.add('hidden');
    $('settings-wallpaper-remove')?.classList.add('hidden');
    $('slideshow-settings-block')?.classList.add('hidden');
    toast('Wallpaper removed');
  });

  $('settings-device-name')?.addEventListener('change', async e => {
    const val = e.target.value.trim();
    if (!val) return;
    await updateDeviceName(val);
    S.deviceName = val;
    $('header-title').textContent = val;
    toast('Device name saved');
  });

  $('settings-autolock')?.addEventListener('change', async e => {
    const mins = parseInt(e.target.value, 10);
    await setAutoLockMinutes(S.uid, mins);
    toast(`Auto-lock set to ${mins === 0 ? 'Never' : mins + ' min'}`);
  });

  $('settings-avatar-btn')?.addEventListener('click', () => $('avatar-file-input')?.click());
  $('avatar-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const cropped = await cropImage(file, 'circle');
      const dataUrl = cropped;
      const { ciphertext, iv } = await encrypt(S.encKey, dataUrl);
      await updateDeviceAvatar(S.uid, S.deviceId, JSON.stringify({ ciphertext, iv }));
      S.avatarDataUrl = dataUrl;
      _deviceAvatarCache.set(S.deviceId, dataUrl);
      updateAvatarDisplay();
      toast('Profile photo updated');
    } catch (err) {
      if (err.message !== 'cancelled') toast('Avatar failed: ' + err.message);
    }
    e.target.value = '';
  });

  $('settings-avatar-remove-btn')?.addEventListener('click', async () => {
    await updateDeviceAvatar(S.uid, S.deviceId, null);
    S.avatarDataUrl = null;
    _deviceAvatarCache.delete(S.deviceId);
    updateAvatarDisplay();
    toast('Profile photo removed');
  });

  $('settings-push-btn')?.addEventListener('click', handlePushToggle);

  $('settings-anim-style')?.addEventListener('change', async e => {
    const style = e.target.value;
    await settings.set(`anim_style:${S.deviceKey}`, style);
    applyAnimStyle(style);
    toast('Animation style updated');
  });

  $('settings-font-size')?.addEventListener('input', e => {
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
    hide('overlay-settings');
    openChangePassphrase(S, newKey => { S.encKey = newKey; });
  });

  $('settings-add-drive-btn')?.addEventListener('click', async () => {
    try {
      const { GoogleAuthProvider, signInWithPopup, getAuth } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/drive.file');
      provider.setCustomParameters({ prompt: 'select_account' });

      const auth = getAuth();
      const originalUser = auth.currentUser;
      const result = await signInWithPopup(auth, provider);
      const cred   = GoogleAuthProvider.credentialFromResult(result);

      if (result.user.uid !== S.uid && originalUser) {
        try { await auth.updateCurrentUser(originalUser); } catch {}
      }

      if (cred?.accessToken) {
        const driveUid = result.user.uid;
        storeDriveToken(driveUid, cred.accessToken, 3600);
        await addSpineAccount(S.uid, driveUid, result.user.email, 5 * 1024 ** 3);
        S.spineConfig = await getSpineConfig(S.uid);
        toast(`Added Drive account: ${result.user.email}`);
        renderStorageSummary();
      }
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      toast('Failed to add Drive account: ' + err.message);
    }
  });

  $('settings-migrate-btn')?.addEventListener('click', () => {
    openSpineMigration(S, updatedConfig => {
      S.spineConfig = updatedConfig;
      renderStorageSummary();
    });
  });

  $('export-json-btn')?.addEventListener('click', () => exportChat('json'));
  $('export-txt-btn')?.addEventListener('click',  () => exportChat('txt'));

  $('settings-signout-btn')?.addEventListener('click', async () => {
    if (!await nexusConfirm('Sign out of this account? Your messages remain securely encrypted in Firebase.', { confirmLabel: 'Sign Out', danger: true })) return;
    clearUnsubscribers();
    await signOut();
    location.reload();
  });

  $('firebase-index-dismiss-btn')?.addEventListener('click', async () => {
    await settings.set('firebase_index_notice_dismissed', true);
    $('firebase-index-notice')?.classList.add('hidden');
  });

  // Start edit custom event from chat view
  window.addEventListener('nexus:start-edit', e => {
    if (e.detail) startEdit(e.detail);
  });

  // Keyboard Escape cascade
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const mp = document.getElementById('media-preview-overlay');
      if (mp && !mp.classList.contains('hidden')) { closeMediaPreview(); return; }
      if (document.getElementById('ctx-menu')) { closeContextMenu(); return; }
      const lb = document.getElementById('media-lightbox');
      if (lb && !lb.classList.contains('hidden')) { lb.querySelector('.lb-close')?.click(); return; }
      const modal = document.querySelector('.migrate-modal, #crop-overlay, #nexus-confirm-overlay, #nexus-prompt-overlay, #pcp-modal, #slideshow-editor-modal');
      if (modal) {
        const cancelBtn = modal.querySelector('.btn-ghost, .cancel-btn');
        if (cancelBtn) cancelBtn.click();
        else modal.remove();
        return;
      }
      if (SEL.active) { exitSelectMode(); return; }
      if (P4.editingMsgId || P4.replyToMsg) { cancelReplyEdit(); return; }
      const hdr = document.querySelector('.app-header');
      if (hdr?.classList.contains('search-active')) { closeSearch(); return; }
      if (!$('overlay-settings')?.classList.contains('hidden')) { hide('overlay-settings'); return; }
      if (!$('overlay-accounts')?.classList.contains('hidden')) { hide('overlay-accounts'); return; }
    }
  });
}

// ============================================================
// ANDROID BACK GESTURE (NON-TRAPPING)
// ============================================================
function pushBackEntry() {
  history.pushState({ nexusLayer: true }, '');
}

function handleBackGesture() {
  const mp = document.getElementById('media-preview-overlay');
  if (mp && !mp.classList.contains('hidden')) { closeMediaPreview(); return true; }

  if (document.getElementById('ctx-menu')) { closeContextMenu(); return true; }

  const lb = document.getElementById('media-lightbox');
  if (lb && !lb.classList.contains('hidden')) { lb.querySelector('.lb-close')?.click(); return true; }

  const modal = document.querySelector('.migrate-modal, #crop-overlay, #nexus-confirm-overlay, #nexus-prompt-overlay, #pcp-modal, #slideshow-editor-modal');
  if (modal) {
    const cancelBtn = modal.querySelector('.btn-ghost, .cancel-btn');
    if (cancelBtn) cancelBtn.click();
    else modal.remove();
    return true;
  }

  if (SEL.active) { exitSelectMode(); return true; }
  if (P4.editingMsgId || P4.replyToMsg) { cancelReplyEdit(); return true; }

  const hdr = document.querySelector('.app-header');
  if (hdr?.classList.contains('search-active')) { closeSearch(); return true; }

  if (!$('overlay-settings')?.classList.contains('hidden')) { hide('overlay-settings'); return true; }
  if (!$('overlay-accounts')?.classList.contains('hidden')) { hide('overlay-accounts'); return true; }

  return false;
}

window.addEventListener('popstate', () => {
  handleBackGesture();
});

document.addEventListener('nexus:layeropen', () => pushBackEntry());

// ============================================================
// LOCK EVENT LISTENER
// ============================================================
document.addEventListener('nexus:locked', () => {
  hide('overlay-settings');
  hide('overlay-accounts');
  closeSearch();
  const lockableScreens = ['s-app', 's-passphrase-entry', 's-pin-setup', 's-biometrics-setup', 's-device-name'];
  if (lockableScreens.includes(S.currentScreen)) showLockScreen();
});

// ============================================================
// BOOTSTRAP
// ============================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    init().catch(err => console.error('[boot]', err));
  });
} else {
  bindEvents();
  init().catch(err => console.error('[boot]', err));
}
