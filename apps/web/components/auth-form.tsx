"use client";

import { Button, Input } from "@terabot/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0] || "You" });

    if (result.error) {
      setError(result.error.message ?? "That did not work. Try again.");
      setPending(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form className="mt-6 flex flex-col gap-3" onSubmit={submit}>
      {mode === "sign-up" ? (
        <Input
          aria-label="Name"
          placeholder="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
        />
      ) : null}
      <Input
        aria-label="Email"
        type="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
      />
      <Input
        aria-label="Password"
        type="password"
        required
        minLength={8}
        placeholder="Password (8+ characters)"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
      />
      {error ? <p className="text-base text-danger">{error}</p> : null}
      <Button type="submit" variant="primary" className="mt-2 h-10 w-full" disabled={pending}>
        {pending ? "One moment…" : mode === "sign-in" ? "Sign in" : "Create account"}
      </Button>
    </form>
  );
}
