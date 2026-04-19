// src/appearance.js
// Per-account appearance customization for Nexus.
// Handles accent color overrides, custom bubble colors, and chat wallpaper.
// These are per-device (stored in IndexedDB) and applied on top of the active theme.

import { settings } from './db.js';

// ---- Storage keys -----------------------------------------------------------
const K = {
  accent:        uid => `appearance:accent:${uid}`,
  ownBubble:     uid => `appearance:own_bubble:${uid}`,
  otherBubble:   uid => `appearance:other_bubble:${uid}`,
  wallpaper:     uid => `appearance:wallpaper:${uid}`,
  slideshowWall: uid => `appearance:slideshow:${uid}`,
  videoWall:     uid => `appearance:video_wall:${uid}`,
  slideshowOpts: uid => `appearance:slideshow_opts:${uid}`,
};

// ---- Load / save ------------------------------------------------------------

export async function loadAppearance(uid) {
  const [accent, ownBubble, otherBubble, wallpaper] = await Promise.all([
    settings.get(K.accent(uid)),
    settings.get(K.ownBubble(uid)),
    settings.get(K.otherBubble(uid)),
    settings.get(K.wallpaper(uid)),
  ]);
  return { accent, ownBubble, otherBubble, wallpaper };
}

export async function saveAccentColor(uid, color)   { await settings.set(K.accent(uid), color); }
export async function clearAccentColor(uid)         { await settings.delete(K.accent(uid)); }
export async function saveOwnBubbleColor(uid, color){ await settings.set(K.ownBubble(uid), color); }
export async function clearOwnBubbleColor(uid)      { await settings.delete(K.ownBubble(uid)); }
export async function saveOtherBubbleColor(uid, c)  { await settings.set(K.otherBubble(uid), c); }
export async function clearOtherBubbleColor(uid)    { await settings.delete(K.otherBubble(uid)); }
export async function saveWallpaper(uid, dataUrl)   { await settings.set(K.wallpaper(uid), dataUrl); }
export async function clearWallpaper(uid)           { await settings.delete(K.wallpaper(uid)); }

export async function saveSlideshowWallpaper(uid, dataUrls) {
  await settings.set(K.slideshowWall(uid), JSON.stringify(dataUrls));
}
export async function loadSlideshowWallpaper(uid) {
  const raw = await settings.get(K.slideshowWall(uid));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
export async function clearSlideshowWallpaper(uid) { await settings.delete(K.slideshowWall(uid)); }

// Slideshow transition options stored as one JSON blob
export async function saveSlideshowOpts(uid, opts) {
  await settings.set(K.slideshowOpts(uid), JSON.stringify(opts));
}
export async function loadSlideshowOpts(uid) {
  const raw = await settings.get(K.slideshowOpts(uid));
  const defaults = { transition: 'crossfade', duration: 800, waterdropX: 50, waterdropY: 50 };
  if (!raw) return defaults;
  try {
    const o = JSON.parse(raw);
    return { ...defaults, ...o };
  } catch { return defaults; }
}
export async function clearSlideshowOpts(uid) { await settings.delete(K.slideshowOpts(uid)); }

export async function saveVideoWallpaper(uid, dataUrl) { await settings.set(K.videoWall(uid), dataUrl); }
export async function loadVideoWallpaper(uid)          { return settings.get(K.videoWall(uid)); }
export async function clearVideoWallpaper(uid)         { await settings.delete(K.videoWall(uid)); }

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

export function applyOtherBubbleColor(hex) {
  if (!hex) return;
  document.documentElement.style.setProperty('--other-bg', hex);
}

export function applyWallpaper(dataUrl) {
  const sApp = document.getElementById('s-app');
  const list = document.getElementById('messages-list');
  if (!sApp || !list) return;
  stopSlideshowWallpaper();
  removeVideoWallpaper();
  if (dataUrl) {
    sApp.style.setProperty('background-image', `url("${dataUrl}")`);
    sApp.style.setProperty('background-size', 'cover');
    sApp.style.setProperty('background-position', 'center');
    sApp.style.setProperty('background-repeat', 'no-repeat');
    sApp.classList.add('has-wallpaper');
    list.classList.add('has-wallpaper');
  } else {
    sApp.style.removeProperty('background-image');
    sApp.style.removeProperty('background-size');
    sApp.style.removeProperty('background-position');
    sApp.style.removeProperty('background-repeat');
    sApp.classList.remove('has-wallpaper');
    list.classList.remove('has-wallpaper');
  }
}

// Returns #s-app — the full-screen flex container.
// Wallpaper layers inserted here fill the entire app (behind header,
// messages AND input bar) so there are no solid black bars framing the image.
// The header and input bar become frosted-glass via CSS when .has-wallpaper
// is set on #s-app.
function getWallpaperContainer() {
  return document.getElementById('s-app');
}

// ---- Video wallpaper --------------------------------------------------------
let _videoWallEl = null;

export function applyVideoWallpaper(dataUrl) {
  removeVideoWallpaper();
  stopSlideshowWallpaper();
  applyWallpaper(null);

  if (!dataUrl) return;

  const container = getWallpaperContainer(); // == #s-app
  const list      = document.getElementById('messages-list');
  if (!container || !list) return;

  list.style.removeProperty('background-image');
  list.classList.add('has-wallpaper');
  container.classList.add('has-wallpaper');

  const video = document.createElement('video');
  video.id          = 'wall-video';
  video.src         = dataUrl;
  video.autoplay    = true;
  video.muted       = true;
  video.loop        = true;
  video.playsInline = true;
  video.className   = 'wall-video';

  const handleVis = () => {
    if (document.hidden) video.pause();
    else                 video.play().catch(() => {});
  };
  document.addEventListener('visibilitychange', handleVis);
  video._visHandler = handleVis;

  // Prepend into #s-app so it sits at z-index:0 behind all flex children
  container.insertBefore(video, container.firstChild);
  _videoWallEl = video;
}

export function removeVideoWallpaper() {
  if (_videoWallEl) {
    if (_videoWallEl._visHandler) {
      document.removeEventListener('visibilitychange', _videoWallEl._visHandler);
    }
    _videoWallEl.pause();
    _videoWallEl.remove();
    _videoWallEl = null;
  }
  // Only remove has-wallpaper if no other wallpaper type is active
  const sApp = document.getElementById('s-app');
  const list = document.getElementById('messages-list');
  if (sApp && !sApp.style.backgroundImage && !document.querySelector('.wall-slide-layer')) {
    sApp.classList.remove('has-wallpaper');
    list?.classList.remove('has-wallpaper');
  }
}

// ---- Slideshow wallpaper ----------------------------------------------------
let _slideshowTimer  = null;
let _slideshowImages = [];
let _slideshowIdx    = 0;
let _slideshowElA    = null;
let _slideshowElB    = null;
let _slideshowFront  = 'A';   // which layer is currently the visible one
let _slideshowTrans  = 'crossfade';
let _slideshowDur    = 800;
let _slideshowWdX    = 50;
let _slideshowWdY    = 50;

// opts: { transition, duration, waterdropX, waterdropY }
export function startSlideshowWallpaper(dataUrls, intervalMs = 30000, opts = {}) {
  stopSlideshowWallpaper();
  removeVideoWallpaper();
  applyWallpaper(null);

  if (!dataUrls?.length) return;
  if (dataUrls.length === 1) { applyWallpaper(dataUrls[0]); return; }

  _slideshowImages = dataUrls;
  _slideshowIdx    = 0;
  _slideshowFront  = 'A';
  _slideshowTrans  = opts.transition  ?? 'crossfade';
  _slideshowDur    = opts.duration    ?? 800;
  _slideshowWdX    = opts.waterdropX  ?? 50;
  _slideshowWdY    = opts.waterdropY  ?? 50;

  const container = getWallpaperContainer(); // == #s-app
  const list      = document.getElementById('messages-list');
  if (!container || !list) return;
  list.classList.add('has-wallpaper');
  container.classList.add('has-wallpaper');

  const makeLayer = () => {
    const el = document.createElement('div');
    el.className = 'wall-slide-layer';
    el.style.opacity = '0';
    // Prepend so layers sit behind #messages-list (which comes after them in DOM order)
    container.insertBefore(el, container.firstChild);
    return el;
  };

  _slideshowElA = makeLayer();
  _slideshowElB = makeLayer();

  // Show first image immediately — no transition
  _slideshowElA.style.backgroundImage = `url("${_slideshowImages[0]}")`;
  _slideshowElA.style.opacity         = '1';
  _slideshowElA.style.zIndex          = '1';
  _slideshowElB.style.zIndex          = '0';

  _slideshowTimer = setInterval(_advanceSlide, intervalMs);
}

function _advanceSlide() {
  if (!_slideshowElA || !_slideshowElB) return;

  _slideshowIdx = (_slideshowIdx + 1) % _slideshowImages.length;
  const nextUrl = _slideshowImages[_slideshowIdx];
  const dur     = _slideshowDur;
  const durS    = `${dur}ms`;

  // front = currently visible; back = about to become visible
  const front = _slideshowFront === 'A' ? _slideshowElA : _slideshowElB;
  const back  = _slideshowFront === 'A' ? _slideshowElB : _slideshowElA;

  // Reset back layer to clean state, then set new image
  back.style.transition        = 'none';
  back.style.opacity           = '0';
  back.style.transform         = 'none';
  back.style.clipPath          = 'none';
  back.style.backgroundImage   = `url("${nextUrl}")`;
  void back.offsetHeight; // force flush

  switch (_slideshowTrans) {

    case 'slide':
      back.style.transform  = 'translateX(100%)';
      back.style.opacity    = '1';
      back.style.zIndex     = '1';
      front.style.zIndex    = '0';
      void back.offsetHeight;
      back.style.transition  = `transform ${durS} cubic-bezier(0.4,0,0.2,1)`;
      front.style.transition = `transform ${durS} cubic-bezier(0.4,0,0.2,1)`;
      back.style.transform  = 'translateX(0)';
      front.style.transform = 'translateX(-30%)';  // subtle push
      setTimeout(() => {
        front.style.transition = 'none';
        front.style.opacity    = '0';
        front.style.transform  = 'none';
      }, dur + 30);
      break;

    case 'zoom':
      back.style.transform  = 'scale(1.10)';
      back.style.opacity    = '0';
      back.style.zIndex     = '1';
      front.style.zIndex    = '0';
      void back.offsetHeight;
      back.style.transition = `opacity ${durS} ease, transform ${durS} ease`;
      back.style.opacity    = '1';
      back.style.transform  = 'scale(1)';
      setTimeout(() => { front.style.opacity = '0'; }, dur);
      break;

    case 'waterdrop': {
      const x = _slideshowWdX, y = _slideshowWdY;
      back.style.clipPath   = `circle(0% at ${x}% ${y}%)`;
      back.style.opacity    = '1';
      back.style.zIndex     = '2';
      front.style.zIndex    = '1';
      void back.offsetHeight;
      back.style.transition = `clip-path ${durS} cubic-bezier(0.25,0.46,0.45,0.94)`;
      back.style.clipPath   = `circle(150% at ${x}% ${y}%)`;
      setTimeout(() => {
        front.style.opacity    = '0';
        front.style.zIndex     = '0';
        back.style.zIndex      = '1';
        back.style.transition  = 'none';
        back.style.clipPath    = 'none';
      }, dur + 30);
      break;
    }

    default: // crossfade
      back.style.zIndex     = '1';
      front.style.zIndex    = '0';
      void back.offsetHeight;
      back.style.transition = `opacity ${durS} ease`;
      back.style.opacity    = '1';
      setTimeout(() => { front.style.opacity = '0'; }, dur);
      break;
  }

  _slideshowFront = _slideshowFront === 'A' ? 'B' : 'A';
}

export function stopSlideshowWallpaper() {
  clearInterval(_slideshowTimer);
  _slideshowTimer = null;
  if (_slideshowElA) { _slideshowElA.remove(); _slideshowElA = null; }
  if (_slideshowElB) { _slideshowElB.remove(); _slideshowElB = null; }
  _slideshowImages = [];
  _slideshowFront  = 'A';
  // Only remove has-wallpaper if no other wallpaper type is active
  const sApp = document.getElementById('s-app');
  const list = document.getElementById('messages-list');
  if (sApp && !sApp.style.backgroundImage && !_videoWallEl) {
    sApp.classList.remove('has-wallpaper');
    list?.classList.remove('has-wallpaper');
  }
}

// Apply all stored appearance settings for the given account.
export async function applyStoredAppearance(uid) {
  const { accent, ownBubble, otherBubble, wallpaper } = await loadAppearance(uid);
  if (accent)      applyAccentColor(accent);
  if (ownBubble)   applyOwnBubbleColor(ownBubble);
  if (otherBubble) applyOtherBubbleColor(otherBubble);

  const videoUrl = await loadVideoWallpaper(uid);
  if (videoUrl) { applyVideoWallpaper(videoUrl); return; }

  const slides = await loadSlideshowWallpaper(uid);
  if (slides.length > 0) {
    const stored = await settings.get(`anim_slideshow_interval:${uid}`);
    const opts   = await loadSlideshowOpts(uid);
    startSlideshowWallpaper(slides, (stored ?? 30) * 1000, opts);
    return;
  }

  if (wallpaper) requestAnimationFrame(() => applyWallpaper(wallpaper));
}

// ---- Wallpaper compression --------------------------------------------------
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

// ---- Crop helper ------------------------------------------------------------
export function cropImage(file, shape = 'rect') {
  return new Promise((resolve, reject) => {
    const img  = new Image();
    const blob = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(blob);

      const overlay = document.createElement('div');
      overlay.id = 'crop-overlay';
      overlay.style.cssText = `
        position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;padding:20px;box-sizing:border-box;`;

      const instructions = document.createElement('div');
      instructions.style.cssText = 'color:#fff;font-size:14px;opacity:0.8;text-align:center;';
      instructions.textContent = 'Drag to reposition · Pinch or scroll to zoom';

      const canvasWrap = document.createElement('div');
      canvasWrap.style.cssText = `
        position:relative;overflow:hidden;border-radius:${shape==='circle'?'50%':'12px'};
        box-shadow:0 0 0 3px rgba(139,92,246,0.8);
        width:min(80vw,320px);height:min(80vw,320px);cursor:grab;flex-shrink:0;`;

      const canvas = document.createElement('canvas');
      const SIZE   = 320;
      canvas.width  = SIZE;
      canvas.height = SIZE;
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      canvasWrap.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      let scale = Math.max(SIZE / img.width, SIZE / img.height);
      let ox = (SIZE - img.width  * scale) / 2;
      let oy = (SIZE - img.height * scale) / 2;

      function draw() {
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale);
      }
      draw();

      function clamp() {
        const w = img.width  * scale;
        const h = img.height * scale;
        if (ox > 0)        ox = 0;
        if (oy > 0)        oy = 0;
        if (ox + w < SIZE) ox = SIZE - w;
        if (oy + h < SIZE) oy = SIZE - h;
      }

      let dragging = false, lastX = 0, lastY = 0;
      canvasWrap.addEventListener('pointerdown', e => {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        canvasWrap.style.cursor = 'grabbing';
        canvasWrap.setPointerCapture(e.pointerId);
      });
      canvasWrap.addEventListener('pointermove', e => {
        if (!dragging) return;
        ox += e.clientX - lastX; oy += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        clamp(); draw();
      });
      canvasWrap.addEventListener('pointerup',     () => { dragging = false; canvasWrap.style.cursor='grab'; });
      canvasWrap.addEventListener('pointercancel', () => { dragging = false; canvasWrap.style.cursor='grab'; });

      canvasWrap.addEventListener('wheel', e => {
        e.preventDefault();
        const minScale = Math.max(SIZE / img.width, SIZE / img.height);
        const oldScale = scale;
        scale = Math.min(Math.max(scale * (1 - e.deltaY * 0.001), minScale), minScale * 6);
        ox -= (SIZE / 2 - ox) * (scale / oldScale - 1);
        oy -= (SIZE / 2 - oy) * (scale / oldScale - 1);
        clamp(); draw();
      }, { passive: false });

      let lastPinchDist = 0;
      canvasWrap.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
          lastPinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY);
        }
      }, { passive: true });
      canvasWrap.addEventListener('touchmove', e => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY);
          const minScale = Math.max(SIZE / img.width, SIZE / img.height);
          const oldScale = scale;
          scale = Math.min(Math.max(scale * (dist / lastPinchDist), minScale), minScale * 6);
          ox -= (SIZE / 2 - ox) * (scale / oldScale - 1);
          oy -= (SIZE / 2 - oy) * (scale / oldScale - 1);
          clamp(); draw();
          lastPinchDist = dist;
        }
      }, { passive: false });

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:12px;';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = `
        padding:10px 24px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);
        background:transparent;color:#fff;font-size:15px;cursor:pointer;`;
      cancelBtn.addEventListener('click', () => { overlay.remove(); reject(new Error('cancelled')); });

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Use';
      confirmBtn.style.cssText = `
        padding:10px 28px;border-radius:10px;border:none;
        background:#8b5cf6;color:#fff;font-size:15px;cursor:pointer;font-weight:600;`;
      confirmBtn.addEventListener('click', () => {
        overlay.remove();
        const out = document.createElement('canvas');
        out.width  = SIZE; out.height = SIZE;
        out.getContext('2d').drawImage(img, ox, oy, img.width * scale, img.height * scale);
        resolve(out.toDataURL('image/jpeg', 0.88));
      });

      btnRow.append(cancelBtn, confirmBtn);
      overlay.append(instructions, canvasWrap, btnRow);
      document.body.appendChild(overlay);
    };
    img.onerror = () => { URL.revokeObjectURL(blob); reject(new Error('Could not load image')); };
    img.src = blob;
  });
}

// ---- Color utilities --------------------------------------------------------

export function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

export function adjustBrightness(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  const adjust = v => {
    const out = factor < 0 ? Math.round(v * (1 + factor)) : Math.round(v + (255 - v) * factor);
    return Math.min(255, Math.max(0, out));
  };
  return '#' + [adjust(r), adjust(g), adjust(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
