// src/dialogs.js
// Custom modal dialogs (confirm, prompt, lightbox, toast) for Nexus.
// Replaces window.confirm() and window.prompt() which are blocked in PWA standalone mode.

export function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('toast-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('toast-visible'), duration);
}

export function nexusConfirm(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
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

export function nexusPrompt(message, defaultValue = '') {
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
    txt.style.cssText = 'margin:0;font-size:15px;line-height:1.5;color:var(--text);text-align:center';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.className = 'text-input';
    input.style.cssText = 'width:100%;margin:0;box-sizing:border-box';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.style.cssText = 'flex:1;max-width:140px';

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.className = 'btn btn-primary';
    okBtn.style.cssText = 'flex:1;max-width:140px';

    const done = (val) => { overlay.remove(); resolve(val); };
    cancelBtn.addEventListener('click', () => done(null));
    okBtn.addEventListener('click',     () => done(input.value.trim()));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  done(input.value.trim());
      if (e.key === 'Escape') done(null);
    });

    btnRow.append(cancelBtn, okBtn);
    panel.append(txt, input, btnRow);
    overlay.append(panel);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

export function showLightbox(url, title, isVideo = false) {
  let lb = document.getElementById('media-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'media-lightbox';
    lb.innerHTML = `
      <div class="lb-backdrop"></div>
      <div class="lb-content">
        <div class="lb-toolbar">
          <button class="lb-download" title="Download">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M10 3v10M6 9l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 15h14" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="lb-close">&times;</button>
        </div>
        <div id="lb-media-wrap" style="display:flex;justify-content:center;align-items:center;width:100%">
          <img id="lb-img" src="" alt="" style="display:none">
          <video id="lb-video" controls autoplay playsinline style="display:none"></video>
        </div>
        <div class="lb-title" id="lb-title"></div>
      </div>`;
    document.body.appendChild(lb);

    const close = () => {
      lb.classList.add('hidden');
      const v = lb.querySelector('#lb-video');
      if (v) { v.pause(); v.src = ''; }
      if (lb.dataset.activeUrl) {
        URL.revokeObjectURL(lb.dataset.activeUrl);
        delete lb.dataset.activeUrl;
      }
    };

    lb.querySelector('.lb-backdrop').addEventListener('click', close);
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.querySelector('.lb-download').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = lb.dataset.activeUrl;
      a.download = lb.querySelector('#lb-title').textContent || 'download';
      a.click();
    });
  }

  if (lb.dataset.activeUrl && lb.dataset.activeUrl !== url) {
    URL.revokeObjectURL(lb.dataset.activeUrl);
  }
  lb.dataset.activeUrl = url;

  const imgEl   = lb.querySelector('#lb-img');
  const videoEl = lb.querySelector('#lb-video');
  const titleEl = lb.querySelector('#lb-title');

  if (isVideo) {
    imgEl.style.display = 'none';
    imgEl.src = '';
    videoEl.style.display = 'block';
    videoEl.src = url;
    videoEl.play().catch(() => {});
  } else {
    videoEl.style.display = 'none';
    videoEl.pause();
    videoEl.src = '';
    imgEl.style.display = 'block';
    imgEl.src = url;
  }

  titleEl.textContent = title ?? '';
  lb.classList.remove('hidden');
}
