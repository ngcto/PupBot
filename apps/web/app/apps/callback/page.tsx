import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Where Composio sends the browser after the user finishes on its hosted page.
 * The connection is already recorded and polled, so this only puts the person back
 * in the app with the marketplace open; nothing here trusts a query parameter.
 */
export default async function AppsCallback() {
  redirect("/?apps=1");
}
