/**
 * electron-builder configuration. The update feed is read from the environment
 * so the same source builds a staging binary and a production one, and a build
 * with no feed never emits release metadata by accident.
 *
 *   TERABOT_UPDATE_FEED_URL=https://updates.example/desktop pnpm package:mac
 */
const feed = process.env.TERABOT_UPDATE_FEED_URL?.trim();

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "ai.terabot.desktop",
  productName: "Terabot",
  copyright: "Terabot",
  asar: true,
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  // The workspace name is scoped (`@terabot/desktop`), which is not a legal
  // package name for the .deb; the installed app's identity comes from appId and
  // productName, so only the metadata name is overridden.
  extraMetadata: { name: "terabot" },
  protocols: [{ name: "Terabot", schemes: ["terabot"] }],

  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.png",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
  },

  win: {
    icon: "build/icon.png",
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },

  linux: {
    icon: "build/icon.png",
    category: "Network",
    executableName: "terabot",
    syncDesktopName: true,
    synopsis: "Terabot desktop",
    maintainer: process.env.TERABOT_LINUX_MAINTAINER?.trim() || "Terabot <maintainers@terabot.invalid>",
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
    ],
  },

  ...(feed ? { publish: [{ provider: "generic", url: feed }] } : {}),
};
