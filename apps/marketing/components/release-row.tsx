import {
  AndroidIcon,
  AppleIcon,
  AppStoreIcon,
  ComputerTerminal01Icon,
  WindowsNewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { releaseAction, type PlatformId, type Release } from "../releases.ts";

const icons: Record<PlatformId, typeof AppleIcon> = {
  macos: AppleIcon,
  windows: WindowsNewIcon,
  linux: ComputerTerminal01Icon,
  ios: AppStoreIcon,
  android: AndroidIcon,
};

/**
 * One build. A release with no URL renders a button that says "Coming soon"
 * and is not a link, so nothing on the page can 404.
 */
export function ReleaseRow({ release, action = "Download" }: { release: Release; action?: string }) {
  const state = releaseAction(release);

  return (
    <div className="build">
      <span className="build-icon">
        <HugeiconsIcon icon={icons[release.id]} size={20} />
      </span>
      <div className="build-body">
        <p className="build-name">{release.name}</p>
        <p className="small">{release.note ?? (state.state === "available" ? "Ready to install" : "Not published yet")}</p>
      </div>
      {state.state === "available" ? (
        <a className="btn btn-quiet btn-sm" href={state.href} rel="noreferrer">
          {action}
        </a>
      ) : (
        <span className="btn btn-pending btn-sm" aria-disabled="true">
          Coming soon
        </span>
      )}
    </div>
  );
}
