import { notFound } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { loadShellData } from "../../../lib/data.ts";
import { currentWorkspace, requireUser } from "../../../lib/session.ts";

export const dynamic = "force-dynamic";

export default async function BotPage({ params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const user = await requireUser();
  const workspace = await currentWorkspace(user);

  const data = await loadShellData({
    user,
    workspaceId: workspace.id,
    apiUrl: process.env.API_URL ?? "http://localhost:8787",
    activeBotId: botId === "new" ? undefined : botId,
  });

  if (botId !== "new" && !data.bots.some((bot) => bot.id === botId)) notFound();

  return <AppShell data={data} />;
}
