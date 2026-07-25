# Picot i18n Handbook (EN / 中文)

Operational guide for the bilingual UI work on branch `feature/i18n-bilingual`.

## Status (2026-07-25)

| Packet | Scope | Commit | Product estimate |
|--------|--------|--------|------------------|
| 1–2 | Boot + Appearance toggle + chrome status + Usage infobar | `4c8c8e4` | ~60–70% |
| 3 | Settings / chat residual | `ded2742` | ~75–85% |
| 4 | packages / sidebar / onboarding / dialogs / Super Agent | `e8007a7` (+ test pin `ead326c`) | **~90–95%** |

- Dictionary parity: **382 / 382** (`node scripts/check-i18n-parity.mjs` → `equal: true`)
- Storage key: `pi-studio-locale` (`en` | `zh`)
- Install tree: surgically synced for Packet 4 (see below)

### Key prefixes (Packet 4)

| Prefix | Count | Notes |
|--------|------:|-------|
| chrome | 99 | Header, connection, overlays |
| settings | 105 | Settings panel + Appearance |
| chat | 46 | Chat chrome / labels |
| usage | 41 | Cost infobar / dashboard |
| superAgent | 35 | Entry, header, runtime task board |
| sidebar | 25 | Session list, archive, time labels |
| common | 20 | cancel / retry / yes / no / delete… |
| packages | 5 | Install/uninstall failure UI |
| dialogs | 4 | Default dialog titles |
| onboarding | 2 | Project / model gates |

## Architecture

```
public/i18n/index.js   → getLocale, setLocale, t, applyI18n, onLocaleChange
public/i18n/en.js      → English dictionary
public/i18n/zh.js      → 简体中文 (must stay key-parity with en.js)
public/index.html      → static chrome via data-i18n / data-i18n-placeholder / data-i18n-title
public/app.js          → boot: setupLocaleToggle + refreshLocalizedUi + onLocaleChange
```

### Patterns

1. **Static HTML** — mark nodes with `data-i18n="key"` (text), `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`. `applyI18n()` rewrites on load and locale change.
2. **Dynamic JS** — call `t("key")` or `t("key", { param })` at **render time** (not module load).
3. **Locale switch** — `setLocale('zh'|'en')` persists and notifies listeners. Chrome uses `refreshLocalizedUi`; Web Components that own their shell should `onLocaleChange(() => re-render)`.
4. **Reuse first** — prefer existing `common.*`, `chrome.*`, `chat.*` before adding keys.

### Interpolation

`t("superAgent.approveCount", { count: 3 })` replaces `{count}` in the dictionary string.

## How to add a string

1. Add the same key to **both** `public/i18n/en.js` and `public/i18n/zh.js` (natural 简体中文).
2. Wire UI: `data-i18n` or `t("…")` at render time.
3. Run `node scripts/check-i18n-parity.mjs`.
4. If a test asserted English literals, assert `t("key")` instead (default locale remains English).
5. Prefer vitest (`npx vitest run …`). Tests that touch `document` need `// @vitest-environment jsdom` or the project jsdom config.

## Install-tree deploy (Windows release)

Installed Picot serves static files from:

`C:\Users\Administrator\AppData\Local\Picot\public`

Source edits under `src/picot/public` do **not** auto-apply.

### Rules

- **Never** blindly overwrite install `app.js` without checking ES module imports resolve in the install tree (historical break: missing `./super-agent/dispatch.js` → sidebar stuck on Loading sessions…).
- Prefer **surgical copy** of changed files only.
- Always take a timestamped backup under `public/_backup_*`.
- After sync: verify imports, then **fully restart** Picot (not only reload WebView).

### Packet 4 sync (done 2026-07-25)

Backup: `public/_backup_packet4_20260725_122440`

Copied from source:

- `app.js`
- `i18n/{index,en,zh}.js`
- `components/{sa-chat-header,super-agent-entry,super-agent-runtime}.js`
- `packages/install-status.js`
- `session/onboarding.js`
- `sidebar/index.js`
- `ui/dialogs.js`

Post-checks: `ALL_IMPORTS_OK`, install dict 382/382, runtime imports i18n.

Rollback:

```powershell
$src = "$env:LOCALAPPDATA\Picot\public\_backup_packet4_20260725_122440"
$dst = "$env:LOCALAPPDATA\Picot\public"
Copy-Item -Recurse -Force "$src\*" $dst
```

(Also keep `_backup_packet123_20260725_114217` for earlier baseline.)

## Verification checklist

```bash
# From src/picot
node scripts/check-i18n-parity.mjs
npx vitest run public/packages/install-status.test.js \
  public/sidebar/onboarding.test.js public/sidebar/pagination.test.js \
  public/session/onboarding.test.js \
  public/components/sa-chat-header.test.js \
  public/components/super-agent-entry.test.js \
  public/components/super-agent-runtime.test.js
```

Manual UI:

1. Settings → Appearance → language English / 中文.
2. Confirm header connection text, Usage infobar, sidebar empty/archive labels, Super Agent task board filters/actions.
3. Toggle language without full reload where `onLocaleChange` is wired; otherwise re-open panel / re-render path.

## Known limitations / residual

- Packages **browse** UI beyond install/uninstall failure status may still have English labels.
- Super Agent `routingReason` strings written into task state remain English (telemetry-ish, not primary chrome).
- Some mid-session surfaces may need a re-render or navigation after locale change if they cache DOM without `onLocaleChange`.
- `package.json` / `bun.lock` workspace noise is unrelated — do not mix into i18n commits.
- `public/index.html.upstream.bak` is local junk; do not commit.

## History (commits on feature/i18n-bilingual)

1. `4c8c8e4` — chrome + usage (Packet 1–2)
2. `ded2742` — settings / chat residual (Packet 3)
3. `e8007a7` — packages / sidebar / Super Agent (Packet 4)
4. `ead326c` — jsdom pin for install-status tests

## Do not redo

- i18n scaffold (`public/i18n/*`)
- Appearance `#locale-toggle` boot path
- Usage infobar icon-keying by English title (use stable keys)
- Wholesale install `app.js` replace without import audit
