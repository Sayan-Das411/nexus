// src/app.js
// Nexus — main application logic.
// Orchestrates: initialization flow, screen management, real-time messaging,
// encryption, lock screen, account switching, offline queue, and UI rendering.

import { initDB, settings, accountStore, keyStore, queue, drafts, lockStore }
  from './db.js';
import { deriveKey, generateSalt, encrypt, decrypt,
         createVerificationVector, verifyKey, passphraseStrength }
  from './crypto.js';
import { initFirebase, signInWithGoogle, getCurrentAccount, listAccounts,
         signOut, switchToAccount, removeLocalAccount, updateDeviceName,
         getDefaultDeviceName, detectPlatform, platformIcon, onAuthChange }
  from './auth.js';
import { setupProfile, registerDevice, getProfile, sendMessage as fbSendMessage,
         subscribeMessages, subscribeTyping, subscribePresence, setupPresence,
         markRead, setTyping, subscribeDevices, touchDevice }
  from './realtime.js';
import { setupPIN, verifyPIN, isLockSetUp, setupBiometrics,
         authenticateBiometrics, biometricsAvailable, isBiometricsEnabled,
         lock, unlock, isLocked, loadAutoLockSetting, setupVisibilityLock,
         setAutoLockMinutes }
  from './lock.js';
import { THEMES, applyTheme, loadTheme, saveTheme } from './themes.js';

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
  sendInProgress:false,
};

// ============================================================
// DOM HELPERS
// ============================================================
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function setHTML(id, html) { $(id).innerHTML = html; }
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
    $('lock-avatar').textContent = avatarLetter(account.email);
    $('lock-email').textContent  = account.email;
  }

  const bioAvail    = await biometricsAvailable();
  const bioEnabled  = await isBiometricsEnabled(S.uid ?? account?.uid);
  toggle('lock-bio-btn', bioAvail && bioEnabled);
  toggle('lock-bio-hint', bioAvail && bioEnabled);

  clearPINDisplay();
  showScreen('s-lock');

  // Desktop: hide on-screen numpad, focus the hidden keyboard input.
  // Mobile: show numpad, hidden input still triggers system number keyboard.
  const mobile = isMobileDevice();
  const numpad = $('lock-numpad');
  const hint   = $('lock-keyboard-hint');
  if (numpad) numpad.classList.toggle('hidden', !mobile);
  if (hint)   hint.classList.toggle('hidden',   mobile);
  const inp = $('lock-pin-input');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 350); }

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
  unlock();
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

  // Connectivity listeners
  window.addEventListener('online',  onOnline);
  window.addEventListener('offline', onOffline);
  updateConnectivityUI();

  showScreen('s-app');
  scrollToBottom(true);

  // Apply per-account theme
  const themeId = await loadTheme(S.uid);
  applyTheme(themeId);
}

function clearUnsubscribers() {
  S.unsubscribers.forEach(fn => { try { fn(); } catch {} });
  S.unsubscribers = [];
}

// ============================================================
// MESSAGES
// ============================================================
async function handleIncomingMessages(messages) {
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

async function renderMessages(messages) {
  const container = $('messages-list');
  if (!messages.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#128274;</div>
        <div class="empty-title">No messages yet</div>
        <div class="empty-sub">Messages are encrypted end-to-end.<br>Only your devices can read them.</div>
      </div>`;
    return;
  }

  // Decrypt all messages
  const decrypted = [];
  for (const msg of messages) {
    if (msg.deleted) {
      decrypted.push({ ...msg, text: null, isDeleted: true });
      continue;
    }
    try {
      const text = await decrypt(S.encKey, msg.ciphertext, msg.iv);
      decrypted.push({ ...msg, text });
    } catch {
      decrypted.push({ ...msg, text: '[Unable to decrypt]', decryptError: true });
    }
  }

  // Build HTML with date separators
  let html       = '';
  let lastDate   = '';
  let lastDevice = '';

  for (const msg of decrypted) {
    const isOwn = msg.deviceId === S.deviceId;
    const ts    = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const date  = ts.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    const time  = ts.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });

    if (date !== lastDate) {
      html += `<div class="date-sep"><span>${date}</span></div>`;
      lastDate   = date;
      lastDevice = ''; // Reset grouping on date change
    }

    // Show device name if sender changed
    const showDeviceName = !isOwn && msg.deviceId !== lastDevice;
    lastDevice = msg.deviceId;

    const readByOthers = Object.keys(msg.readBy ?? {})
      .some(did => did !== S.deviceId);

    html += buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers);
  }

  container.innerHTML = html;
}

function buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers) {
  const side  = isOwn ? 'own' : 'other';
  const devPlatform = S.devices[msg.deviceId]?.platform ?? 'unknown';

  let content = '';
  if (msg.isDeleted) {
    content = `<em class="deleted-text">This message was deleted</em>`;
  } else if (msg.decryptError) {
    content = `<span class="decrypt-error">${escHtml(msg.text)}</span>`;
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
      <div class="msg-bubble" onclick="Nexus.onBubbleClick(event, '${escHtml(msg.id)}')">
        ${content}
        <div class="msg-meta">
          <span class="msg-time" id="t-${escHtml(msg.id)}">${time}</span>
          ${readTick}
        </div>
      </div>
    </div>`;
}

// Expose bubble click for inline onclick (needed because messages are innerHTML)
window.Nexus = window.Nexus ?? {};
window.Nexus.onBubbleClick = function(ev, msgId) {
  const timeEl = $(`t-${msgId}`);
  if (timeEl) timeEl.classList.toggle('hidden');
};

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

    if (S.isOnline) {
      try {
        await fbSendMessage(S.uid, payload);
      } catch (err) {
        // Firebase send failed — queue it
        await queue.add(S.uid, payload);
        toast('Sent offline — will deliver when connected');
      }
    } else {
      await queue.add(S.uid, payload);
      toast('Queued — will send when online');

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
    return dev?.name ?? pres?.deviceName ?? 'Another device';
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
// SETTINGS PANEL
// ============================================================
function openSettings() {
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

  show('overlay-settings');
}

window.Nexus.setTheme = async function(themeId) {
  await saveTheme(S.uid, themeId);
  // Update active state
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
  const mobile = isMobileDevice();
  const numpad = $('setup-numpad');
  const hint   = $('setup-keyboard-hint');
  if (numpad) numpad.classList.toggle('hidden', !mobile);
  if (hint)   hint.classList.toggle('hidden',   mobile);
  const inp = $('setup-pin-input');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 350); }
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

  // Auto-lock selector
  $('settings-autolock')?.addEventListener('change', async e => {
    const mins = parseInt(e.target.value, 10);
    await setAutoLockMinutes(S.uid, mins);
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
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  init().catch(err => {
    console.error('[boot]', err);
  });
});
