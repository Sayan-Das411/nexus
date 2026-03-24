// src/app.js
// Main application logic for Nexus.
// Ties together auth, encryption, realtime messaging, and UI.

import { initFirebase, signInWithGoogle, onAuthChange, signOut, getCurrentAccount, listAccounts, switchToAccount, removeLocalAccount } from './auth.js';
import { deriveKey, verifyKey, createVerificationVector, passphraseStrength, encrypt, decrypt } from './crypto.js';
import { initDB, keyStore, settings, drafts } from './db.js';
import { setupProfile, registerDevice, subscribeMessages, sendMessage, markRead, setTyping, subscribeTyping, setupPresence, subscribePresence, touchDevice, updateProfileAvatar } from './realtime.js';
import { applyTheme, loadTheme, saveTheme, THEMES } from './themes.js';
import { isLocked, unlock, lock, setupVisibilityLock, isLockSetUp, verifyPIN, authenticateBiometrics, isBiometricsEnabled, loadAutoLockSetting } from './lock.js';
import { prepareMediaMessage, fetchMedia, decryptThumbnail, buildImageBubbleHTML, buildFileBubbleHTML, formatBytes } from './media.js';
import { applyStoredAppearance, applyAccentColor, applyOwnBubbleColor, applyWallpaper, saveAccentColor, saveOwnBubbleColor, saveWallpaper, clearAccentColor, clearOwnBubbleColor, clearWallpaper, compressAvatar, compressWallpaper } from './appearance.js';
import { getStorageSummary, addSpineAccount, removeSpineAccount, updateSpineCap, checkAndRestoreFolders } from './spine.js';

// ---- State ------------------------------------------------------------------
const state = {
    uid: null,
    deviceId: null,
    deviceName: null,
    encKey: null,
    currentAccount: null,
    messages: [],
    presence: {},
    typing: [],
    replyTo: null,
    isInitialized: false,
    currentPin: ''
};

// ---- DOM Elements -----------------------------------------------------------
const els = {
    setupScreen: document.getElementById('setup-screen'),
    chatScreen: document.getElementById('chat-screen'),
    lockScreen: document.getElementById('lock-screen'),
    authStep: document.getElementById('auth-step'),
    passphraseStep: document.getElementById('passphrase-step'),
    verifyStep: document.getElementById('verify-step'),
    googleBtn: document.getElementById('google-signin-btn'),
    savePassphraseBtn: document.getElementById('save-passphrase-btn'),
    unlockBtn: document.getElementById('unlock-btn'),
    msgList: document.getElementById('messages-list'),
    msgInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    typingIndicator: document.getElementById('typing-indicator'),
    presenceIndicator: document.getElementById('presence-indicator'),
    menuToggle: document.getElementById('menu-toggle'),
    sideMenu: document.getElementById('side-menu'),
    closeMenu: document.getElementById('close-menu'),
    themeGrid: document.getElementById('theme-grid'),
    signOutBtn: document.getElementById('sign-out-btn'),
    userAvatar: document.getElementById('user-avatar'),
    userName: document.getElementById('user-name'),
    userEmail: document.getElementById('user-email'),
    replyPreview: document.getElementById('reply-preview'),
    cancelReply: document.getElementById('cancel-reply'),
    toastContainer: document.getElementById('toast-container')
};

// ---- Initialization ---------------------------------------------------------

async function init() {
    await initDB();
    
    // Load Firebase config (this should be provided via the tool or manually)
    try {
        const config = await fetch('/firebase-applet-config.json').then(r => r.json());
        await initFirebase(config);
    } catch (err) {
        console.error('Firebase config missing or invalid. App will not function.', err);
        showToast('Firebase configuration missing.', 'danger');
        return;
    }

    setupVisibilityLock();
    
    // Global Nexus object for inline event handlers
    window.Nexus = {
        openMedia: async (uuid) => {
            try {
                showToast('Downloading media...', 'info');
                const url = await fetchMedia(state.uid, state.encKey, uuid);
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (err) {
                showToast('Failed to download: ' + err.message, 'danger');
            }
        }
    };

    onAuthChange(async (user) => {
        if (user) {
            state.uid = user.uid;
            const acc = await getCurrentAccount();
            if (acc) {
                state.currentAccount = acc;
                state.deviceId = acc.deviceId;
                state.deviceName = acc.deviceName;
                
                // Check if we have the encryption key locally
                const keyData = await keyStore.get(user.uid);
                if (keyData) {
                    state.encKey = keyData.key;
                    await startApp();
                } else {
                    showSetup('verify');
                }
            } else {
                // New account or local data cleared
                showSetup('auth');
            }
        } else {
            showSetup('auth');
        }
    });

    setupEventListeners();
}

// ---- UI Transitions ---------------------------------------------------------

function showSetup(step) {
    els.setupScreen.classList.remove('hidden');
    els.chatScreen.classList.add('hidden');
    els.lockScreen.classList.add('hidden');
    
    els.authStep.classList.toggle('hidden', step !== 'auth');
    els.passphraseStep.classList.toggle('hidden', step !== 'passphrase');
    els.verifyStep.classList.toggle('hidden', step !== 'verify');
}

async function startApp() {
    if (state.isInitialized) return;
    
    // Check if app lock is enabled
    if (await isLockSetUp(state.uid)) {
        showLock();
    } else {
        showChat();
    }

    // Apply theme and appearance
    const themeId = await loadTheme(state.uid);
    applyTheme(themeId);
    await applyStoredAppearance(state.uid);
    renderThemeGrid();

    // Setup Realtime
    setupPresence(state.uid, state.deviceId, state.deviceName);
    subscribePresence(state.uid, state.deviceId, (pres) => {
        state.presence = pres;
        renderPresence();
    });
    subscribeTyping(state.uid, state.deviceId, (typing) => {
        state.typing = typing;
        renderTyping();
    });
    subscribeMessages(state.uid, (msgs) => {
        state.messages = msgs;
        renderMessages();
    });

    // Update UI profile
    els.userName.textContent = state.currentAccount.displayName;
    els.userEmail.textContent = state.currentAccount.email;
    els.userAvatar.src = state.currentAccount.photoURL;

    // Restore draft
    const draft = await drafts.get(state.uid);
    els.msgInput.value = draft;
    updateSendBtn();

    state.isInitialized = true;
    checkAndRestoreFolders(state.uid);
}

function showChat() {
    els.setupScreen.classList.add('hidden');
    els.chatScreen.classList.remove('hidden');
    els.lockScreen.classList.add('hidden');
    els.msgList.scrollTop = els.msgList.scrollHeight;
}

function showLock() {
    els.setupScreen.classList.add('hidden');
    els.chatScreen.classList.add('hidden');
    els.lockScreen.classList.remove('hidden');
    resetPinUI();
    
    // Try biometric if enabled
    if (isBiometricsEnabled(state.uid)) {
        authenticateBiometrics(state.uid).then(ok => {
            if (ok) unlockApp();
        });
    }
}

function unlockApp() {
    unlock();
    showChat();
}

// ---- Event Listeners --------------------------------------------------------

function setupEventListeners() {
    els.googleBtn.onclick = async () => {
        try {
            const { user, deviceId } = await signInWithGoogle();
            const profile = await setupProfile(user.uid, deviceId, 'My Device', 'web'); // Simplified
            // Check if profile exists in Firebase
            // If new, show passphrase step. If existing, show verify step.
            // For now, assume if no local key, we need to verify or setup.
            showSetup('passphrase');
        } catch (err) {
            showToast(err.message, 'danger');
        }
    };

    els.savePassphraseBtn.onclick = async () => {
        const pass = document.getElementById('setup-passphrase').value;
        const conf = document.getElementById('confirm-passphrase').value;
        if (pass !== conf) return showToast('Passphrases do not match', 'warning');
        
        try {
            const salt = crypto.randomUUID(); // Simplified salt
            const key = await deriveKey(pass, salt);
            const vector = await createVerificationVector(key);
            
            await keyStore.set(state.uid, key, salt, vector);
            await setupProfile(state.uid, state.deviceId, state.deviceName, 'web', salt, vector);
            
            state.encKey = key;
            startApp();
        } catch (err) {
            showToast(err.message, 'danger');
        }
    };

    els.unlockBtn.onclick = async () => {
        const pass = document.getElementById('verify-passphrase').value;
        try {
            const keyData = await keyStore.get(state.uid);
            // If no local key, we'd need to fetch salt/vector from Firebase profile
            // For this demo, assume local key exists or we re-derive
            const key = await deriveKey(pass, keyData.salt);
            if (await verifyKey(key, keyData.verificationVector)) {
                state.encKey = key;
                await keyStore.set(state.uid, key, keyData.salt, keyData.verificationVector);
                startApp();
            } else {
                showToast('Incorrect passphrase', 'danger');
            }
        } catch (err) {
            showToast(err.message, 'danger');
        }
    };

    els.sendBtn.onclick = async () => {
        const text = els.msgInput.value.trim();
        if (!text && !state.replyTo) return;
        
        try {
            // Encrypt
            const { ciphertext, iv } = await encrypt(state.encKey, text);
            await sendMessage(state.uid, {
                ciphertext,
                iv,
                type: 'text',
                deviceId: state.deviceId,
                deviceName: state.deviceName,
                replyTo: state.replyTo
            });
            
            els.msgInput.value = '';
            await drafts.delete(state.uid);
            cancelReply();
            updateSendBtn();
        } catch (err) {
            showToast('Failed to send: ' + err.message, 'danger');
        }
    };

    els.msgInput.oninput = () => {
        updateSendBtn();
        drafts.set(state.uid, els.msgInput.value);
        setTyping(state.uid, state.deviceId, els.msgInput.value.length > 0);
    };

    els.attachBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                showToast('Uploading ' + file.name + '...', 'info');
                const mediaData = await prepareMediaMessage(state.uid, state.encKey, file, (prog) => {
                    // Could update a progress bar here
                });
                
                // Send as message
                const { ciphertext, iv } = await encrypt(state.encKey, '[Media: ' + file.name + ']');
                await sendMessage(state.uid, {
                    ...mediaData,
                    ciphertext,
                    iv,
                    deviceId: state.deviceId,
                    deviceName: state.deviceName
                });
                showToast('Upload complete', 'success');
            } catch (err) {
                showToast('Upload failed: ' + err.message, 'danger');
            }
        };
        input.click();
    };

    els.menuToggle.onclick = () => els.sideMenu.classList.remove('hidden');
    els.closeMenu.onclick = () => els.sideMenu.classList.add('hidden');
    els.sideMenu.onclick = (e) => { if (e.target === els.sideMenu) els.sideMenu.classList.add('hidden'); };

    els.signOutBtn.onclick = async () => {
        if (confirm('Sign out of Nexus? Your local messages will be cleared.')) {
            await signOut();
            location.reload();
        }
    };

    document.getElementById('setup-passphrase').oninput = (e) => {
        const strength = passphraseStrength(e.target.value);
        const meter = document.getElementById('passphrase-strength');
        const labels = ['Too Short', 'Weak', 'Fair', 'Good', 'Strong'];
        meter.querySelector('.label').textContent = labels[strength];
        meter.querySelector('.bar').style.width = (strength + 1) * 20 + '%';
        els.savePassphraseBtn.disabled = strength < 2;
    };

    // PIN Pad logic
    document.querySelectorAll('.num-btn[data-val]').forEach(btn => {
        btn.onclick = async () => {
            if (state.currentPin.length >= 4) return;
            state.currentPin += btn.dataset.val;
            updatePinDots();
            if (state.currentPin.length === 4) {
                if (await verifyPIN(state.uid, state.currentPin)) {
                    unlockApp();
                } else {
                    showToast('Incorrect PIN', 'danger');
                    state.currentPin = '';
                    setTimeout(updatePinDots, 300);
                }
            }
        };
    });

    document.getElementById('pin-backspace').onclick = () => {
        state.currentPin = state.currentPin.slice(0, -1);
        updatePinDots();
    };

    function updatePinDots() {
        const dots = document.querySelectorAll('.pin-dots span');
        dots.forEach((dot, i) => dot.classList.toggle('filled', i < state.currentPin.length));
    }
}

// ---- Rendering --------------------------------------------------------------

async function renderMessages() {
    const list = els.msgList;
    const atBottom = list.scrollHeight - list.scrollTop <= list.clientHeight + 100;
    
    list.innerHTML = '';
    
    for (const msg of state.messages) {
        const isOwn = msg.deviceId === state.deviceId;
        const row = document.createElement('div');
        row.className = `message-row ${isOwn ? 'own' : 'other'}`;
        
        let content;
        try {
            const decrypted = await decrypt(state.encKey, msg.ciphertext, msg.iv);
            
            if (msg.uuid) {
                // Media message
                if (msg.mediaType === 'image') {
                    const thumb = await decryptThumbnail(state.encKey, msg.encThumb);
                    content = buildImageBubbleHTML(msg, thumb);
                } else {
                    content = buildFileBubbleHTML(msg);
                }
            } else {
                content = `<div class="bubble">${decrypted}</div>`;
            }
        } catch (err) {
            content = `<div class="bubble error">Decryption failed</div>`;
        }

        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const meta = `<div class="msg-meta">${time} ${isOwn ? '✓' : ''}</div>`;
        
        row.innerHTML = content + meta;
        list.appendChild(row);
        
        if (!isOwn && (!msg.readBy || !msg.readBy[state.deviceId])) {
            markRead(state.uid, msg.id, state.deviceId);
        }
    }

    if (atBottom) list.scrollTop = list.scrollHeight;
}

function renderPresence() {
    const container = els.presenceIndicator;
    container.innerHTML = '';
    const onlineCount = Object.values(state.presence).filter(p => p.online).length;
    if (onlineCount > 0) {
        container.innerHTML = `<span class="online-badge">${onlineCount} Online</span>`;
    }
}

function renderTyping() {
    if (state.typing.length > 0) {
        els.typingIndicator.classList.remove('hidden');
    } else {
        els.typingIndicator.classList.add('hidden');
    }
}

function renderThemeGrid() {
    els.themeGrid.innerHTML = '';
    Object.entries(THEMES).forEach(([id, theme]) => {
        const btn = document.createElement('button');
        btn.className = 'theme-btn';
        btn.textContent = theme.label;
        btn.onclick = () => {
            saveTheme(state.uid, id);
            renderThemeGrid();
        };
        if (document.documentElement.getAttribute('data-theme') === id) {
            btn.classList.add('active');
        }
        els.themeGrid.appendChild(btn);
    });
}

// ---- Helpers ----------------------------------------------------------------

function updateSendBtn() {
    els.sendBtn.disabled = els.msgInput.value.trim().length === 0 && !state.replyTo;
}

function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    els.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function resetPinUI() {
    state.currentPin = '';
    document.querySelectorAll('.pin-dots span').forEach(s => s.classList.remove('filled'));
}

function cancelReply() {
    state.replyTo = null;
    els.replyPreview.classList.add('hidden');
}

// Start the app
init();
