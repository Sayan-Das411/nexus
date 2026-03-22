// src/realtime.js
// Firebase Realtime Database layer for Nexus.
//
// ALL message content reaching Firebase is already AES-256-GCM encrypted by
// the app layer before calling sendMessage(). This file never touches
// plaintext — it only moves encrypted blobs between the device and Firebase.
//
// Firebase data schema (uid = Firebase auth UID):
//
//   accounts/{uid}/
//     profile/
//       encryptionSalt          — base64, stored once at account creation
//       verificationVector      — JSON string, used to verify passphrase
//       setupComplete           — boolean
//       createdAt               — number
//     devices/{deviceId}/
//       name, platform, addedAt, lastSeen
//     messages/{msgId}/
//       ciphertext, iv          — encrypted content
//       type                    — "text" (Phase 2 adds "image", "file")
//       deviceId, deviceName    — sender identification
//       timestamp               — server timestamp
//       edited, editedAt        — for Phase 4 editing
//       deleted                 — soft delete
//       pinned                  — pinned message flag
//       replyTo                 — msgId or null
//       readBy/{deviceId}       — timestamp of when that device read it
//     typing/{deviceId}/
//       isTyping, updatedAt
//     presence/{deviceId}/
//       online, lastSeen, deviceName
//     spineConfig/              — Phase 2: Drive account pool manifest

import {
  getDatabase, ref, push, set, get, update,
  onValue, off, serverTimestamp, onDisconnect,
  query, orderByChild, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';

import { getFirebaseApp } from './auth.js';

let _db = null;

function db() {
  if (!_db) _db = getDatabase(getFirebaseApp());
  return _db;
}

// ---- Path helpers -----------------------------------------------------------
const P = {
  profile:       uid            => `accounts/${uid}/profile`,
  devices:       uid            => `accounts/${uid}/devices`,
  device:        (uid, did)     => `accounts/${uid}/devices/${did}`,
  messages:      uid            => `accounts/${uid}/messages`,
  message:       (uid, mid)     => `accounts/${uid}/messages/${mid}`,
  readBy:        (uid, mid, did)=> `accounts/${uid}/messages/${mid}/readBy/${did}`,
  typing:        uid            => `accounts/${uid}/typing`,
  typingDevice:  (uid, did)     => `accounts/${uid}/typing/${did}`,
  presence:      uid            => `accounts/${uid}/presence`,
  presenceDevice:(uid, did)     => `accounts/${uid}/presence/${did}`,
};

// ---- Profile setup ----------------------------------------------------------

// Called once during first-time account setup on any device.
// Writes the encryption salt and verification vector to Firebase so that
// subsequent devices can re-derive the same encryption key.
export async function setupProfile(uid, deviceId, deviceName, platform,
                                   encryptionSalt, verificationVector) {
  // Register this device
  await set(ref(db(), P.device(uid, deviceId)), {
    name:     deviceName,
    platform,
    addedAt:  serverTimestamp(),
    lastSeen: serverTimestamp(),
  });

  // Only write the encryption salt once (first device wins)
  const profileRef  = ref(db(), P.profile(uid));
  const profileSnap = await get(profileRef);

  if (!profileSnap.exists() || !profileSnap.val().encryptionSalt) {
    await update(profileRef, {
      encryptionSalt,
      verificationVector: JSON.stringify(verificationVector),
      setupComplete:      true,
      createdAt:          serverTimestamp(),
    });
  }
}

// Register an additional device on an existing account.
// Called when signing in on a second device that is not the first.
export async function registerDevice(uid, deviceId, deviceName, platform) {
  await set(ref(db(), P.device(uid, deviceId)), {
    name:     deviceName,
    platform,
    addedAt:  serverTimestamp(),
    lastSeen: serverTimestamp(),
  });
}

// Fetch the full profile (salt, verification vector, etc.)
export async function getProfile(uid) {
  const snap = await get(ref(db(), P.profile(uid)));
  return snap.exists() ? snap.val() : null;
}

// Touch device's lastSeen timestamp
export async function touchDevice(uid, deviceId) {
  await update(ref(db(), P.device(uid, deviceId)), {
    lastSeen: serverTimestamp(),
  });
}

// Get all registered devices for this account
export async function getDevices(uid) {
  const snap = await get(ref(db(), P.devices(uid)));
  if (!snap.exists()) return {};
  const out = {};
  snap.forEach(c => { out[c.key] = c.val(); });
  return out;
}

// Subscribe to device list changes (real-time)
export function subscribeDevices(uid, cb) {
  const r = ref(db(), P.devices(uid));
  const fn = onValue(r, snap => {
    const out = {};
    snap.forEach(c => { out[c.key] = c.val(); });
    cb(out);
  });
  return () => off(r, 'value', fn);
}

// ---- Messaging --------------------------------------------------------------

// Send an encrypted message payload to Firebase.
// payload must be: { ciphertext, iv, type, deviceId, deviceName, replyTo? }
// Returns the new message's Firebase key.
export async function sendMessage(uid, payload) {
  const msgRef = push(ref(db(), P.messages(uid)));

  // Build the record. Core fields are always present.
  // Media fields (uuid, fileName, fileSize, mimeType, encThumb) are included
  // only when present — text messages don't have them, media messages do.
  const record = {
    ciphertext:  payload.ciphertext,
    iv:          payload.iv,
    type:        payload.type ?? 'text',
    deviceId:    payload.deviceId,
    deviceName:  payload.deviceName,
    replyTo:     payload.replyTo ?? null,
    timestamp:   serverTimestamp(),
    edited:      false,
    editedAt:    null,
    deleted:     false,
    pinned:      false,
    readBy:      { [payload.deviceId]: Date.now() },
  };

  // Attach media metadata when present (Phase 2)
  if (payload.uuid)     record.uuid     = payload.uuid;
  if (payload.fileName) record.fileName = payload.fileName;
  if (payload.fileSize) record.fileSize = payload.fileSize;
  if (payload.mimeType) record.mimeType = payload.mimeType;
  if (payload.encThumb) record.encThumb = payload.encThumb;

  await set(msgRef, record);

  return msgRef.key;
}

// Subscribe to the most recent `limit` messages (real-time).
// Callback receives an array sorted oldest → newest.
export function subscribeMessages(uid, cb, limit = 150) {
  const q = query(
    ref(db(), P.messages(uid)),
    orderByChild('timestamp'),
    limitToLast(limit)
  );

  const fn = onValue(q, snap => {
    const msgs = [];
    snap.forEach(child => {
      msgs.push({ id: child.key, ...child.val() });
    });
    cb(msgs); // already ordered by timestamp ascending via orderByChild
  });

  return () => off(q, 'value', fn);
}

// Mark a specific message as read by this device
export async function markRead(uid, msgId, deviceId) {
  await set(ref(db(), P.readBy(uid, msgId, deviceId)), Date.now());
}

// ---- Typing indicator -------------------------------------------------------

let _typingTimer = null;

export async function setTyping(uid, deviceId, isTyping) {
  clearTimeout(_typingTimer);
  await set(ref(db(), P.typingDevice(uid, deviceId)), {
    isTyping,
    updatedAt: serverTimestamp(),
  });

  // Auto-clear after 6 seconds as a safety net
  if (isTyping) {
    _typingTimer = setTimeout(() => setTyping(uid, deviceId, false), 6000);
  }
}

// Subscribe to typing status of OTHER devices
export function subscribeTyping(uid, myDeviceId, cb) {
  const r  = ref(db(), P.typing(uid));
  const fn = onValue(r, snap => {
    const typing = [];
    snap.forEach(child => {
      if (child.key === myDeviceId) return;
      const v       = child.val();
      const recent  = v.updatedAt && (Date.now() - v.updatedAt < 8000);
      if (v.isTyping && recent) typing.push(child.key);
    });
    cb(typing);
  });
  return () => off(r, 'value', fn);
}

// ---- Presence ---------------------------------------------------------------

// Mark this device online. Firebase will set it offline automatically on
// disconnect via onDisconnect().
export async function setupPresence(uid, deviceId, deviceName) {
  const presRef = ref(db(), P.presenceDevice(uid, deviceId));

  await onDisconnect(presRef).set({
    online:     false,
    lastSeen:   serverTimestamp(),
    deviceName,
  });

  await set(presRef, {
    online:     true,
    lastSeen:   serverTimestamp(),
    deviceName,
  });
}

// Update the avatar stored in the profile (encrypted { ciphertext, iv } JSON string)
export async function updateProfileAvatar(uid, encryptedAvatarJson) {
  await update(ref(db(), P.profile(uid)), {
    avatar: encryptedAvatarJson, // null to remove
  });
}

// Subscribe to presence of OTHER devices
export function subscribePresence(uid, myDeviceId, cb) {
  const r  = ref(db(), P.presence(uid));
  const fn = onValue(r, snap => {
    const presMap = {};
    snap.forEach(child => {
      if (child.key !== myDeviceId) presMap[child.key] = child.val();
    });
    cb(presMap);
  });
  return () => off(r, 'value', fn);
}
