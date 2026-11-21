import type { SessionUser } from "@pupbot/api-client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, onUnauthorized } from "./api.ts";

type Status = "loading" | "signed-in" | "signed-out";

interface SessionValue {
  status: Status;
  user: SessionUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    let active = true;

    const restore = async () => {
      if (!(await api.hasSession())) {
        if (active) setStatus("signed-out");
        return;
      }
      try {
        const me = await api.me();
        if (!active) return;
        setUser(me.user);
        setStatus("signed-in");
      } catch {
        if (!active) return;
        setUser(null);
        setStatus("signed-out");
      }
    };

    void restore();
    const unsubscribe = onUnauthorized(() => {
      setUser(null);
      setStatus("signed-out");
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      async signIn(email, password) {
        const signedIn = await api.signIn({ email: email.trim(), password });
        setUser(signedIn);
        setStatus("signed-in");
      },
      async signOut() {
        // The cookie is gone from the keychain even if the request fails, so a
        // network error must not leave the app looking signed in.
        await api.signOut().catch(() => {});
        setUser(null);
        setStatus("signed-out");
      },
      async refresh() {
        const me = await api.me();
        setUser(me.user);
      },
    }),
    [status, user],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
