import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "../../components/auth-form.tsx";
import { getSessionUser } from "../../lib/session.ts";

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-6">
      <div className="w-[380px] rounded-xl border border-hairline bg-raised/40 p-8">
        <h1 className="text-xl font-semibold text-ink">Sign in to PupBot</h1>
        <p className="mt-1 text-base text-ink-secondary">Bots with their own computers.</p>
        <AuthForm mode="sign-in" />
        <p className="mt-6 text-base text-ink-muted">
          New here?{" "}
          <Link className="text-ink underline underline-offset-2" href="/sign-up">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
