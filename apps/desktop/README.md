# Terabot desktop

The desktop app is the way people use Terabot: one Electron shell that loads the hosted product
from `apps/web`. The UI is not forked, copied or bundled into this app — the shell is the window,
the menu and the security boundary, and the product stays one renderer served from one URL. Point
the binary at `http://localhost:3000`, a staging deployment or production; nothing else changes.

```
apps/desktop
├── src/main/        Electron main process (window, session, menu, updater, deep links, state)
├── src/preload/     the entire renderer-facing API: getInfo() and onDeepLink()
├── src/shared/      config, URL/origin policy, permission policy, window state — pure, tested
├── scripts/         build (tsup), icon generation, end-to-end smoke
├── build/           icon.png and the macOS entitlements
├── test/            vitest units for every policy
└── docs/release.md  packaging, signing and notarisation steps
```

## Run it

The product has to be running first (`pnpm dev` at the repo root, or `pnpm --filter @web start`).

```bash
pnpm install
pnpm --filter @terabot/desktop start          # builds dist/ then launches Electron
```

There is no `dev` script on purpose: the root `pnpm dev` runs the web, api and worker apps, and the
shell should not join that (a desktop window is not a dev server). Rebuild and relaunch with
`start` after changing shell code; the product itself hot-reloads in `apps/web` as usual.

## Configuration

Everything is read from the environment at launch and validated once; a bad value shows an error
dialog and quits rather than opening a half-configured window.

| variable | default | meaning |
| --- | --- | --- |
| `TERABOT_APP_URL` | `http://localhost:3000` | Absolute http(s) URL of the hosted product this binary wraps |
| `TERABOT_ALLOWED_ORIGINS` | — | Extra origins the window may navigate to, comma separated. Only for a product that genuinely serves itself from a second origin |
| `TERABOT_PERMISSIONS` | — | Electron permissions granted **to the product origin**, comma separated (`notifications`, `media`, …). Empty denies all |
| `TERABOT_AUTO_UPDATE` | off | `1`/`true` makes a packaged build check the feed on launch and every 6 h |
| `TERABOT_UPDATE_FEED_URL` | — | `electron-updater` generic feed, e.g. `https://updates.terabot.ai/desktop`. At launch it overrides the feed a release build embedded |
| `TERABOT_REGISTER_PROTOCOL` | off in dev | Register `terabot://` with the OS while developing. Always on in a packaged build |

Examples:

```bash
TERABOT_APP_URL=https://staging.terabot.ai pnpm --filter @terabot/desktop start
TERABOT_APP_URL=https://app.terabot.ai TERABOT_PERMISSIONS=notifications pnpm --filter @terabot/desktop start
```

## Security defaults

The renderer is the product, and the product gets no more than a web page would.

- `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
  `sandbox: true`, `webviewTag: false`, `webSecurity: true`. The page never sees `require`,
  `process` or `ipcRenderer`; the smoke test asserts that.
- The preload exposes exactly one object, `window.terabotDesktop`, with `platform`, `getInfo()` and
  `onDeepLink()`. `getInfo()` returns `null` to any frame that is not on the product origin.
- **Navigation** is limited to the product origin. Any other `http(s)` link — a docs page, a
  provider's OAuth page, a link a bot wrote into a message — is opened by the system browser.
  `mailto:` and `tel:` go to the system handler. `file:`, `data:`, `blob:`, `javascript:` and every
  other scheme are blocked. `window.open` to the product origin becomes a child window with the
  same hardened preferences; anything else is denied.
- **Permissions** are denied unless the request comes from the product origin *and* the permission
  is named in `TERABOT_PERMISSIONS`. Screen capture is always refused in v1.
- Policy handlers are attached to every `webContents` the app creates, so a popup cannot escape
  the rules either.

## Session and sign-in

The product's cookie session lives in one persistent session partition, `persist:terabot`, shared
by every window. Electron writes it under `<userData>/Partitions/terabot` (`~/.config/Terabot` on
Linux, `~/Library/Application Support/Terabot` on macOS, `%APPDATA%\Terabot` on Windows), so
signing in survives restarts and there is exactly one session per install.

Signing in inside the shell works with no extra plumbing: the form posts to the product, the
product sets its cookie, the cookie is in the partition. That is the normal path.

**When sign-in has to happen in the system browser** — an SSO tenant that blocks embedded
browsers, a provider that only accepts `https://` redirect URIs — the last hop comes back through a
`terabot://` deep link. The shell validates it and rewrites it onto the product origin:

| deep link | loaded in the shell |
| --- | --- |
| `terabot://api/auth/callback/github?code=…&state=…` | `${TERABOT_APP_URL}/api/auth/callback/github?code=…&state=…` |
| `terabot://auth/callback?token=…` | `${TERABOT_APP_URL}/auth/callback?token=…` |
| `terabot://b/bot_123` | `${TERABOT_APP_URL}/b/bot_123` |

The first row is the one that works today with no product change: that path is better-auth's
callback route in `apps/web`, and because it is loaded inside the shell, the session cookie it sets
lands in the shell's partition, not in Safari or Chrome.

Rules the resolver enforces (`src/shared/deeplink.ts`, fully unit tested):

- only `terabot:`, only `terabot://<segment>/…` — no opaque `terabot:auth/…`, no credentials, no
  port, no dotted host. The first segment is a **path** segment, so a link can never move the
  window off the product origin.
- the result is re-created against `TERABOT_APP_URL` and re-checked for the expected origin;
  query strings and fragments are kept, `..` cannot escape.
- links are only handled while the app is running or starting: macOS `open-url`, Windows/Linux
  `argv` on launch, and `second-instance` when the app is already open (which also focuses the
  existing window instead of launching a second shell).

Once the mapped page has loaded, the shell also hands it the resolved product URL through
`onDeepLink` (returns an unsubscribe function), so a product that renders its own callback screen can
react in-page instead of relying on the route alone.

```js
const off = window.terabotDesktop?.onDeepLink((url) => {
  window.location.assign(url);
});
```

**What Ng still has to configure on the product side:** the OAuth provider's redirect URI list must
accept the callback the browser will land on, and better-auth's `trustedOrigins`/callback URLs must
include the app origin the shell uses. Nothing in `apps/web` needs changing for the in-shell flow;
both of these are deployment configuration.

## Desktop manners

- **Single instance.** A second launch focuses the window that already exists (and forwards any
  `terabot://` link it was launched with). `requestSingleInstanceLock` runs before any window is
  created.
- **Window state** is remembered in `<userData>/window-state.json`: size, position, maximised and
  full-screen, written on a debounce and on close. On restore, a position that no longer overlaps a
  display by at least 96 px is dropped, so a window never comes back off-screen after a monitor
  change.
- **Unreachable product.** If the product cannot load (stale dev server, no network), the window
  shows a small built-in page naming the URL, the error and a *Try again* link, instead of a blank
  white window.
- **Native menu** with system roles (`File`, `Edit`, `View`, `Window`, `Help`, plus the macOS app
  menu). Shortcuts come from those roles, not from the page:

| shortcut | action |
| --- | --- |
| `⌘C` / `Ctrl+C`, `⌘V`, `⌘X`, `⌘A`, `⌘Z`, `⇧⌘Z` | clipboard and undo, standard roles |
| `⌘R` / `Ctrl+R`, `⇧⌘R` | reload / force reload the product |
| `⌘+`, `⌘-`, `⌘0` | zoom in / out / actual size |
| `⌃⌘F` / `F11` | toggle full screen |
| `⌘W` / `Ctrl+W`, `⌘Q` | close window, quit |
| `⌘M` | minimise |
| `⇧⌘O` | open the current product URL in the system browser |
| `⌥⌘I` / `Ctrl+Shift+I` | devtools — development builds only |

- **About / version.** macOS app menu → *About Terabot* (and *Help → About Terabot* elsewhere)
  shows the app version, Electron version and the product URL it is wrapping. The product can read
  the same facts from `getInfo()` if it wants them in a settings screen.
- **Icon** is `build/icon.png`, generated by `pnpm --filter @terabot/desktop icon` — the product's
  own motif (one soft rounded silhouette with two eyes) so the dock icon matches the bots.

## Packaging and updates

```bash
pnpm --filter @terabot/desktop package:mac     # dmg + zip, arm64 and x64
pnpm --filter @terabot/desktop package:win     # nsis installer, x64 and arm64
pnpm --filter @terabot/desktop package:linux   # AppImage + deb, x64 and arm64
```

Artifacts land in `apps/desktop/release/` (git-ignored). Set `TERABOT_UPDATE_FEED_URL` on the build
to also emit the update metadata (`latest*.yml`) and embed the feed in the bundle
(`app-update.yml`); with no feed the build produces plain installers and no release metadata. An
installed build uses the feed it was built with, and a runtime `TERABOT_UPDATE_FEED_URL` overrides it
for a copy pointed at staging. `TERABOT_AUTO_UPDATE` turns automatic checks on at runtime; the Help
menu can always check manually. Nothing downloads or installs without a packaged build.

Signing, notarisation and what Ng must supply are in [docs/release.md](docs/release.md).

## Verify

```bash
pnpm --filter @terabot/desktop typecheck   # tsc --noEmit
pnpm --filter @terabot/desktop lint        # eslint
pnpm --filter @terabot/desktop test        # vitest: config, URL/origin policy, deep links, permissions, window state
```

End-to-end, against a running product, on a headless Linux machine:

```bash
pnpm --filter @terabot/desktop build
xvfb-run -a pnpm --filter @terabot/desktop smoke -- \
  --url http://localhost:3000 \
  --sign-in demo@pupbot.dev:pupbot-demo \
  --deep-link 'terabot://sign-in?from=smoke' \
  --second-instance 'terabot://sign-in?from=second' \
  --restart \
  --out /tmp/terabot-shell.png
```

The smoke run launches the real `dist/main.js`, then asserts: one window; the page is on the
product origin and rendered; `require`/`process`/`ipcRenderer` are absent from the page; the
preload bridge answers with the shell version and product URL; a foreign popup and a foreign
navigation are refused; a same-origin popup is allowed; the session signs in and reaches the app
shell; and, with `--restart`, that the session survives quitting and relaunching the shell on the
same profile. `--deep-link <terabot://…>` adds the cold-start deep link, `--second-instance
<terabot://…>` the single-instance forwarding and in-page `onDeepLink` delivery. It writes a
screenshot and prints a JSON report of every check.

## What is not verified here

macOS and Windows installers (dmg, nsis), signing, notarisation and a real `electron-updater`
round-trip need a macOS and a Windows machine with Ng's certificates; see `docs/release.md`. The
Linux AppImage/deb build is produced on Linux but not launched from the installed package.
