// src/app.js
// Nexus — main application logic.
// Orchestrates: initialization flow, screen management, real-time messaging,
// encryption, lock screen, account switching, offline queue, and UI rendering.

import { initDB, settings, keyStore, queue, drafts }
  from './db.js';
import { deriveKey, generateSalt, encrypt, decrypt,
         createVerificationVector, verifyKey, passphraseStrength }
  from './crypto.js';
import { initFirebase, signInWithGoogle, getCurrentAccount, listAccounts,
         signOut, switchToAccount, updateDeviceName,
         getDefaultDeviceName, detectPlatform, platformIcon }
  from './auth.js';
import { setupProfile, registerDevice, getProfile, sendMessage as fbSendMessage,
         subscribeMessages, subscribeTyping, subscribePresence, setupPresence,
         markRead, setTyping, subscribeDevices, touchDevice }
  from './realtime.js';
import { setupPIN, verifyPIN, isLockSetUp, setupBiometrics,
         authenticateBiometrics, biometricsAvailable, isBiometricsEnabled,
         lock, unlock, loadAutoLockSetting, setupVisibilityLock,
         setAutoLockMinutes, startAutoLockTimer }
  from './lock.js';
import { THEMES, applyTheme, loadTheme, saveTheme } from './themes.js';
import { saveAccentColor, clearAccentColor, saveOwnBubbleColor, clearOwnBubbleColor,
         saveWallpaper, clearWallpaper, applyAccentColor, applyOwnBubbleColor,
         applyWallpaper, compressWallpaper, compressAvatar,
         applyStoredAppearance, loadAppearance } from './appearance.js';
import { cancelCurrentUpload } from './drive.js';
import { getSpineConfig, addSpineAccount, removeSpineAccount,
         getStorageSummary, getManifestEntry,
         checkAndRestoreFolders } from './spine.js';
import { prepareMediaMessage, fetchMedia, decryptThumbnail,
         buildFileBubbleHTML, formatBytes } from './media.js';
import { updateProfileAvatar } from './realtime.js';

// ============================================================
// STATE
// ============================================================
const S = {
  uid:           null,   // Firebase UID
  deviceId:      null,
  deviceName:    null,
  platform:      null,
  encKey:        null,   // AES-256-GCM CryptoKey (in memory only after unlock)
  messages:      [],
  devices:       {},
  typingDevices: [],
  presenceMap:   {},
  unsubscribers: [],     // cleanup array for Firebase listeners
  isOnline:      navigator.onLine,
  currentScreen: 'loading',
  installPrompt: null,   // PWA install prompt event
  config:        null,   // Firebase config object
  sendInProgress:  false,
  spineConfig:     null,   // loaded after sign-in
  mediaUploading:  false,  // prevents concurrent uploads
  pendingMessages: new Map(), // ciphertext → localId for optimistic offline rendering
  avatarDataUrl:   null,   // decrypted profile picture data URL
  email:           null,   // current account email
};

// ============================================================
// DOM HELPERS
// ============================================================
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
         ('ontouchstart' in window && navigator.maxTouchPoints > 1);
}

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function show(id)          { $(id)?.classList.remove('hidden'); }
function hide(id)          { $(id)?.classList.add('hidden'); }
function toggle(id, v)     { $(id)?.classList.toggle('hidden', !v); }

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
}

// ============================================================
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

    // Re-apply per-account theme now that we know the uid
    const accountTheme = await loadTheme(account.uid);
    applyTheme(accountTheme);

    S.uid        = account.uid;
    S.deviceId   = account.deviceId;
    S.deviceName = account.deviceName;
    S.platform   = account.platform ?? detectPlatform();

    setLoading('Checking lock…');
    const lockSetUp = await isLockSetUp(account.uid);
    if (lockSetUp) {
      await loadAutoLockSetting(account.uid);
      setupVisibilityLock();
      showLockScreen();
    } else {
      // Account exists but lock not yet set up — finish onboarding
      await tryAutoInit();
    }

    // Setup PWA install button
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      S.installPrompt = e;
      show('install-btn-wrap');
    });

    // Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'NEXUS_DRAIN_QUEUE') drainQueue();
          });
        })
        .catch(e => console.warn('[sw] Registration failed:', e));
    }

  } catch (err) {
    console.error('[init]', err);
    setLoading('Error: ' + err.message);
    showScreen('s-loading');
  }
}

// Attempt to skip remaining setup steps if already completed on this device
async function tryAutoInit() {
  const keyData = await keyStore.get(S.uid);
  if (keyData?.key) {
    // Key already derived and stored — go to lock or chat
    S.encKey = keyData.key;
    const lockSetUp = await isLockSetUp(S.uid);
    if (lockSetUp) {
      showLockScreen();
    } else {
      // Need to set up lock still
      showScreen('s-pin-setup');
    }
  } else {
    // Need passphrase (new device or key cleared)
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
      if (S.avatarDataUrl) {
        lockAv.innerHTML = `<img src="${S.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        lockAv.textContent = avatarLetter(account.email);
      }
    }
    $('lock-email').textContent = account.email;
  }

  const bioAvail    = await biometricsAvailable();
  const bioEnabled  = await isBiometricsEnabled(S.uid ?? account?.uid);
  toggle('lock-bio-btn', bioAvail && bioEnabled);
  toggle('lock-bio-hint', bioAvail && bioEnabled);

  clearPINDisplay();
  showScreen('s-lock');

  // Hide on-screen numpad — use native keyboard on all platforms.
  const numpad = $('lock-numpad');
  if (numpad) numpad.classList.add('hidden');

  // Show the tap-to-type button and keyboard hint
  const hint = $('lock-keyboard-hint');
  if (hint) hint.classList.remove('hidden');

  const inp = $('lock-pin-input');
  if (inp) inp.value = '';

  // On desktop: auto-focus works fine
  // On mobile: browsers block programmatic focus unless inside a user gesture,
  // so we show a dedicated button the user taps to invoke the keyboard.
  // We also wire the dots row and the hint button to focus the input.
  // Remove any previously attached listeners before adding fresh ones
  // to prevent accumulation across multiple auto-lock cycles.
  const dotsRow   = $('pin-dots-row');
  const kbBtn     = $('lock-keyboard-btn');
  const newDotsRow = dotsRow?.cloneNode(true);
  const newKbBtn   = kbBtn?.cloneNode(true);
  if (dotsRow && newDotsRow)   dotsRow.parentNode.replaceChild(newDotsRow, dotsRow);
  if (kbBtn   && newKbBtn)     kbBtn.parentNode.replaceChild(newKbBtn,   kbBtn);

  function focusLockInput() {
    const i = $('lock-pin-input');
    if (i) i.focus(); // focus() is sufficient; click() does not open keyboard on mobile
  }

  $('pin-dots-row')?.addEventListener('click', focusLockInput);
  $('lock-keyboard-btn')?.addEventListener('click', focusLockInput);

  // On desktop auto-focus after transition
  if (!isMobileDevice()) {
    setTimeout(focusLockInput, 350);
  }

  // Auto-trigger biometrics
  if (bioAvail && bioEnabled) {
    setTimeout(() => attemptBiometricUnlock(), 400);
  }
}

async function attemptBiometricUnlock() {
  const uid = S.uid ?? (await getCurrentAccount())?.uid;
  if (!uid) return;
  try {
    const ok = await authenticateBiometrics(uid);
    if (ok) await afterUnlock(uid);
    else toast('Biometric authentication failed — enter PIN');
  } catch (err) {
    toast('Biometrics unavailable');
  }
}

async function afterUnlock(uid) {
  // Load encryption key
  const keyData = await keyStore.get(uid);
  if (!keyData?.key) {
    // Key lost — need passphrase re-entry
    S.uid = uid;
    showScreen('s-passphrase-entry');
    return;
  }
  S.encKey = keyData.key;
  unlock(); // unlock() calls resetAutoLockTimer → startAutoLockTimer
  await startChat();
}

// PIN pad logic
let _pinBuffer = '';
function clearPINDisplay() {
  _pinBuffer = '';
  updatePINDots();
  const inp = $('lock-pin-input');
  if (inp) inp.value = '';
}

function updatePINDots() {
  const dots = $$('.pin-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('filled', i < _pinBuffer.length);
  });
}

function onPINDigit(d) {
  if (_pinBuffer.length >= 6) return;
  _pinBuffer += d;
  updatePINDots();
  if (_pinBuffer.length === 6) setTimeout(submitPIN, 150);
}

function onPINBackspace() {
  _pinBuffer = _pinBuffer.slice(0, -1);
  updatePINDots();
}

function onLockPINInput(e) {
  const raw = (e.target.value || '').replace(/\D/g, '').slice(0, 6);
  e.target.value = raw;
  _pinBuffer = raw;
  updatePINDots();
  if (_pinBuffer.length === 6) setTimeout(submitPIN, 150);
}

async function submitPIN() {
  const uid = S.uid ?? (await getCurrentAccount())?.uid;
  if (!uid) return;
  const ok = await verifyPIN(uid, _pinBuffer);
  if (ok) {
    await afterUnlock(uid);
  } else {
    toast('Incorrect PIN');
    clearPINDisplay();
    // Shake animation
    $('pin-dots-row')?.classList.add('shake');
    setTimeout(() => $('pin-dots-row')?.classList.remove('shake'), 500);
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
  S.deviceName = account.deviceName;
  S.platform   = account.platform ?? detectPlatform();
  S.email      = account.email;

  // Update header
  $('header-avatar').textContent = avatarLetter(account.email);
  $('header-title').textContent  = 'Nexus';

  // Load draft
  const draft = await drafts.get(S.uid);
  $('msg-input').value = draft;

  // Setup Firebase presence
  try {
    await touchDevice(S.uid, S.deviceId);
    await setupPresence(S.uid, S.deviceId, S.deviceName);
  } catch (e) { console.warn('[presence]', e); }

  // Subscribe to real-time data
  clearUnsubscribers();

  S.unsubscribers.push(
    subscribeMessages(S.uid, handleIncomingMessages)
  );
  S.unsubscribers.push(
    subscribeTyping(S.uid, S.deviceId, devs => {
      S.typingDevices = devs;
      renderTypingIndicator();
    })
  );
  S.unsubscribers.push(
    subscribePresence(S.uid, S.deviceId, map => {
      S.presenceMap = map;
      renderOnlineStatus();
    })
  );
  S.unsubscribers.push(
    subscribeDevices(S.uid, devMap => {
      S.devices = devMap;
    })
  );

  // Connectivity listeners — remove old ones first to prevent accumulation
  // across account switches and re-logins.
  window.removeEventListener('online',  onOnline);
  window.removeEventListener('offline', onOffline);
  window.addEventListener('online',     onOnline);
  window.addEventListener('offline',    onOffline);
  updateConnectivityUI();

  showScreen('s-app');
  // Do NOT scroll here — messages haven't loaded yet (Firebase is async).
  // scrollToBottom is called inside renderMessages after the DOM is updated.

  // Apply per-account theme then appearance overrides
  const themeId = await loadTheme(S.uid);
  applyTheme(themeId);
  await applyStoredAppearance(S.uid);

  // Load and display profile picture
  await loadAndApplyAvatar();

  // Ensure auto-lock timer is running now that chat is open
  startAutoLockTimer();

  // Phase 2: check if any Nexus Drive folders were trashed and restore
  checkAndRestoreFolders(S.uid).catch(() => {});

  // Phase 2: load Spine config into state
  getSpineConfig(S.uid).then(cfg => { S.spineConfig = cfg; }).catch(() => {});

  // Drain any messages queued from a previous offline session.
  // onOnline() handles mid-session recovery; this handles app-reopen-while-online.
  if (S.isOnline) drainQueue();
}

function clearUnsubscribers() {
  S.unsubscribers.forEach(fn => { try { fn(); } catch {} });
  S.unsubscribers = [];
  _renderedMsgs.clear(); // reset render cache on account switch
  S.pendingMessages.clear(); // clear pending bubbles on account switch
}

// ============================================================
// MESSAGES
// ============================================================
async function handleIncomingMessages(messages) {
  // Remove any pending (optimistic) bubbles whose messages have been
  // confirmed delivered by Firebase. We match by ciphertext — unique per message.
  if (S.pendingMessages.size > 0) {
    for (const msg of messages) {
      if (msg.deviceId === S.deviceId && msg.ciphertext) {
        removePendingBubble(msg.ciphertext);
      }
    }
  }

  S.messages = messages;
  await renderMessages(messages);

  // Mark visible messages as read
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

// Track rendered message IDs and decrypted text to avoid re-rendering.
const _renderedMsgs    = new Map(); // msgId → { text, readByOthers }

async function renderMessages(messages) {
  const container = $('messages-list');
  if (!messages.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#128274;</div>
        <div class="empty-title">No messages yet</div>
        <div class="empty-sub">Messages are encrypted end-to-end.<br>Only your devices can read them.</div>
      </div>`;
    _renderedMsgs.clear();
    return;
  }

  // Remove empty-state if it's still showing
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  // Build full list of IDs in correct order
  const incomingIds = messages.map(m => m.id);

  // Check if we need a full rebuild:
  // - first render (no children yet beyond empty state)
  // - order changed (insertion into middle)
  // - a message was deleted (count decreased without new messages)
  const existingIds = Array.from(container.querySelectorAll('.msg-row'))
    .map(el => el.dataset.id);

  const needsFullRebuild = existingIds.length === 0 ||
    existingIds.length > incomingIds.length ||
    incomingIds.slice(0, existingIds.length).some((id, i) => id !== existingIds[i]);

  if (needsFullRebuild) {
    // Full rebuild — decrypt everything and render from scratch
    _renderedMsgs.clear();
    const decrypted = await decryptBatch(messages);
    container.innerHTML = buildFullHTML(decrypted);
    // Scroll to bottom immediately after full rebuild
    scrollToBottom(true);
    // Trigger async thumbnail loads for all image messages
    for (const msg of decrypted) {
      if (msg.type === 'image' && msg.encThumb && S.encKey) {
        loadThumbnailAsync(msg);
      }
    }
    return;
  }

  // Incremental update — only process new messages appended to the end
  const newMsgs = messages.slice(existingIds.length);
  if (!newMsgs.length) {
    // Only read-receipt updates — patch existing ticks without re-rendering
    for (const msg of messages) {
      const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
      const prev = _renderedMsgs.get(msg.id);
      if (prev && prev.readByOthers !== readByOthers) {
        const tickEl = container.querySelector(`.msg-row[data-id="${msg.id}"] .read-tick`);
        if (tickEl) {
          tickEl.className = `read-tick${readByOthers ? ' read' : ''}`;
          tickEl.innerHTML = readByOthers ? '&#10003;&#10003;' : '&#10003;';
        }
        prev.readByOthers = readByOthers;
      }
    }
    return;
  }

  // Append only the new messages
  // Also register existing messages in _renderedMsgs so tick patches work
  // (they were only registered during full rebuild, not incremental appends).
  for (const msg of messages.slice(0, existingIds.length)) {
    if (!_renderedMsgs.has(msg.id)) {
      const readByOthers = Object.keys(msg.readBy ?? {}).some(did => did !== S.deviceId);
      _renderedMsgs.set(msg.id, { readByOthers });
    }
  }

  const decryptedNew = await decryptBatch(newMsgs);
  // Compute context for device-name grouping
  const lastExisting = messages[existingIds.length - 1];
  let lastDevice = lastExisting?.deviceId ?? '';
  let lastDate   = '';
  if (existingIds.length > 0) {
    const lastTs = lastExisting?.timestamp ? new Date(lastExisting.timestamp) : new Date();
    lastDate = lastTs.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
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

  // Async thumbnail loads for new image messages
  for (const msg of decryptedNew) {
    if (msg.type === 'image' && msg.encThumb && S.encKey) {
      loadThumbnailAsync(msg);
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
      out.push({ ...msg, text });
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
    _renderedMsgs.set(msg.id, { readByOthers });
    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers);
  }
  return html;
}

// Async thumbnail loader — targets the specific element by ID, safe after innerHTML.
function loadThumbnailAsync(msg) {
  decryptThumbnail(S.encKey, msg.encThumb).then(thumb => {
    if (!thumb) return;
    const el = document.getElementById(`thumb-${msg.id}`);
    if (!el) return; // element no longer in DOM (full rebuild happened) — safe to ignore
    el.innerHTML = `<img class="msg-thumb" src="${thumb}" alt="${escHtml(msg.fileName ?? 'Image')}"
      loading="lazy" onclick="Nexus.openMedia('${escHtml(msg.uuid)}')">
      <div class="media-caption">${escHtml(msg.fileName ?? '')}</div>`;
  }).catch(() => {});
}

function buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers) {
  const side  = isOwn ? 'own' : 'other';
  const devPlatform = S.devices[msg.deviceId]?.platform ?? 'unknown';

  let content = '';
  if (msg.isDeleted) {
    content = `<em class="deleted-text">This message was deleted</em>`;
  } else if (msg.decryptError) {
    content = `<span class="decrypt-error">${escHtml(msg.text)}</span>`;
  } else if (msg.type === 'image' && msg.uuid) {
    // Thumbnail is decrypted asynchronously after render
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
    // Async thumbnail load
    if (msg.encThumb && S.encKey) {
      decryptThumbnail(S.encKey, msg.encThumb).then(thumb => {
        if (!thumb) return;
        const el = document.getElementById(thumbId);
        if (el) el.innerHTML = `<img class="msg-thumb" src="${thumb}" alt="${escHtml(msg.fileName ?? 'Image')}"
          loading="lazy" onclick="Nexus.openMedia('${escHtml(msg.uuid)}')">
          <div class="media-caption">${escHtml(msg.fileName ?? '')}</div>`;
      }).catch(() => {});
    }
  } else if (msg.type === 'file' && msg.uuid) {
    content = buildFileBubbleHTML(msg);
  } else {
    content = formatText(escHtml(msg.text ?? ''));
  }

  const deviceBadge = showDeviceName
    ? `<div class="msg-device">${platformIcon(devPlatform)} ${escHtml(msg.deviceName ?? 'Unknown device')}</div>`
    : '';

  const readTick = isOwn
    ? `<span class="read-tick ${readByOthers ? 'read' : ''}" title="${readByOthers ? 'Read' : 'Sent'}">
        ${readByOthers ? '&#10003;&#10003;' : '&#10003;'}
       </span>`
    : '';

  return `
    <div class="msg-row ${side}" data-id="${escHtml(msg.id)}">
      ${deviceBadge}
      <div class="msg-bubble">
        ${content}
        <div class="msg-meta">
          <span class="msg-time">${time}</span>
          ${readTick}
        </div>
      </div>
    </div>`;
}

// Expose bubble click for inline onclick (needed because messages are innerHTML)
window.Nexus = window.Nexus ?? {};
// Open media — download and show in a lightbox or trigger download
window.Nexus.openMedia = async function(uuid) {
  if (!S.encKey || !S.uid) return;
  try {
    // Fetch manifest entry first (uses static import — no dynamic import needed)
    const entry = await getManifestEntry(S.uid, uuid);
    if (!entry) { toast('Media not found'); return; }

    const url = await fetchMedia(S.uid, S.encKey, uuid);

    // Use mimeType to determine whether to show lightbox or trigger download.
    // (mediaType is in the Firebase message payload, not the manifest; using
    //  mimeType from the manifest is equivalent and more reliable.)
    if (entry.mimeType?.startsWith('image/')) {
      showLightbox(url, entry.fileName);
    } else {
      const a = document.createElement('a');
      a.href     = url;
      a.download = entry.fileName ?? 'download';
      a.click();
      // Revoke after a short delay to allow the download to start
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

    // Close handlers are set up ONCE on the element, not per-call.
    // They read the current URL from the element's dataset to avoid
    // accumulating stale handlers across multiple openings.
    const closeLightbox = () => {
      const activeUrl = lb.dataset.activeUrl;
      if (activeUrl) { URL.revokeObjectURL(activeUrl); delete lb.dataset.activeUrl; }
      lb.querySelector('#lb-img').src = '';
      lb.classList.add('hidden');
    };
    lb.querySelector('.lb-backdrop').addEventListener('click', closeLightbox);
    lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
  }

  const imgEl = lb.querySelector('#lb-img');
  // Revoke previous object URL if there is one
  if (lb.dataset.activeUrl) {
    URL.revokeObjectURL(lb.dataset.activeUrl);
  }

  lb.dataset.activeUrl = url;
  imgEl.src = url;
  lb.querySelector('#lb-title').textContent = title ?? '';
  lb.classList.remove('hidden');
}

// Simple text formatter: bold, italic, mono
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
    const onProgress = frac => updateUploadProgress(frac);
    const mediaPayload = await prepareMediaMessage(S.uid, S.encKey, file, onProgress);

    // Encrypt the media metadata (filename, uuid reference) as the message content
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
      type:       mediaPayload.mediaType, // 'image' or 'file'
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
    } else {
      await queue.add(S.uid, payload);
      toast('Queued — will send when online');
    }

    toast('Sent');
  } catch (err) {
    console.error('[media send]', err);
    if (err.message === 'Upload cancelled') {
      toast('Upload cancelled');
    } else {
      toast('Upload failed: ' + err.message);
    }
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

  S.sendInProgress = true;
  setSendBtnState(false);

  // Clear draft
  input.value = '';
  autoResizeInput();
  await drafts.delete(S.uid);

  // Stop typing indicator
  try { await setTyping(S.uid, S.deviceId, false); } catch {}

  try {
    const { ciphertext, iv } = await encrypt(S.encKey, text);

    const payload = {
      ciphertext,
      iv,
      type:       'text',
      deviceId:   S.deviceId,
      deviceName: S.deviceName,
    };

    // Always show the pending bubble immediately.
    // Firebase Realtime DB silently buffers writes when offline — fbSendMessage
    // never throws even when there's no connection, so we cannot rely on a catch
    // block to detect offline state. Instead we always render optimistically and
    // let the real-time listener remove the bubble when Firebase confirms delivery.
    const localId = renderPendingBubble(payload, text);

    try {
      await fbSendMessage(S.uid, payload);
      // Message sent to Firebase — the real-time listener will fire shortly
      // and removePendingBubble() will clean up the optimistic bubble.
    } catch (err) {
      // Firebase write failed — queue for later delivery
      await queue.add(S.uid, payload);
      toast('No connection — will send when online');
      // Register background sync
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg.sync) reg.sync.register('nexus-send-queue').catch(() => {});
      }
    }
  } catch (err) {
    console.error('[send]', err);
    toast('Failed to send message');
    input.value = text; // Restore text
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
// PENDING (OPTIMISTIC) BUBBLE RENDERING
// ============================================================
// Immediately shows a message bubble with a clock icon when the message
// is queued offline. Removed once Firebase confirms delivery.

function renderPendingBubble(payload, plaintextForDisplay) {
  const localId   = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now       = new Date();
  const time      = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', hour12: true });

  // Track by ciphertext so we can remove it when Firebase delivers the real msg
  S.pendingMessages.set(payload.ciphertext, localId);

  const container = $('messages-list');
  if (!container) return;

  // Remove empty state if present
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const html = `
    <div class="msg-row own pending-bubble" data-pending-id="${localId}" data-id="${localId}">
      <div class="msg-bubble">
        ${formatText(escHtml(plaintextForDisplay))}
        <div class="msg-meta">
          <span class="msg-time">${time}</span>
          <span class="read-tick pending-tick" title="Pending">&#128336;</span>
        </div>
      </div>
    </div>`;

  container.insertAdjacentHTML('beforeend', html);
  scrollToBottom(true);
  return localId;
}

// Remove a pending bubble once its message has been delivered to Firebase.
// Called from handleIncomingMessages when a matching ciphertext is found.
function removePendingBubble(ciphertext) {
  const localId = S.pendingMessages.get(ciphertext);
  if (!localId) return;
  S.pendingMessages.delete(ciphertext);
  const el = document.querySelector(`.pending-bubble[data-pending-id="${localId}"]`);
  if (el) el.remove();
}

// ============================================================
// UPLOAD PROGRESS BAR
// ============================================================

function showUploadProgress(frac) {
  const wrap = $('upload-progress-wrap');
  const fill = $('upload-progress-fill');
  const pct  = $('upload-progress-pct');
  if (wrap) wrap.classList.remove('hidden');
  const p = Math.round(frac * 100);
  if (fill) fill.style.width = p + '%';
  if (pct)  pct.textContent  = p + '%';
}

function updateUploadProgress(frac) {
  const fill = $('upload-progress-fill');
  const pct  = $('upload-progress-pct');
  const p    = Math.round(frac * 100);
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

// Load, decrypt, and display the profile picture stored in Firebase.
async function loadAndApplyAvatar() {
  if (!S.uid || !S.encKey) return;
  try {
    const profile = await getProfile(S.uid);
    if (!profile?.avatar) {
      S.avatarDataUrl = null;
    } else {
      const parsed = JSON.parse(profile.avatar);
      S.avatarDataUrl = await decrypt(S.encKey, parsed.ciphertext, parsed.iv);
    }
  } catch {
    S.avatarDataUrl = null;
  }
  updateAvatarDisplay();
}

// Update every avatar element in the UI.
function updateAvatarDisplay() {
  const letter = avatarLetter(S.email ?? '');
  const imgHtml = S.avatarDataUrl
    ? `<img src="${S.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
    : letter;

  // Header
  const headerEl = $('header-avatar');
  if (headerEl) {
    if (S.avatarDataUrl) headerEl.innerHTML = imgHtml;
    else headerEl.textContent = letter;
  }

  // Settings preview
  const settingsEl = $('settings-avatar-preview');
  if (settingsEl) {
    if (S.avatarDataUrl) settingsEl.innerHTML = imgHtml;
    else settingsEl.textContent = letter;
  }
  $('settings-avatar-remove-btn')?.classList.toggle('hidden', !S.avatarDataUrl);
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
      break; // Stop on first failure; retry on next connectivity event
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

  if (!S.typingDevices.length) {
    el.classList.add('hidden');
    return;
  }

  const names = S.typingDevices.map(did => {
    // S.devices comes from Firebase subscribeDevices — use it for live names.
    // Fall back to presence map name, then a generic label.
    const dev = S.devices[did];
    const pres = S.presenceMap[did];
    // Presence deviceName is set on every app open so it reflects
    // the current name. Device record name can be stale from initial setup.
    return pres?.deviceName ?? dev?.name ?? 'Another device';
  });

  el.textContent =
    names.length === 1
      ? `${names[0]} is typing…`
      : `${names.length} devices are typing…`;
  el.classList.remove('hidden');
}

// ============================================================
// ONLINE STATUS IN HEADER
// ============================================================
function renderOnlineStatus() {
  // Filter to genuinely online devices: must have online=true and a lastSeen
  // within the last 3 minutes (guards against stale Firebase entries where
  // onDisconnect didn't fire, e.g. browser force-closed or network drop).
  const STALE_MS = 3 * 60 * 1000;
  const now = Date.now();

  const onlineDevices = Object.values(S.presenceMap).filter(p =>
    p.online && (!p.lastSeen || (now - p.lastSeen) < STALE_MS)
  );

  // Deduplicate by name — multiple device registrations from setup retries
  // can produce entries with the same name, which we only want to show once.
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
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  if (force || nearBottom) {
    list.scrollTop = list.scrollHeight;
  }
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

  // Save draft
  if (S.uid) drafts.set(S.uid, val).catch(() => {});

  // Typing indicator
  if (S.uid && S.deviceId && val.trim()) {
    setTyping(S.uid, S.deviceId, true).catch(() => {});
    clearTimeout(_typingTimeout);
    _typingTimeout = setTimeout(() => {
      setTyping(S.uid, S.deviceId, false).catch(() => {});
    }, 4000);
  } else if (S.uid && S.deviceId) {
    clearTimeout(_typingTimeout);
    setTyping(S.uid, S.deviceId, false).catch(() => {});
  }
}

// ============================================================
// ACCOUNT SWITCHER OVERLAY
// ============================================================
async function openAccountSwitcher() {
  const accounts = await listAccounts();
  const list     = $('account-list');

  list.innerHTML = accounts.map(a => `
    <div class="account-row ${a.isCurrentAccount ? 'current' : ''}"
         onclick="Nexus.switchAccount('${a.uid}')">
      <div class="account-avatar">${avatarLetter(a.email)}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(a.displayName ?? a.email)}</div>
        <div class="account-email">${escHtml(a.email)}</div>
        <div class="account-device">${platformIcon(a.platform ?? 'unknown')} ${escHtml(a.deviceName)}</div>
      </div>
      ${a.isCurrentAccount ? '<div class="account-current-badge">Active</div>' : ''}
    </div>`
  ).join('');

  show('overlay-accounts');
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
    S.deviceName = account.deviceName;
    S.encKey     = null;

    const keyData = await keyStore.get(uid);
    if (keyData?.key) {
      S.encKey = keyData.key;
      // Load the new account's auto-lock setting before starting the chat
      // so the timer runs with the correct value, not the previous account's.
      await loadAutoLockSetting(uid);
      await startChat();
    } else {
      showScreen('s-passphrase-entry');
    }
  } catch (err) {
    toast('Switch failed: ' + err.message);
    showScreen('s-app');
  }
};

// ============================================================
// STORAGE SUMMARY (Phase 2)
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
            ${!acc.authOk ? ' &nbsp;<button class="storage-reauth-btn" onclick="Nexus.reAuthDrive(\'' + escHtml(acc.driveUid) + '\')">Re-authenticate</button>' : ''}
          </div>
        </div>
        <button class="btn-remove-drive" onclick="Nexus.removeSpineDrive('${escHtml(acc.driveUid)}')" title="Remove">
          &times;
        </button>
      </div>`
    ).join('');
  } catch (err) {
    el.innerHTML = `<div class="storage-empty">Could not load storage info.</div>`;
  }
}

// Re-authenticate a Spine Drive account on this device.
// Tokens are per-device (sessionStorage) — adding an account on one device
// does not give other devices a token. This prompts for the account's
// Google sign-in and stores the new Drive token without touching Nexus session.
window.Nexus.reAuthDrive = async function(driveUid) {
  try {
    const { GoogleAuthProvider, signInWithPopup, getAuth } =
      await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
    const { storeDriveToken } = await import('./drive.js');
    const config = await getSpineConfig(S.uid);
    const acc = config.accounts.find(a => a.driveUid === driveUid);
    if (!acc) { toast('Account not found in Spine'); return; }

    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    provider.setCustomParameters({ login_hint: acc.email });

    const auth   = getAuth();
    const result = await signInWithPopup(auth, provider);
    const cred   = GoogleAuthProvider.credentialFromResult(result);

    // Restore original Nexus Firebase session
    if (result.user.uid !== S.uid) {
      const p2 = new GoogleAuthProvider();
      p2.setCustomParameters({ login_hint: (await getCurrentAccount())?.email });
      await signInWithPopup(auth, p2).catch(() => {});
    }

    if (cred?.accessToken) {
      storeDriveToken(driveUid, cred.accessToken, 3600);
      S.spineConfig = await getSpineConfig(S.uid);
      toast('Drive account re-authenticated');
      renderStorageSummary();
    } else {
      toast('Could not get Drive access — try again');
    }
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return;
    toast('Re-auth failed: ' + err.message);
  }
};

window.Nexus.removeSpineDrive = async function(driveUid) {
  if (!confirm('Remove this Drive account from your Spine? Files on it will become inaccessible.')) return;
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
  // Populate theme grid
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

  // Populate device name field
  const devInput = $('settings-device-name');
  if (devInput) devInput.value = S.deviceName ?? '';

  // Populate autolock selector with saved value for this account
  let lockData = null;
  try {
    const { lockStore } = await import('./db.js');
    lockData = await lockStore.get(S.uid);
  } catch {}
  const autolockSel = $('settings-autolock');
  if (autolockSel && lockData?.autoLockMinutes !== undefined) {
    autolockSel.value = String(lockData.autoLockMinutes);
  }

  // Populate avatar preview
  updateAvatarDisplay();

  // Populate colour pickers with stored values or current theme defaults
  const { accent, ownBubble, wallpaper } = await loadAppearance(S.uid);
  const thId       = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
  const thDefAccent  = THEMES[thId]?.vars['--accent']  ?? '#8b5cf6';
  const thDefBubble  = THEMES[thId]?.vars['--own-bg']  ?? '#6d44d4';

  const accentPicker = $('settings-accent-color');
  if (accentPicker) accentPicker.value = accent ?? thDefAccent;

  const bubblePicker = $('settings-own-bubble-color');
  if (bubblePicker) bubblePicker.value = ownBubble ?? thDefBubble;

  // Wallpaper preview thumbnail
  const wpPreview = $('settings-wallpaper-preview');
  if (wpPreview) {
    if (wallpaper) {
      wpPreview.src = wallpaper;
      wpPreview.classList.remove('hidden');
      $('settings-wallpaper-remove')?.classList.remove('hidden');
    } else {
      wpPreview.classList.add('hidden');
      $('settings-wallpaper-remove')?.classList.add('hidden');
    }
  }

  // Populate storage summary
  renderStorageSummary();

  show('overlay-settings');
}

window.Nexus.setTheme = async function(themeId) {
  await saveTheme(S.uid, themeId);
  // Re-apply stored colour overrides on top of new theme
  await applyStoredAppearance(S.uid);
  // Update active state on swatches
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
    // Accept raw object literal by wrapping in parentheses
    const cleaned = raw.replace(/^\s*const\s+\w+\s*=\s*/, '').replace(/;?\s*$/, '');
    config = JSON.parse(cleaned);
  } catch {
    try {
      // Try eval as last resort (handles non-JSON object literals)
      config = Function(`"use strict"; return (${raw})`)();
    } catch {
      toast('Invalid config — paste the JSON from Firebase console');
      return;
    }
  }

  const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId'];
  const missing  = required.filter(f => !config[f]);
  if (missing.length) {
    toast('Missing fields: ' + missing.join(', '));
    return;
  }

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

    // Always check Firebase to determine if this is truly a new account.
    // Never rely on local IndexedDB alone — a second device has no local data
    // and would incorrectly appear as a new account, generating a fresh salt
    // and deriving a completely different encryption key even with the same
    // passphrase. That was the root cause of the decryption failure.
    $('signin-btn').textContent = 'Checking account…';
    const profile = await getProfile(user.uid).catch(() => null);
    const isNewAccount = !profile?.encryptionSalt;

    if (isNewAccount) {
      showScreen('s-passphrase-setup');
    } else {
      // Existing account — check if this device has a cached key already
      const keyData = await keyStore.get(user.uid);
      if (keyData?.key) {
        S.encKey = keyData.key;
        const lockSetUp = await isLockSetUp(user.uid);
        if (lockSetUp) {
          showLockScreen();
        } else {
          showScreen('s-pin-setup');
        }
      } else {
        // Key not cached on this device — need passphrase entry to re-derive it
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
  return `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
  Continue with Google`;
}

// ============================================================
// ONBOARDING: PASSPHRASE SETUP (new account)
// ============================================================
async function handlePassphraseSetup() {
  const p1 = $('passphrase-1').value;
  const p2 = $('passphrase-2').value;

  if (!p1) { toast('Enter a passphrase'); return; }
  if (p1 !== p2) { toast('Passphrases do not match'); return; }
  if (p1.length < 8) { toast('Passphrase must be at least 8 characters'); return; }

  const btn = $('passphrase-setup-btn');
  btn.disabled = true;
  btn.textContent = 'Setting up…';

  try {
    const salt   = generateSalt();
    const key    = await deriveKey(p1, salt);
    const vector = await createVerificationVector(key);

    // Store key locally (non-extractable CryptoKey in IndexedDB)
    await keyStore.set(S.uid, key, salt, vector);
    S.encKey = key;

    const account = await getCurrentAccount();
    // Write salt + vector to Firebase so other devices can verify their passphrase
    await setupProfile(
      S.uid,
      S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform(),
      salt,
      vector
    );

    showScreen('s-pin-setup');
  } catch (err) {
    toast('Setup failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set Passphrase';
  }
}

// ============================================================
// ONBOARDING: PASSPHRASE ENTRY (existing account, new device)
// ============================================================
async function handlePassphraseEntry() {
  const p = $('passphrase-entry-input').value;
  if (!p) { toast('Enter your passphrase'); return; }

  const btn = $('passphrase-entry-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
    // Fetch salt from Firebase
    const profile = await getProfile(S.uid);
    if (!profile?.encryptionSalt) {
      throw new Error('Account profile not found on Firebase');
    }

    const key    = await deriveKey(p, profile.encryptionSalt);
    const vector = JSON.parse(profile.verificationVector);
    const valid  = await verifyKey(key, vector);

    if (!valid) {
      toast('Wrong passphrase — try again');
      btn.disabled = false;
      btn.textContent = 'Decrypt & Continue';
      return;
    }

    // Save verified key
    await keyStore.set(S.uid, key, profile.encryptionSalt, vector);
    S.encKey = key;

    // Register this device on Firebase if not already
    const account = await getCurrentAccount();
    await registerDevice(
      S.uid, S.deviceId,
      account?.deviceName ?? getDefaultDeviceName(),
      account?.platform   ?? detectPlatform()
    );

    const lockSetUp = await isLockSetUp(S.uid);
    if (lockSetUp) {
      showLockScreen();
    } else {
      showScreen('s-pin-setup');
    }
  } catch (err) {
    toast('Error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Decrypt & Continue';
  }
}

// ============================================================
// ONBOARDING: PIN SETUP
// ============================================================
let _pinSetupBuffer = '';
let _pinSetupFirstEntry = '';
let _pinSetupPhase = 'create'; // 'create' | 'confirm'

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
  $$('.pin-setup-dot').forEach((d, i) => {
    d.classList.toggle('filled', i < _pinSetupBuffer.length);
  });
}

function advancePINSetup() {
  if (_pinSetupPhase === 'create') {
    _pinSetupFirstEntry = _pinSetupBuffer;
    _pinSetupBuffer = '';
    _pinSetupPhase  = 'confirm';
    $('pin-setup-prompt').textContent = 'Confirm your PIN';
    updatePINSetupDots();
    // Clear and re-focus the hidden input so keyboard entry works on confirmation step
    const inp = $('setup-pin-input');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  } else {
    if (_pinSetupBuffer !== _pinSetupFirstEntry) {
      toast('PINs do not match — try again');
      _pinSetupBuffer     = '';
      _pinSetupFirstEntry = '';
      _pinSetupPhase      = 'create';
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
  _pinSetupBuffer = '';
  _pinSetupFirstEntry = '';
  _pinSetupPhase = 'create';
  updatePINSetupDots();
  const prompt = $('pin-setup-prompt');
  if (prompt) prompt.textContent = 'Create a 6-digit PIN';
  // Hide on-screen numpad — native keyboard on all platforms
  const numpad = $('setup-numpad');
  if (numpad) numpad.classList.add('hidden');
  const hint = $('setup-keyboard-hint');
  if (hint) hint.classList.remove('hidden');

  const inp = $('setup-pin-input');
  if (inp) inp.value = '';

  function focusSetupInput() {
    const i = $('setup-pin-input');
    if (i) { i.focus(); i.click(); }
  }

  // Wire dots row and dedicated button
  const dotsRow = document.getElementById('pin-setup-dots-row');
  if (dotsRow) dotsRow.addEventListener('click', focusSetupInput);
  $('setup-keyboard-btn')?.addEventListener('click', focusSetupInput);

  if (!isMobileDevice()) {
    setTimeout(focusSetupInput, 350);
  }
}

async function completePINSetup(pin) {
  try {
    await setupPIN(S.uid, pin);
    _pinSetupBuffer = '';
    _pinSetupFirstEntry = '';
    _pinSetupPhase = 'create';
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

  // Update Firebase device record
  try {
    await touchDevice(S.uid, S.deviceId);
  } catch {}

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
// HELPERS
// ============================================================
function avatarLetter(email) {
  return (email?.[0] ?? '?').toUpperCase();
}

// ============================================================
// EVENT BINDING (called once DOM is ready)
// ============================================================
function bindEvents() {
  // ---- Welcome ----
  $('get-started-btn')?.addEventListener('click', () => showScreen('s-firebase'));

  // ---- Firebase config ----
  $('firebase-next-btn')?.addEventListener('click', handleFirebaseConfigSubmit);
  $('firebase-instructions-toggle')?.addEventListener('click', () => {
    $('firebase-instructions').classList.toggle('hidden');
  });

  // ---- Sign in ----
  $('signin-btn')?.addEventListener('click', handleGoogleSignIn);

  // ---- Passphrase setup ----
  $('passphrase-1')?.addEventListener('input', e => updateStrengthMeter(e.target.value));
  $('passphrase-2')?.addEventListener('input', () => {
    const match = $('passphrase-1').value === $('passphrase-2').value;
    $('passphrase-2').style.borderColor = $('passphrase-2').value
      ? (match ? 'var(--success)' : 'var(--danger)')
      : '';
  });
  $('passphrase-setup-btn')?.addEventListener('click', handlePassphraseSetup);

  // ---- Passphrase entry ----
  $('passphrase-entry-btn')?.addEventListener('click', handlePassphraseEntry);
  $('passphrase-entry-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handlePassphraseEntry();
  });

  // ---- PIN setup pad ----
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

  // ---- Biometrics ----
  $('bio-setup-btn')?.addEventListener('click', handleBiometricSetup);
  $('bio-skip-btn')?.addEventListener('click', () => showScreen('s-device-name'));

  // ---- Device name ----
  $('device-name-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleDeviceNameDone();
  });
  $('device-name-done-btn')?.addEventListener('click', handleDeviceNameDone);

  // ---- Lock screen PIN pad ----
  $$('.pin-lock-key').forEach(key => {
    key.addEventListener('click', () => {
      const val = key.dataset.val;
      if (val === 'back') onPINBackspace();
      else onPINDigit(val);
    });
  });
  // Hidden keyboard input (desktop types directly here)
  $('lock-pin-input')?.addEventListener('input', onLockPINInput);
  $('lock-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _pinBuffer.length > 0) submitPIN();
  });
  $('lock-bio-btn')?.addEventListener('click', attemptBiometricUnlock);

  // ---- Chat: media attach ----
  $('attach-btn')?.addEventListener('click', () => $('file-input')?.click());
  $('file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-picked
    await handleMediaSend(file);
  });

  // ---- Chat: send ----
  $('send-btn')?.addEventListener('click', handleSend);
  $('msg-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  $('msg-input')?.addEventListener('input', onInputChange);

  // ---- Chat: header actions ----
  $('header-avatar')?.addEventListener('click', openAccountSwitcher);
  $('header-settings-btn')?.addEventListener('click', openSettings);

  // ---- Account switcher ----
  $('account-overlay-close')?.addEventListener('click', () => hide('overlay-accounts'));
  $('add-account-btn')?.addEventListener('click', async () => {
    hide('overlay-accounts');
    showScreen('s-signin');
  });

  // ---- Settings panel ----
  $('settings-close-btn')?.addEventListener('click', () => hide('overlay-settings'));
  $('settings-device-name')?.addEventListener('change', async e => {
    const name = e.target.value.trim();
    if (name) {
      S.deviceName = name;
      await updateDeviceName(name);
      // Also update Firebase presence so other devices see the new name immediately
      try {
        await setupPresence(S.uid, S.deviceId, name);
      } catch {}
      toast('Device name updated');
    }
  });
  $('settings-signout-btn')?.addEventListener('click', async () => {
    hide('overlay-settings');
    clearUnsubscribers();
    await signOut();
    showScreen('s-signin');
  });

  // Biometrics setup on settings page
  $('settings-bio-setup-btn')?.addEventListener('click', async () => {
    const account = await getCurrentAccount();
    try {
      await setupBiometrics(S.uid, account?.email ?? '');
      toast('Biometrics enabled');
    } catch { toast('Biometrics setup failed'); }
  });

  // Add Drive account (Spine Link)
  // IMPORTANT: We must NOT call signInWithGoogle() here because that function
  // sets current_uid and isCurrentAccount, which would hijack the active session.
  // Instead we open a raw Google OAuth popup and extract only the access token
  // and account identity without touching any Nexus account state.
  $('settings-add-drive-btn')?.addEventListener('click', async () => {
    try {
      const { GoogleAuthProvider, signInWithPopup, getAuth } =
        await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
      const { storeDriveToken } = await import('./drive.js');

      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/drive.file');

      const auth   = getAuth();
      // Use addScope+getRedirectResult pattern: we do a popup but DO NOT
      // call our signInWithGoogle wrapper — just raw Firebase to avoid
      // touching current_uid or accountStore.
      const result = await signInWithPopup(auth, provider);
      const cred   = GoogleAuthProvider.credentialFromResult(result);

      const driveUid = result.user.uid;
      const email    = result.user.email;

      // Immediately sign back in as the original Nexus account so Firebase
      // auth state returns to the correct user (sign-in may have changed it).
      if (result.user.uid !== S.uid) {
        const { GoogleAuthProvider: GAP2, signInWithPopup: siwp2 } =
          await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
        const p2 = new GAP2();
        p2.setCustomParameters({ login_hint: (await getCurrentAccount())?.email });
        await siwp2(auth, p2).catch(() => {});
      }

      // Store the Drive token for this account
      if (cred?.accessToken) storeDriveToken(driveUid, cred.accessToken, 3600);

      // Default cap: 5 GB
      const capBytes = 5 * 1024 * 1024 * 1024;
      await addSpineAccount(S.uid, driveUid, email, capBytes);
      S.spineConfig = await getSpineConfig(S.uid);
      toast('Drive account added to Spine');
      renderStorageSummary();
    } catch (err) {
      if (err.code === 'auth/cancelled-popup-request' || err.code === 'auth/popup-closed-by-user') return;
      toast('Error: ' + err.message);
    }
  });

  // Auto-lock selector
  $('settings-autolock')?.addEventListener('change', async e => {
    const mins = parseInt(e.target.value, 10);
    await setAutoLockMinutes(S.uid, mins);
    // Restart the running timer immediately with the new duration
    // so the change takes effect right now, not only after next lock/unlock.
    startAutoLockTimer();
    toast('Auto-lock updated');
  });

  // PWA install button
  $('install-btn')?.addEventListener('click', async () => {
    if (!S.installPrompt) return;
    await S.installPrompt.prompt();
    const result = await S.installPrompt.userChoice;
    if (result.outcome === 'accepted') { toast('Nexus installed!'); S.installPrompt = null; }
    hide('install-btn-wrap');
  });

  // Init biometrics screen when it's shown
  document.addEventListener('nexus:screenchange', async e => {
    if (e.detail === 's-biometrics-setup') initBiometricsScreen();
  });

  // Biometrics screen init
  initBiometricsScreen();

  // Init device name default
  const devInput = $('device-name-input');
  if (devInput && !devInput.value) devInput.value = getDefaultDeviceName();

  // ---- Overlay backdrop click to close ----
  // Clicking on the dark backdrop outside the panel closes the overlay.
  $('overlay-settings')?.addEventListener('click', e => {
    if (e.target === $('overlay-settings')) hide('overlay-settings');
  });
  $('overlay-accounts')?.addEventListener('click', e => {
    if (e.target === $('overlay-accounts')) hide('overlay-accounts');
  });

  // ---- Upload progress cancel ----
  $('upload-cancel-btn')?.addEventListener('click', () => {
    cancelCurrentUpload();
  });

  // ---- Profile picture ----
  $('settings-avatar-btn')?.addEventListener('click', () => {
    $('avatar-file-input')?.click();
  });

  $('avatar-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const dataUrl   = await compressAvatar(file);
      const { ciphertext, iv } = await encrypt(S.encKey, dataUrl);
      await updateProfileAvatar(S.uid, JSON.stringify({ ciphertext, iv }));
      S.avatarDataUrl = dataUrl;
      updateAvatarDisplay();
      toast('Profile photo updated');
    } catch (err) {
      toast('Could not set photo: ' + err.message);
    }
  });

  $('settings-avatar-remove-btn')?.addEventListener('click', async () => {
    try {
      await updateProfileAvatar(S.uid, null);
      S.avatarDataUrl = null;
      updateAvatarDisplay();
      toast('Profile photo removed');
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });

  // ---- Accent colour ----
  $('settings-accent-color')?.addEventListener('input', async e => {
    const hex = e.target.value;
    applyAccentColor(hex);
    await saveAccentColor(S.uid, hex);
  });

  $('settings-accent-reset')?.addEventListener('click', async () => {
    await clearAccentColor(S.uid);
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    applyTheme(thId);
    // Re-apply any remaining overrides (e.g. own-bubble)
    const { ownBubble } = await loadAppearance(S.uid);
    if (ownBubble) applyOwnBubbleColor(ownBubble);
    // Reset picker to theme default
    const picker = $('settings-accent-color');
    if (picker) picker.value = THEMES[thId]?.vars['--accent'] ?? '#8b5cf6';
    toast('Accent colour reset');
  });

  // ---- Own bubble colour ----
  $('settings-own-bubble-color')?.addEventListener('input', async e => {
    const hex = e.target.value;
    applyOwnBubbleColor(hex);
    await saveOwnBubbleColor(S.uid, hex);
  });

  $('settings-own-bubble-reset')?.addEventListener('click', async () => {
    await clearOwnBubbleColor(S.uid);
    const thId = document.documentElement.getAttribute('data-theme') ?? 'deep-dark';
    const def  = THEMES[thId]?.vars['--own-bg'] ?? '#6d44d4';
    applyOwnBubbleColor(def);
    const picker = $('settings-own-bubble-color');
    if (picker) picker.value = def;
    toast('Bubble colour reset');
  });

  // ---- Wallpaper ----
  $('settings-wallpaper-btn')?.addEventListener('click', () => {
    $('wallpaper-file-input')?.click();
  });

  $('wallpaper-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      toast('Processing…', 5000);
      const dataUrl = await compressWallpaper(file);
      await saveWallpaper(S.uid, dataUrl);
      applyWallpaper(dataUrl);
      // Update preview in settings
      const prev = $('settings-wallpaper-preview');
      if (prev) { prev.src = dataUrl; prev.classList.remove('hidden'); }
      $('settings-wallpaper-remove')?.classList.remove('hidden');
      toast('Wallpaper set');
    } catch (err) {
      toast('Could not set wallpaper: ' + err.message);
    }
  });

  $('settings-wallpaper-remove')?.addEventListener('click', async () => {
    await clearWallpaper(S.uid);
    applyWallpaper(null);
    const prev = $('settings-wallpaper-preview');
    if (prev) { prev.src = ''; prev.classList.add('hidden'); }
    $('settings-wallpaper-remove')?.classList.add('hidden');
    toast('Wallpaper removed');
  });
}

// ============================================================
// LOCK EVENT LISTENER
// ============================================================
// The lock.js timer calls lock() which dispatches 'nexus:locked'.
// Without this listener, the timer fires but the lock screen never appears.
document.addEventListener('nexus:locked', () => {
  // Close any open overlays so the lock screen is not obscured.
  // Without this, a user could remain in Settings indefinitely after the
  // timer fires without ever being prompted for their PIN.
  hide('overlay-settings');
  hide('overlay-accounts');
  if (S.currentScreen === 's-app') {
    showLockScreen();
  }
});

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  init().catch(err => {
    console.error('[boot]', err);
  });
});
