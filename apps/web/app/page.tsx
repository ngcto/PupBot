import { redirect } from "next/navigation";
import { loadShellData } from "../lib/data.ts";
import { currentWorkspace, getSessionUser } from "../lib/session.ts";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const workspace = await currentWorkspace(user);
  const data = await loadShellData({
    user,
    workspaceId: workspace.id,
    apiUrl: process.env.API_URL ?? "http://localhost:8787",
  });

  const target = data.activeBot;
  // Composio's callback sends the person back with ?apps=1, so the marketplace
  // reopens on the bot they were on instead of dropping them into the chat blind.
  const suffix = params.apps ? "?apps=1" : "";
  if (!target) redirect(`/b/new${suffix}`);
  redirect(`/b/${target.id}${suffix}`);
}
