import { redirect } from "next/navigation";
import { loadShellData } from "../lib/data.ts";
import { currentWorkspace, getSessionUser } from "../lib/session.ts";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const workspace = await currentWorkspace(user);
  const data = await loadShellData({
    user,
    workspaceId: workspace.id,
    apiUrl: process.env.API_URL ?? "http://localhost:8787",
  });

  const target = data.activeBot;
  if (!target) redirect("/b/new");
  redirect(`/b/${target.id}`);
}
