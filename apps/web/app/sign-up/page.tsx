import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "../../components/auth-form.tsx";
import { getSessionUser } from "../../lib/session.ts";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-6">
      <div className="w-[380px] rounded-xl border border-hairline bg-raised/40 p-8">
        <h1 className="text-xl font-semibold text-ink">Create your account</h1>
        <p className="mt-1 text-base text-ink-secondary">One workspace, as many bots as you like.</p>
        <AuthForm mode="sign-up" />
        <p className="mt-6 text-base text-ink-muted">
          Already have an account?{" "}
          <Link className="text-ink underline underline-offset-2" href="/sign-in">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
