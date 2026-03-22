// src/appearance.js
// Per-account appearance customization for Nexus.
// Handles accent color overrides, custom bubble colors, and chat wallpaper.
// These are per-device (stored in IndexedDB) and applied on top of the active theme.
// Profile picture is stored encrypted in Firebase so it syncs across devices.

import { settings } from './db.js';

// ---- Storage keys -----------------------------------------------------------
const K = {
  accent:    uid => `appearance:accent:${uid}`,
  ownBubble: uid => `appearance:own_bubble:${uid}`,
  wallpaper: uid => `appearance:wallpaper:${uid}`,
};

// ---- Load / save ------------------------------------------------------------

export async function loadAppearance(uid) {
  const [accent, ownBubble, wallpaper] = await Promise.all([
    settings.get(K.accent(uid)),
    settings.get(K.ownBubble(uid)),
    settings.get(K.wallpaper(uid)),
  ]);
  return { accent, ownBubble, wallpaper };
}

export async function saveAccentColor(uid, color) {
  await settings.set(K.accent(uid), color);
}

export async function clearAccentColor(uid) {
  await settings.delete(K.accent(uid));
}

export async function saveOwnBubbleColor(uid, color) {
  await settings.set(K.ownBubble(uid), color);
}

export async function clearOwnBubbleColor(uid) {
  await settings.delete(K.ownBubble(uid));
}

export async function saveWallpaper(uid, dataUrl) {
  await settings.set(K.wallpaper(uid), dataUrl);
}

export async function clearWallpaper(uid) {
  await settings.delete(K.wallpaper(uid));
}

// ---- Apply to DOM -----------------------------------------------------------

export function applyAccentColor(hex) {
  if (!hex) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-dim', adjustBrightness(hex, -0.2));
  const [r, g, b] = hexToRgb(hex);
  root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.18)`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', hex);
}

export function applyOwnBubbleColor(hex) {
  if (!hex) return;
  document.documentElement.style.setProperty('--own-bg', hex);
}

export function applyWallpaper(dataUrl) {
  const list = document.getElementById('messages-list');
  if (!list) return;
  if (dataUrl) {
    list.style.setProperty('background-image', `url("${dataUrl}")`);
    list.style.setProperty('background-size', 'cover');
    list.style.setProperty('background-position', 'center');
    list.style.setProperty('background-repeat', 'no-repeat');
    list.classList.add('has-wallpaper');
  } else {
    list.style.removeProperty('background-image');
    list.style.removeProperty('background-size');
    list.style.removeProperty('background-position');
    list.style.removeProperty('background-repeat');
    list.classList.remove('has-wallpaper');
  }
}

// Apply all stored appearance settings for the given account.
// Call after applyTheme() so overrides sit on top of theme defaults.
export async function applyStoredAppearance(uid) {
  const { accent, ownBubble, wallpaper } = await loadAppearance(uid);
  if (accent)    applyAccentColor(accent);
  if (ownBubble) applyOwnBubbleColor(ownBubble);
  if (wallpaper) requestAnimationFrame(() => applyWallpaper(wallpaper));
}

// ---- Wallpaper compression --------------------------------------------------
// Compress an image to a JPEG data URL suitable for chat wallpaper.
// Max 1920×1080, quality 0.75.

export async function compressWallpaper(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX_W = 1920, MAX_H = 1080;
      let { width, height } = img;
      if (width > MAX_W || height > MAX_H) {
        const ratio = Math.min(MAX_W / width, MAX_H / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

// ---- Avatar compression -----------------------------------------------------
// Compress a profile photo to a 200×200 JPEG data URL.

export async function compressAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const SIZE  = 200;
      const ratio = Math.min(SIZE / img.width, SIZE / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

// ---- Color utilities --------------------------------------------------------

export function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [
    parseInt(c.slice(0, 2), 16),
    parseInt(c.slice(2, 4), 16),
    parseInt(c.slice(4, 6), 16),
  ];
}

// factor: negative = darker, positive = lighter  (-1 to 1)
export function adjustBrightness(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  const adjust = v => {
    const out = factor < 0
      ? Math.round(v * (1 + factor))
      : Math.round(v + (255 - v) * factor);
    return Math.min(255, Math.max(0, out));
  };
  return '#' + [adjust(r), adjust(g), adjust(b)]
    .map(v => v.toString(16).padStart(2, '0')).join('');
}
