# Release, signing and notarisation

What this build produces, and exactly which credentials Ng has to supply before a build is
distributable to other people. Nothing here is a secret and nothing in this file should ever hold a
real key or password.

## What gets built

`pnpm --filter @terabot/desktop package:<target>` writes to `apps/desktop/release/` (git-ignored):

| platform | command | artifacts |
| --- | --- | --- |
| macOS | `package:mac` | `Terabot-<version>-arm64.dmg`, `Terabot-<version>-x64.dmg`, matching `.zip` |
| Windows | `package:win` | `Terabot-<version>-setup.exe` (NSIS, per-user, choose install dir) |
| Linux | `package:linux` | `Terabot-<version>-x86_64.AppImage`, `Terabot-<version>-amd64.deb`, arm64 equivalents |

The version comes from `apps/desktop/package.json`. Bump it before a release; `electron-updater`
compares that string.

The update feed is opt-in at build time:

```bash
TERABOT_UPDATE_FEED_URL=https://updates.terabot.ai/desktop pnpm --filter @terabot/desktop package:mac
```

With the variable set, `electron-builder` also writes the update metadata (`latest-mac.yml`,
`latest.yml`, `latest-linux.yml`) and `app-update.yml` inside the bundle; without it, plain
installers and no feed metadata. Upload the installers **and the `.yml` files** to that URL — a
plain static HTTPS host is enough (GitHub Releases works too if we switch `provider` in
`electron-builder.config.cjs`; the generic provider keeps staging and production feeds separate).
The feed must be reachable over HTTPS; `electron-updater` verifies the sha512 in the metadata but
the generic provider has no separate signature, so the host itself must be trusted.

With the variable set, the feed URL is also embedded in the bundle, so an installed build reads it
without anyone exporting the variable again; a runtime `TERABOT_UPDATE_FEED_URL` overrides the
embedded one (useful for a staging copy). `TERABOT_AUTO_UPDATE=1` at runtime makes a packaged build
check on launch and every six hours; the default is off, and *Help → Check for Updates…* always works
manually. macOS updates require a
signed app; Linux auto-update works for AppImage only (`.deb` users reinstall through their package
manager).

## macOS: signing and notarisation

Needed from Ng:

1. **Apple Developer Program membership** (paid, Ng's account) with access to *Certificates,
   Identifiers & Profiles*.
2. **Developer ID Application** certificate (not *Apple Development*, not *Mac App Store*).
   Export it from Keychain Access as a `.p12` with a password, or authenticate `notarytool` with an
   App Store Connect **API key** (`.p8`, key id, issuer id) or an **app-specific password**.
3. The **Team ID** (`Security & Privacy → Developer ID` or the developer portal).

Environment the build machine needs (CI secrets, never the repo):

| variable | value |
| --- | --- |
| `CSC_LINK` | base64 or path of the Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_TEAM_ID` | team id |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key path, key id, issuer id — **or** |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID and app-specific password |

Notarisation is `notarytool` against the notary service, with the hardened runtime on (already
configured in `electron-builder.config.cjs`) and `build/entitlements.mac.plist` (already provided:
JIT, unsigned executable memory, library validation off — what Electron's V8 needs and nothing
more). Turn it on with:

```jsonc
// electron-builder.config.cjs, mac
notarize: true
```

`electron-builder` picks the credentials up from the variables above. Verify before shipping:

```bash
spctl -a -vvv -t install release/mac-arm64/Terabot.app   # "accepted, source=Notarized Developer ID"
xcrun stapler validate release/mac-arm64/Terabot.app     # "The validate action worked!"
```

Then confirm the dmg too (`spctl -a -vvv -t open --context context:primary-signature <dmg>`), and
run the app once from a freshly downloaded copy: Gatekeeper evaluates the quarantine flag, not the
local unsigned state.

## Windows: signing

Needed from Ng: a **code signing certificate** (OV or EV; EV buys SmartScreen reputation sooner)
from a public CA, or an **Azure Trusted Signing** account (the cheapest way to sign with a
short-lived cert). Then one of:

| variable | value |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | the `.pfx` and its password |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | same, if signing both platforms from one machine |

or, for Azure Trusted Signing, `azureSignOptions` in the `win` block (`publisherName`, `endpoint`,
`codeSigningAccountName`, `certificateProfileName`) plus the `signtool`/Azure CLI credentials.
Verify with `signtool verify /pa /v "release/Terabot-<version>-setup.exe"`.

Unsigned Windows builds run, but SmartScreen shows "unrecognised app" until reputation
accumulates; the NSIS installer is per-user, so no admin prompt is required.

## Linux

No signing is required for AppImage or `.deb`. Set the package maintainer Ng wants in the `.deb`
control fields with `TERABOT_LINUX_MAINTAINER="Name <email>"` at build time (the default in
`electron-builder.config.cjs` is a placeholder on the reserved `.invalid` domain, deliberately not a
real address). A GPG-signed apt repository is only needed if we publish updates through apt.

## Checklist before a release

- [ ] `apps/desktop/package.json` version bumped
- [ ] `pnpm --filter @terabot/desktop typecheck && … lint && … test` green
- [ ] smoke run against the production URL (`xvfb-run … smoke --url https://app.terabot.ai`)
- [ ] certificates present in the build machine's environment (macOS and Windows)
- [ ] `TERABOT_UPDATE_FEED_URL` set for the intended channel
- [ ] notarised and stapled on macOS; signature verified on Windows
- [ ] installers **and** `latest*.yml` uploaded to the feed
- [ ] install from the published artifact on a clean machine and sign in once
