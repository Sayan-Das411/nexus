// src/realtime.js
// Firestore layer for Nexus.
//
// ALL message content reaching Firebase is already AES-256-GCM encrypted by
// the app layer before calling sendMessage(). This file never touches
// plaintext — it only moves encrypted blobs between the device and Firebase.

import {
  getFirestore, collection, doc, setDoc, getDoc, updateDoc, addDoc, getDocs,
  onSnapshot, query, orderBy, limit
} from 'firebase/firestore';

import { getFirebaseApp } from './auth.js';
import firebaseConfig from '../firebase-applet-config.json';

let _db = null;

function db() {
  if (!_db) {
    const app = getFirebaseApp();
    _db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
  return _db;
}

// ---- Error Handling ---------------------------------------------------------

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ---- Path helpers -----------------------------------------------------------
const P = {
  profile:       uid            => `accounts/${uid}/profile/main`,
  devices:       uid            => `accounts/${uid}/devices`,
  device:        (uid, did)     => `accounts/${uid}/devices/${did}`,
  messages:      uid            => `accounts/${uid}/messages`,
  message:       (uid, mid)     => `accounts/${uid}/messages/${mid}`,
  typing:        uid            => `accounts/${uid}/typing`,
  typingDevice:  (uid, did)     => `accounts/${uid}/typing/${did}`,
  presence:      uid            => `accounts/${uid}/presence`,
  presenceDevice:(uid, did)     => `accounts/${uid}/presence/${did}`,
};

// ---- Profile setup ----------------------------------------------------------

export async function setupProfile(uid, deviceId, deviceName, platform,
                                   encryptionSalt, verificationVector) {
  const devicePath = P.device(uid, deviceId);
  try {
    await setDoc(doc(db(), devicePath), {
      name:     deviceName,
      platform,
      addedAt:  Date.now(),
      lastSeen: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, devicePath);
  }

  const profilePath = P.profile(uid);
  try {
    const profileRef = doc(db(), profilePath);
    const profileSnap = await getDoc(profileRef);

    if (!profileSnap.exists() || !profileSnap.data().encryptionSalt) {
      await setDoc(profileRef, {
        encryptionSalt,
        verificationVector: JSON.stringify(verificationVector),
        setupComplete:      true,
        createdAt:          Date.now(),
      }, { merge: true });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, profilePath);
  }
}

export async function registerDevice(uid, deviceId, deviceName, platform) {
  const path = P.device(uid, deviceId);
  try {
    await setDoc(doc(db(), path), {
      name:     deviceName,
      platform,
      addedAt:  Date.now(),
      lastSeen: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function getProfile(uid) {
  const path = P.profile(uid);
  try {
    const snap = await getDoc(doc(db(), path));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function touchDevice(uid, deviceId) {
  const path = P.device(uid, deviceId);
  try {
    await updateDoc(doc(db(), path), {
      lastSeen: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function getDevices(uid) {
  const path = P.devices(uid);
  try {
    const querySnap = await getDocs(collection(db(), path));
    const out = {};
    querySnap.forEach(doc => { out[doc.id] = doc.data(); });
    return out;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export function subscribeDevices(uid, cb) {
  const path = P.devices(uid);
  const r = collection(db(), path);
  return onSnapshot(r, (snap) => {
    const out = {};
    snap.forEach(doc => { out[doc.id] = doc.data(); });
    cb(out);
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}

// ---- Messaging --------------------------------------------------------------

export async function sendMessage(uid, payload) {
  const path = P.messages(uid);
  const record = {
    ciphertext:  payload.ciphertext,
    iv:          payload.iv,
    type:        payload.type ?? 'text',
    deviceId:    payload.deviceId,
    deviceName:  payload.deviceName,
    replyTo:     payload.replyTo ?? null,
    timestamp:   Date.now(),
    edited:      false,
    editedAt:    null,
    deleted:     false,
    pinned:      false,
    readBy:      { [payload.deviceId]: Date.now() },
  };

  if (payload.uuid)     record.uuid     = payload.uuid;
  if (payload.fileName) record.fileName = payload.fileName;
  if (payload.fileSize) record.fileSize = payload.fileSize;
  if (payload.mimeType) record.mimeType = payload.mimeType;
  if (payload.encThumb) record.encThumb = payload.encThumb;

  try {
    const docRef = await addDoc(collection(db(), path), record);
    return docRef.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export function subscribeMessages(uid, cb, limitCount = 150) {
  const path = P.messages(uid);
  const q = query(
    collection(db(), path),
    orderBy('timestamp', 'asc'),
    limit(limitCount)
  );

  return onSnapshot(q, (snap) => {
    const msgs = [];
    snap.forEach(doc => {
      msgs.push({ id: doc.id, ...doc.data() });
    });
    cb(msgs);
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}

export async function markRead(uid, msgId, deviceId) {
  const path = P.message(uid, msgId);
  try {
    await updateDoc(doc(db(), path), {
      [`readBy.${deviceId}`]: Date.now()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// ---- Typing indicator -------------------------------------------------------

let _typingTimer = null;

export async function setTyping(uid, deviceId, isTyping) {
  clearTimeout(_typingTimer);
  const path = P.typingDevice(uid, deviceId);
  try {
    await setDoc(doc(db(), path), {
      isTyping,
      updatedAt: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }

  if (isTyping) {
    _typingTimer = setTimeout(() => setTyping(uid, deviceId, false), 6000);
  }
}

export function subscribeTyping(uid, myDeviceId, cb) {
  const path = P.typing(uid);
  const r  = collection(db(), path);
  return onSnapshot(r, (snap) => {
    const typing = [];
    snap.forEach(doc => {
      if (doc.id === myDeviceId) return;
      const v       = doc.data();
      const recent  = v.updatedAt && (Date.now() - v.updatedAt < 8000);
      if (v.isTyping && recent) typing.push(doc.id);
    });
    cb(typing);
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}

// ---- Presence ---------------------------------------------------------------

export async function setupPresence(uid, deviceId, deviceName) {
  const path = P.presenceDevice(uid, deviceId);
  // Note: Firestore doesn't have onDisconnect like RTDB.
  // We'll just set online: true and rely on lastSeen for presence logic.
  try {
    await setDoc(doc(db(), path), {
      online:     true,
      lastSeen:   Date.now(),
      deviceName,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateProfileAvatar(uid, encryptedAvatarJson) {
  const path = P.profile(uid);
  try {
    await updateDoc(doc(db(), path), {
      avatar: encryptedAvatarJson,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export function subscribePresence(uid, myDeviceId, cb) {
  const path = P.presence(uid);
  const r  = collection(db(), path);
  return onSnapshot(r, (snap) => {
    const presMap = {};
    snap.forEach(doc => {
      if (doc.id !== myDeviceId) presMap[doc.id] = doc.data();
    });
    cb(presMap);
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}
