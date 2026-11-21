import { auth, ensureWorkspace, findWorkspace } from "@terabot/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

export async function currentWorkspace(user: SessionUser) {
  return (await findWorkspace(user.id)) ?? (await ensureWorkspace(user.id, user.name));
}
