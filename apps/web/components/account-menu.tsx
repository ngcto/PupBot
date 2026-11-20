"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Settings01Icon, UserAdd01Icon, Logout01Icon } from "@hugeicons/core-free-icons";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "@pupbot/ui";
import { useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { authClient } from "../lib/auth-client.ts";

export function AccountMenu({
  user,
  children,
  onOpenSettings,
}: {
  user: { name: string; email: string };
  children: ReactElement<Record<string, unknown>>;
  onOpenSettings: () => void;
}) {
  const router = useRouter();

  return (
    <MenuRoot>
      <MenuTrigger>{children}</MenuTrigger>
      <MenuPopup side="top" align="start" className="w-[248px]">
        <div className="px-3 py-2">
          <p className="text-body font-semibold text-ink">{user.name}</p>
          <p className="truncate text-sm text-ink-muted">{user.email}</p>
          <p className="mt-2 text-sm text-ink-muted">Free plan · 0% used</p>
        </div>
        <MenuSeparator />
        <MenuItem onClick={onOpenSettings}>
          <HugeiconsIcon icon={Settings01Icon} size={16} strokeWidth={1.7} />
          Settings
        </MenuItem>
        <MenuItem onClick={onOpenSettings}>
          <HugeiconsIcon icon={UserAdd01Icon} size={16} strokeWidth={1.7} />
          Add account
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={async () => {
            await authClient.signOut();
            router.push("/sign-in");
            router.refresh();
          }}
        >
          <HugeiconsIcon icon={Logout01Icon} size={16} strokeWidth={1.7} />
          Log out
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}
