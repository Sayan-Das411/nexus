// src/chat-view.js
// Message rendering, formatting, reactions, context menu, multi-selection, and search for Nexus.

import { platformIcon } from './auth.js';
import { formatBytes, decryptThumbnail, buildFileBubbleHTML } from './media.js';
import { settings } from './db.js';
import { toast, nexusConfirm } from './dialogs.js';
import { reactToMessage, deleteMessage } from './realtime.js';
import { deleteMedia } from './spine.js';
import { decrypt } from './crypto.js';

// ---- Escaping and formatting ------------------------------------------------
export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escAttr(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function avatarLetter(emailOrName) {
  return (emailOrName?.[0] ?? '?').toUpperCase();
}

export function formatText(escaped) {
  return escaped
    .replace(/\*([^*\n]+)\*/g,    '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g,      '<em>$1</em>')
    .replace(/`([^`\n]+)`/g,      '<code>$1</code>')
    .replace(/https?:\/\/[^\s<>"]+/g, url =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\n/g, '<br>');
}

// ---- Link Previews ----------------------------------------------------------
const _linkPreviewCache = new Map();

export async function fetchLinkPreview(url, deviceKey) {
  if (_linkPreviewCache.has(url)) return _linkPreviewCache.get(url);
  const enabled = await settings.get(`link_previews:${deviceKey}`);
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

export function buildLinkPreviewHTML(preview) {
  if (!preview) return '';
  const rawUrl = preview.url ?? '';
  if (!/^https?:\/\//i.test(rawUrl)) return '';
  const rawImg = preview.image ?? '';
  const safeImgSrc = /^https?:\/\//i.test(rawImg) ? escHtml(rawImg) : '';

  const safeTitle = escHtml(preview.title ?? '');
  const safeDesc  = escHtml((preview.desc ?? '').slice(0, 160));
  const safeHost  = escHtml(preview.host ?? '');
  const imgHtml   = safeImgSrc
    ? `<img class="lp-image" src="${safeImgSrc}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';

  return `<a class="link-preview" href="${escAttr(rawUrl)}" target="_blank" rel="noopener noreferrer">
    ${imgHtml}
    <div class="lp-body">
      ${safeTitle ? `<div class="lp-title">${safeTitle}</div>` : ''}
      ${safeDesc  ? `<div class="lp-desc">${safeDesc}</div>`   : ''}
      <div class="lp-host">${safeHost}</div>
    </div>
  </a>`;
}

export function extractFirstUrl(text) {
  const m = text?.match(/https?:\/\/[^\s<>"]+/);
  return m ? m[0] : null;
}

export async function injectLinkPreview(msgId, url, deviceKey) {
  const preview = await fetchLinkPreview(url, deviceKey);
  if (!preview) return;
  const list = document.getElementById('messages-list');
  const row = list ? list.querySelector(`.msg-row[data-id="${CSS.escape(msgId)}"]`) : null;
  const bubble = row?.querySelector('.msg-bubble');
  if (!bubble || bubble.querySelector('.link-preview')) return;
  const meta = bubble.querySelector('.msg-meta');
  if (meta) meta.insertAdjacentHTML('beforebegin', buildLinkPreviewHTML(preview));
}

// ---- Reactions HTML ---------------------------------------------------------
export function buildReactionsHTML(reactions, msgId) {
  if (!reactions || !Object.keys(reactions).length) return '';
  const agg = {};
  for (const [emoji, deviceMap] of Object.entries(reactions)) {
    if (!deviceMap) continue;
    const entries = Object.entries(deviceMap).filter(([, v]) => v);
    if (!entries.length) continue;
    agg[emoji] = {
      count: entries.length,
      mine: entries.some(([did]) => did === window._nexusDeviceId)
    };
  }
  if (!Object.keys(agg).length) return '';
  const safeId = escAttr(msgId);
  return `<div class="msg-reactions">${
    Object.entries(agg).map(([emoji, { count, mine }]) =>
      `<span class="reaction-pill${mine ? ' mine' : ''}"
             data-react-msg="${safeId}"
             data-react-emoji="${escAttr(emoji)}"
             title="${count} reaction${count > 1 ? 's' : ''}">${escHtml(emoji)}${count > 1 ? ` ${count}` : ''}</span>`
    ).join('')
  }</div>`;
}

// ---- Message row HTML builder -----------------------------------------------
export function buildMessageHTML(msg, isOwn, showDeviceName, time, readByOthers, S, deviceAvatarCache) {
  const side        = isOwn ? 'own' : 'other';
  const devPlatform = S.devices[msg.deviceId]?.platform ?? 'unknown';
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
      const rawDecrypted = quoted._decryptedText ?? '';
      const isMediaJson  = (type === 'image' || type === 'file') && rawDecrypted.startsWith('{');
      if (isMediaJson || !rawDecrypted) {
        const isVideo = quoted.mimeType?.startsWith('video/');
        const isAudio = quoted.mimeType?.startsWith('audio/');
        const mediaLabel = isVideo ? `🎬 ${escHtml(quoted.fileName ?? 'Video')}`
                         : isAudio ? `🎵 ${escHtml(quoted.fileName ?? 'Audio')}`
                         : `📎 ${escHtml(quoted.fileName ?? 'File')}`;
        qText = type === 'image' ? (quoted.caption ? `📷 Photo: ${escHtml(quoted.caption)}` : '📷 Photo')
              : type === 'file'  ? (quoted.caption ? `${mediaLabel}: ${escHtml(quoted.caption)}` : mediaLabel)
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
    const captionHtml = msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '';
    content = `<div id="${thumbId}" class="media-bubble media-image" data-uuid="${escHtml(msg.uuid)}">
      <div class="media-placeholder" data-open-media="${escAttr(msg.uuid)}" style="cursor:pointer">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        <span>${escHtml(msg.fileName ?? 'Image')}</span>
      </div>
      ${captionHtml}
    </div>`;
  } else if (msg.type === 'file' && msg.uuid && msg.mimeType?.startsWith('audio/')) {
    const audioId = `audio-${escHtml(msg.id)}`;
    const captionHtml = msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '';
    content = `<div class="media-bubble media-audio" id="${audioId}" data-uuid="${escHtml(msg.uuid)}">
      <div class="audio-placeholder">
        <div class="audio-icon">🎵</div>
        <div class="audio-info">
          <div class="file-name">${escHtml(msg.fileName ?? 'Audio')}</div>
          <div class="file-size">${formatBytes(msg.fileSize ?? 0)}</div>
        </div>
        <button class="audio-load-btn" data-load-audio="${escAttr(msg.uuid)}" data-container-id="${audioId}">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8">
            <polygon points="6,3 15,9 6,15" fill="currentColor" stroke="none"/>
          </svg>
        </button>
      </div>
      ${captionHtml}
    </div>`;
  } else if (msg.type === 'file' && msg.uuid && msg.mimeType?.startsWith('video/')) {
    const captionHtml = msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '';
    content = `<div class="media-bubble media-video" data-uuid="${escHtml(msg.uuid)}" data-open-media="${escAttr(msg.uuid)}" style="cursor:pointer">
      <div class="video-placeholder">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="10" stroke="currentColor"/>
          <polygon points="10,8 16,12 10,16" fill="currentColor"/>
        </svg>
        <div class="file-info">
          <div class="file-name">${escHtml(msg.fileName ?? 'Video')}</div>
          <div class="file-size">${formatBytes(msg.fileSize ?? 0)}</div>
        </div>
      </div>
      ${captionHtml}
    </div>`;
  } else if (msg.type === 'file' && msg.uuid) {
    const captionHtml = msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '';
    content = buildFileBubbleHTML(msg) + captionHtml;
  } else {
    // Check for JSON media fallback
    const rawText = msg.text ?? '';
    let mediaFallback = false;
    if (rawText.startsWith('{') && rawText.includes('"uuid"')) {
      try {
        const meta = JSON.parse(rawText);
        if (meta.uuid && meta.mediaType) {
          msg.uuid     = meta.uuid;
          msg.fileName = meta.fileName;
          msg.fileSize = meta.fileSize;
          msg.mimeType = meta.mimeType;
          msg.caption  = meta.caption;
          msg.type     = meta.mediaType;
          content = buildFileBubbleHTML(msg) + (msg.caption ? `<div class="media-caption">${escHtml(msg.caption)}</div>` : '');
          mediaFallback = true;
        }
      } catch {}
    }
    if (!mediaFallback) {
      content = formatText(escHtml(rawText));
    }
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
      const devAvatar = deviceAvatarCache.get(msg.deviceId);
      const imgInner  = devAvatar
        ? `<img src="${escAttr(devAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">`
        : avatarLetter(S.devices[msg.deviceId]?.name ?? msg.deviceName ?? '?');
      const initialAttr = devAvatar ? '' : ' data-initial="1"';
      return `<div class="msg-avatar-col"><div class="msg-avatar-img"${initialAttr}>${imgInner}</div></div>`;
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
    <div class="msg-row ${side}" data-id="${escHtml(msg.id)}" data-device-id="${escAttr(msg.deviceId)}">
      ${deviceBadge}
      ${innerHtml}
    </div>`;
}

// ---- Multi-Select State and Toolbar -----------------------------------------
export const SEL = {
  active: false,
  selected: new Set(),
};

export function enterSelectMode(firstMsgId, S) {
  SEL.active = true;
  SEL.selected.clear();
  if (firstMsgId) SEL.selected.add(firstMsgId);
  document.getElementById('msg-input')?.blur();

  document.querySelectorAll('.msg-row:not([data-pending-id])').forEach(row => {
    row.classList.add('msg-selectable');
    if (!row.querySelector('.msg-select-check')) {
      const chk = document.createElement('div');
      chk.className = 'msg-select-check';
      chk.setAttribute('aria-hidden', 'true');
      chk.innerHTML = '✓';
      row.appendChild(chk);
    }
    if (SEL.selected.has(row.dataset.id)) row.classList.add('msg-selected');
  });

  showSelectToolbar(S);
}

export function exitSelectMode() {
  SEL.active = false;
  SEL.selected.clear();
  document.querySelectorAll('.msg-row').forEach(row => {
    row.classList.remove('msg-selectable', 'msg-selected');
    row.querySelector('.msg-select-check')?.remove();
  });
  document.getElementById('select-toolbar')?.remove();
}

export function showSelectToolbar(S) {
  let bar = document.getElementById('select-toolbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'select-toolbar';

    const countEl = document.createElement('span');
    countEl.className = 'select-toolbar-count';
    countEl.id = 'sel-count';

    const allBtn = document.createElement('button');
    allBtn.id = 'sel-all-btn';
    allBtn.className = 'select-toolbar-btn accent';
    allBtn.textContent = 'Select All';
    allBtn.addEventListener('click', () => {
      const selectableRows = document.querySelectorAll('.msg-row.msg-selectable');
      const allSelected = Array.from(selectableRows).every(r => SEL.selected.has(r.dataset.id));
      if (allSelected) {
        // Deselect all
        SEL.selected.clear();
        selectableRows.forEach(r => r.classList.remove('msg-selected'));
      } else {
        // Select all
        selectableRows.forEach(row => {
          const id = row.dataset.id;
          if (id && !id.startsWith('pending-')) {
            SEL.selected.add(id);
            row.classList.add('msg-selected');
          }
        });
      }
      updateSelectToolbar(S);
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
      if (SEL.selected.size === 0) return;
      let textToCopy = '';
      if (SEL.selected.size === 1) {
        const msgId = [...SEL.selected][0];
        const msg   = S.messages.find(m => m.id === msgId);
        textToCopy  = msg?._decryptedText ?? (msg?.caption ?? '');
      } else {
        // Multi-message copy
        const sortedMsgs = S.messages
          .filter(m => SEL.selected.has(m.id) && !m.deleted)
          .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        textToCopy = sortedMsgs.map(m => {
          const sender = m.deviceId === S.deviceId ? 'You' : (S.devices[m.deviceId]?.name ?? m.deviceName ?? 'Other');
          const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          const body = m._decryptedText || (m.type === 'image' ? `[Photo${m.caption ? `: ${m.caption}` : ''}]` : m.type === 'file' ? `[File: ${m.fileName || 'file'}]` : '');
          return `[${time}] ${sender}: ${body}`;
        }).join('\n\n');
      }

      if (legacyCopy(textToCopy)) { exitSelectMode(); return; }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(textToCopy)
          .then(() => { exitSelectMode(); toast('Copied'); })
          .catch(() => { toast('Copy failed'); exitSelectMode(); });
      } else {
        toast('Copy failed'); exitSelectMode();
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
      window.dispatchEvent(new CustomEvent('nexus:start-edit', { detail: msg }));
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
            catch (err) { console.warn('[delete] Drive cleanup failed:', err.message); }
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
  updateSelectToolbar(S);
  bar.classList.remove('hidden');
}

export function updateSelectToolbar(S) {
  const n       = SEL.selected.size;
  const countEl = document.getElementById('sel-count');
  const delBtn  = document.getElementById('sel-delete-btn');
  const copyBtn = document.getElementById('sel-copy-btn');
  const editBtn = document.getElementById('sel-edit-btn');
  const allBtn  = document.getElementById('sel-all-btn');

  if (countEl) countEl.textContent = `${n} selected`;

  if (delBtn) {
    delBtn.textContent   = n > 0 ? `Delete (${n})` : 'Delete';
    delBtn.disabled      = n === 0;
    delBtn.style.opacity = n === 0 ? '0.4' : '';
  }

  // Copy button available for any non-zero selection!
  if (copyBtn) {
    copyBtn.classList.toggle('hidden', n === 0);
  }

  // Edit button only for single own text message
  if (editBtn) {
    if (n === 1) {
      const msgId = [...SEL.selected][0];
      const msg   = S.messages.find(m => m.id === msgId);
      const isText = !msg?.type || msg?.type === 'text';
      const isOwnText = isText && msg?.deviceId === S.deviceId && !msg?.deleted && msg?._decryptedText;
      editBtn.classList.toggle('hidden', !isOwnText);
    } else {
      editBtn.classList.add('hidden');
    }
  }

  if (allBtn) {
    const totalSelectable = document.querySelectorAll('.msg-row.msg-selectable').length;
    allBtn.textContent = (n > 0 && n === totalSelectable) ? 'Deselect All' : 'Select All';
  }
}

export function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast('Copied'); return true; }
  } catch {}
  return false;
}

// ---- Context Menu -----------------------------------------------------------
export function closeContextMenu() {
  document.getElementById('ctx-menu')?.remove();
  document.removeEventListener('pointerdown', closeContextMenuOutside);
}

function closeContextMenuOutside(e) {
  const menu = document.getElementById('ctx-menu');
  if (menu && !menu.contains(e.target)) closeContextMenu();
}

export function openContextMenu(row, e, S, onStartReply, onStartEdit, onConfirmDelete, onOpenMedia) {
  if (!row) return;
  const msgId = row.dataset.id;
  if (!msgId || msgId.startsWith('pending-')) return;

  const msg = S.messages.find(m => m.id === msgId);
  if (!msg || msg.deleted) return;

  const isOwn  = msg.deviceId === S.deviceId;
  const isText = !msg.type || msg.type === 'text';

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

  actions.push({ label: '↩ Reply', fn: () => onStartReply(msg) });

  if (isText || msg.caption) {
    actions.push({ label: 'Copy', fn: () => {
      const text = msg._decryptedText ?? (msg.caption ?? '');
      if (legacyCopy(text)) return;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => toast('Copied'))
          .catch(() => toast('Copy failed'));
      } else {
        toast('Copy failed');
      }
    }});
  }

  if (isOwn && isText) {
    actions.push({ label: 'Edit', fn: () => onStartEdit(msg) });
  }

  actions.push({ label: 'Delete', danger: true, fn: () => onConfirmDelete(msgId) });

  if (msg.uuid) {
    actions.push({ label: 'Download', fn: () => onOpenMedia(msg.uuid) });
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

  const rect = menu.getBoundingClientRect();
  const mw   = rect.width  || 220;
  const mh   = rect.height || 280;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const MARGIN = 8;

  const rawX = e?.clientX ?? vw / 2;
  const rawY = e?.clientY ?? vh / 2;

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

// ---- In-Chat Search ---------------------------------------------------------
let _searchDebounce = null;

export function openSearch(S, onNavigateToMsg) {
  const header = document.querySelector('.app-header');
  const searchBar = document.getElementById('header-search-bar');
  const searchInput = document.getElementById('search-input');
  if (!header || !searchBar || !searchInput) return;

  header.classList.add('search-active');
  searchBar.classList.remove('hidden');
  searchInput.value = '';
  searchInput.focus();

  let dropdown = document.getElementById('search-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'search-dropdown';
    dropdown.className = 'search-dropdown hidden';
    const sApp = document.getElementById('s-app');
    if (sApp) sApp.insertBefore(dropdown, sApp.children[1]);
  }
  dropdown.innerHTML = '<div class="search-empty" id="search-empty">Type to search your messages</div>';
  dropdown.classList.remove('hidden');

  searchInput.oninput = (e) => {
    clearTimeout(_searchDebounce);
    const q = e.target.value.trim();
    if (!q) { renderSearchResults([], '', onNavigateToMsg, S); return; }
    _searchDebounce = setTimeout(() => runSearch(q, S, onNavigateToMsg), 180);
  };

  const closeBtn = document.getElementById('search-close-btn');
  if (closeBtn) closeBtn.onclick = () => closeSearch();
}

export function closeSearch() {
  const header = document.querySelector('.app-header');
  const searchBar = document.getElementById('header-search-bar');
  if (header) header.classList.remove('search-active');
  if (searchBar) searchBar.classList.add('hidden');
  document.getElementById('search-dropdown')?.classList.add('hidden');
}

async function runSearch(query, S, onNavigateToMsg) {
  if (!S.encKey || !S.messages.length) return;
  const q = query.toLowerCase();
  const results = [];
  for (const msg of S.messages) {
    if (msg.deleted) continue;
    let text = msg._decryptedText;
    if (!text && msg.ciphertext) {
      try {
        text = await decrypt(S.encKey, msg.ciphertext, msg.iv);
        msg._decryptedText = text;
      } catch { continue; }
    }
    if (!text && msg.caption) text = msg.caption;
    if (!text) continue;
    if (text.toLowerCase().includes(q)) results.push({ msg, text });
  }
  renderSearchResults(results, query, onNavigateToMsg, S);
}

function renderSearchResults(results, query = '', onNavigateToMsg, S) {
  const el = document.getElementById('search-dropdown');
  if (!el) return;

  if (!results.length) {
    el.innerHTML = `<div class="search-empty" id="search-empty">${
      query ? `No results for "${escHtml(query)}"` : 'Type to search your messages'
    }</div>`;
    return;
  }

  el.innerHTML = '';
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
    row.addEventListener('click', () => {
      closeSearch();
      if (onNavigateToMsg) onNavigateToMsg(msg.id);
    });
    frag.appendChild(row);
  }
  el.appendChild(frag);
}
