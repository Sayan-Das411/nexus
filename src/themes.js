// src/themes.js
// Theme management for Nexus.
//
// Themes are defined as maps of CSS custom properties. Applying a theme
// writes all properties to the document root — every element that uses
// var(--...) updates instantly without any class changes.
//
// Phase 3 will add: accent color picker, custom bubble colors, wallpapers,
// video wallpaper, slideshow, and animation style selector.
// The CSS variable names used here are the contract those features will extend.

import { settings } from './db.js';

// ---- Theme definitions ------------------------------------------------------
// Each theme overrides the full set of design tokens.
// High Contrast uses accent-colored borders as requested.

export const THEMES = {

  'deep-dark': {
    label: 'Deep Dark',
    dark: true,
    vars: {
      '--bg':            '#080810',
      '--bg-alt':        '#0c0c18',
      '--surface':       '#0f0f1a',
      '--surface2':      '#141422',
      '--surface3':      '#1a1a2e',
      '--border':        '#1e1e32',
      '--border2':       '#262640',
      '--accent':        '#8b5cf6',
      '--accent-dim':    '#6d44d4',
      '--accent-glow':   'rgba(139,92,246,0.18)',
      '--text':          '#f0efff',
      '--text-dim':      '#7878a0',
      '--text-muted':    '#4a4a6a',
      '--own-bg':        '#6d44d4',
      '--own-text':      '#ffffff',
      '--other-bg':      '#141422',
      '--other-text':    '#f0efff',
      '--online':        '#34d399',
      '--danger':        '#ef4444',
      '--warning':       '#f59e0b',
      '--success':       '#10b981',
      '--shadow':        '0 4px 16px rgba(0,0,0,0.5)',
      '--shadow-sm':     '0 2px 8px rgba(0,0,0,0.4)',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '220ms cubic-bezier(0.4,0,0.2,1)',
    },
  },

  'amoled': {
    label: 'AMOLED Black',
    dark: true,
    vars: {
      '--bg':            '#000000',
      '--bg-alt':        '#050505',
      '--surface':       '#0a0a0a',
      '--surface2':      '#111111',
      '--surface3':      '#1a1a1a',
      '--border':        '#222222',
      '--border2':       '#2e2e2e',
      '--accent':        '#a78bfa',
      '--accent-dim':    '#8b5cf6',
      '--accent-glow':   'rgba(167,139,250,0.2)',
      '--text':          '#ffffff',
      '--text-dim':      '#888888',
      '--text-muted':    '#444444',
      '--own-bg':        '#8b5cf6',
      '--own-text':      '#ffffff',
      '--other-bg':      '#131313',
      '--other-text':    '#ffffff',
      '--online':        '#22c55e',
      '--danger':        '#f87171',
      '--warning':       '#fbbf24',
      '--success':       '#4ade80',
      '--shadow':        'none',
      '--shadow-sm':     'none',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '200ms cubic-bezier(0.4,0,0.2,1)',
    },
  },

  'soft-dark': {
    label: 'Soft Dark',
    dark: true,
    vars: {
      '--bg':            '#1a1a2e',
      '--bg-alt':        '#1e1e36',
      '--surface':       '#22223b',
      '--surface2':      '#2a2a47',
      '--surface3':      '#333360',
      '--border':        '#3a3a5c',
      '--border2':       '#484870',
      '--accent':        '#c084fc',
      '--accent-dim':    '#a855f7',
      '--accent-glow':   'rgba(192,132,252,0.18)',
      '--text':          '#ede9fe',
      '--text-dim':      '#9090b8',
      '--text-muted':    '#5a5a80',
      '--own-bg':        '#a855f7',
      '--own-text':      '#ffffff',
      '--other-bg':      '#22223b',
      '--other-text':    '#ede9fe',
      '--online':        '#4ade80',
      '--danger':        '#f87171',
      '--warning':       '#fbbf24',
      '--success':       '#4ade80',
      '--shadow':        '0 4px 20px rgba(0,0,0,0.35)',
      '--shadow-sm':     '0 2px 10px rgba(0,0,0,0.25)',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '240ms cubic-bezier(0.4,0,0.2,1)',
    },
  },

  'light': {
    label: 'Light',
    dark: false,
    vars: {
      '--bg':            '#f4f4fc',
      '--bg-alt':        '#eeeef8',
      '--surface':       '#ffffff',
      '--surface2':      '#f0f0fa',
      '--surface3':      '#e8e8f4',
      '--border':        '#ddddf0',
      '--border2':       '#cccce0',
      '--accent':        '#7c3aed',
      '--accent-dim':    '#6d28d9',
      '--accent-glow':   'rgba(124,58,237,0.12)',
      '--text':          '#1a1a2e',
      '--text-dim':      '#6060a0',
      '--text-muted':    '#a0a0c8',
      '--own-bg':        '#7c3aed',
      '--own-text':      '#ffffff',
      '--other-bg':      '#f0f0fa',
      '--other-text':    '#1a1a2e',
      '--online':        '#059669',
      '--danger':        '#dc2626',
      '--warning':       '#d97706',
      '--success':       '#059669',
      '--shadow':        '0 2px 12px rgba(0,0,0,0.08)',
      '--shadow-sm':     '0 1px 4px rgba(0,0,0,0.06)',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '220ms cubic-bezier(0.4,0,0.2,1)',
    },
  },

  'whatsapp': {
    label: 'WhatsApp',
    dark: true,
    vars: {
      '--bg':            '#111b21',
      '--bg-alt':        '#0d1518',
      '--surface':       '#202c33',
      '--surface2':      '#2a3942',
      '--surface3':      '#3b4a54',
      '--border':        '#3b4a54',
      '--border2':       '#4a5a64',
      '--accent':        '#00a884',
      '--accent-dim':    '#008f70',
      '--accent-glow':   'rgba(0,168,132,0.15)',
      '--text':          '#e9edef',
      '--text-dim':      '#8696a0',
      '--text-muted':    '#5a6a74',
      '--own-bg':        '#005c4b',
      '--own-text':      '#e9edef',
      '--other-bg':      '#202c33',
      '--other-text':    '#e9edef',
      '--online':        '#00a884',
      '--danger':        '#ff6b6b',
      '--warning':       '#ffa726',
      '--success':       '#00a884',
      '--shadow':        '0 1px 2px rgba(0,0,0,0.5)',
      '--shadow-sm':     '0 1px 1px rgba(0,0,0,0.4)',
      '--radius-xs':     '4px',
      '--radius-sm':     '8px',
      '--radius-md':     '12px',
      '--radius-lg':     '18px',
      '--radius-xl':     '22px',
      '--radius-full':   '9999px',
      '--transition':    '180ms ease',
    },
  },

  'high-contrast': {
    label: 'High Contrast',
    dark: true,
    vars: {
      '--bg':            '#000000',
      '--bg-alt':        '#000000',
      '--surface':       '#0a0a0a',
      '--surface2':      '#111111',
      '--surface3':      '#1a1a1a',
      '--border':        '#8b5cf6',
      '--border2':       '#a78bfa',
      '--accent':        '#8b5cf6',
      '--accent-dim':    '#7c3aed',
      '--accent-glow':   'rgba(139,92,246,0.3)',
      '--text':          '#ffffff',
      '--text-dim':      '#dddddd',
      '--text-muted':    '#aaaaaa',
      '--own-bg':        '#8b5cf6',
      '--own-text':      '#ffffff',
      '--other-bg':      '#111111',
      '--other-text':    '#ffffff',
      '--online':        '#00ff88',
      '--danger':        '#ff4444',
      '--warning':       '#ffcc00',
      '--success':       '#00ff88',
      '--shadow':        'none',
      '--shadow-sm':     'none',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '150ms ease',
    },
  },

  'nord': {
    label: 'Nord',
    dark: true,
    vars: {
      '--bg':            '#1c1f2e',
      '--bg-alt':        '#1e2132',
      '--surface':       '#242840',
      '--surface2':      '#2e3350',
      '--surface3':      '#363d5e',
      '--border':        '#3b4252',
      '--border2':       '#434c5e',
      '--accent':        '#81a1c1',
      '--accent-dim':    '#5e81ac',
      '--accent-glow':   'rgba(129,161,193,0.18)',
      '--text':          '#eceff4',
      '--text-dim':      '#8892a4',
      '--text-muted':    '#555f6e',
      '--own-bg':        '#5e81ac',
      '--own-text':      '#eceff4',
      '--other-bg':      '#2e3350',
      '--other-text':    '#eceff4',
      '--online':        '#a3be8c',
      '--danger':        '#bf616a',
      '--warning':       '#ebcb8b',
      '--success':       '#a3be8c',
      '--shadow':        '0 4px 16px rgba(0,0,0,0.4)',
      '--shadow-sm':     '0 2px 8px rgba(0,0,0,0.3)',
      '--radius-xs':     '6px',
      '--radius-sm':     '10px',
      '--radius-md':     '16px',
      '--radius-lg':     '22px',
      '--radius-xl':     '28px',
      '--radius-full':   '9999px',
      '--transition':    '210ms cubic-bezier(0.4,0,0.2,1)',
    },
  },
};

// ---- Apply theme to DOM -----------------------------------------------------

export function applyTheme(themeId) {
  const theme = THEMES[themeId];
  if (!theme) { console.warn('[themes] Unknown theme:', themeId); return; }

  const root = document.documentElement;
  root.setAttribute('data-theme', themeId);

  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }

  // Update browser theme-color meta tag
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.vars['--accent'] || '#8b5cf6');
}

// ---- Persistence ------------------------------------------------------------

const THEME_KEY = uid => `theme:${uid || 'default'}`;

export async function loadTheme(uid) {
  const saved = await settings.get(THEME_KEY(uid));
  return saved || 'deep-dark';
}

export async function saveTheme(uid, themeId) {
  await settings.set(THEME_KEY(uid), themeId);
  applyTheme(themeId);
}
