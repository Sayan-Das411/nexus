# Patches for index.html — apply these to your local index.html file

PATCHES = [
    # 1. Add --msg-font-size to :root defaults
    {
        "find": "      --transition:    220ms cubic-bezier(0.4,0,0.2,1);\n\n      /* Layout constants",
        "replace": "      --transition:    220ms cubic-bezier(0.4,0,0.2,1);\n      --msg-font-size: 16px;\n\n      /* Layout constants"
    },

    # 2. .msg-bubble: use CSS variable for font-size, wider max-width
    {
        "find": "      max-width: min(75%, 340px);\n      padding: 9px 13px;\n      border-radius: var(--radius-lg);\n      word-break: break-word;\n      font-size: 14.5px;",
        "replace": "      max-width: min(85%, 520px);\n      padding: 9px 13px;\n      border-radius: var(--radius-lg);\n      word-break: break-word;\n      font-size: var(--msg-font-size, 16px);"
    },

    # 3. Desktop .msg-bubble wider
    {
        "find": "      /* Wider message bubbles on desktop — but cap at 55% to stay readable */\n      .msg-bubble {\n        max-width: min(55%, 680px);\n      }",
        "replace": "      /* Wider message bubbles on desktop */\n      .msg-bubble {\n        max-width: min(58%, 720px);\n      }"
    },

    # 4. .wallpaper-controls: allow wrapping
    {
        "find": "    .wallpaper-controls {\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      flex-wrap: nowrap;\n      min-height: 32px; /* prevent height jump when preview appears/disappears */\n    }",
        "replace": "    .wallpaper-controls {\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      flex-wrap: wrap;\n      min-height: 32px;\n    }"
    },

    # 5. Font size selector — add after animation style row in settings
    {
        "find": "        <!-- Message animation style -->\n        <div class=\"color-row\" style=\"margin-top:14px\">\n          <label>Message Animation</label>\n          <select id=\"settings-anim-style\" class=\"settings-select\" style=\"max-width:140px\">",
        "replace": "        <!-- Message font size -->\n        <div class=\"color-row\" style=\"margin-top:14px\">\n          <label>Message Font Size</label>\n          <select id=\"settings-font-size\" class=\"settings-select\" style=\"max-width:140px\">\n            <option value=\"12\">XS (12px)</option>\n            <option value=\"14\">Small (14px)</option>\n            <option value=\"16\">Medium (16px)</option>\n            <option value=\"18\">Large (18px)</option>\n            <option value=\"20\">XL (20px)</option>\n          </select>\n        </div>\n\n        <!-- Message animation style -->\n        <div class=\"color-row\" style=\"margin-top:14px\">\n          <label>Message Animation</label>\n          <select id=\"settings-anim-style\" class=\"settings-select\" style=\"max-width:140px\">"
    },

    # 6. Devices section — insert after storage divider and before data section
    {
        "find": "      <div class=\"settings-divider\"></div>\n\n      <!-- Data / Export -->",
        "replace": "      <div class=\"settings-divider\"></div>\n\n      <!-- Linked Devices -->\n      <div class=\"settings-section\">\n        <div class=\"settings-section-title\">Linked Devices</div>\n        <div id=\"devices-list\"><div class=\"storage-empty\">Loading…</div></div>\n        <div class=\"settings-hint\" style=\"margin-top:8px\">Remove a device to sign it out immediately.</div>\n      </div>\n\n      <div class=\"settings-divider\"></div>\n\n      <!-- Data / Export -->"
    },

    # 7. Change passphrase button — in Account section before sign out
    {
        "find": "        <button id=\"settings-signout-btn\" class=\"btn btn-danger btn-sm\">\n          Sign Out\n        </button>",
        "replace": "        <button id=\"settings-change-passphrase-btn\" class=\"btn btn-ghost btn-sm\" style=\"margin-bottom:10px\">\n          Change Passphrase\n        </button>\n        <button id=\"settings-signout-btn\" class=\"btn btn-danger btn-sm\">\n          Sign Out\n        </button>"
    },
]

if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("Usage: python index_patch.py path/to/index.html")
        sys.exit(1)
    path = sys.argv[1]
    with open(path) as f:
        src = f.read()
    for p in PATCHES:
        if p['find'] not in src:
            print(f"WARNING: patch not found: {p['find'][:60]!r}")
        else:
            src = src.replace(p['find'], p['replace'], 1)
            print(f"OK: {p['find'][:60]!r}")
    with open(path, 'w') as f:
        f.write(src)
    print("Done.")
