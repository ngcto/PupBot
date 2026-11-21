import { auth, ensureWorkspace, findWorkspace, roleOf } from "@terabot/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;
  // Read from the row, not from the session payload: the role decides whether a
  // payment is required, so it must come from the same place the gate reads.
  const role = (await roleOf(session.user.id)) ?? "member";
  return { id: session.user.id, name: session.user.name, email: session.user.email, role };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

export async function currentWorkspace(user: SessionUser) {
  return (await findWorkspace(user.id)) ?? (await ensureWorkspace(user.id, user.name));
}
