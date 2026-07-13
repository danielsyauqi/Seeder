"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ArrowRight,
  CircleNotch,
  GoogleLogo,
  LockKey,
  UserCircle,
} from "@phosphor-icons/react";

import { BrandLogo } from "@/components/app/brand-logo";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type SignInPanelProps = {
  hasGoogleAuth: boolean;
  ownerEmail: string;
  allowFirstOwner: boolean;
  invite?: { token: string; email: string } | null;
  systemName: string;
  logoDarkUrl: string | null;
  logoLightUrl: string | null;
  initialError?: string | null;
};

type Mode = "sign-in" | "create-account" | "accept-invite";

export function SignInPanel({
  hasGoogleAuth,
  ownerEmail,
  allowFirstOwner,
  invite,
  systemName,
  logoDarkUrl,
  logoLightUrl,
  initialError = null,
}: SignInPanelProps) {
  const router = useRouter();
  const [mode] = useState<Mode>(
    invite ? "accept-invite" : allowFirstOwner ? "create-account" : "sign-in",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState(
    invite?.email ?? (allowFirstOwner ? ownerEmail : ""),
  );
  const [password, setPassword] = useState("");
  // Seeded from a failed Google redirect (/sign-in?error=…) so social-login
  // failures surface in the same red box as email/password errors instead of
  // dead-ending on Better-Auth's default error page.
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError);
  const [isPending, startTransition] = useTransition();

  const submitLabel =
    mode === "sign-in"
      ? "Access workspace"
      : mode === "accept-invite"
        ? "Create account & sign in"
        : "Create owner account";

  const handleEmailFlow = async () => {
    setErrorMessage(null);

    if (mode === "sign-in") {
      const result = await authClient.signIn.email(
        {
          email,
          password,
          callbackURL: "/projects",
        },
        {
          onSuccess: () => {
            router.push("/projects");
            router.refresh();
          },
        },
      );

      if (result.error) {
        setErrorMessage(result.error.message ?? "Unable to sign in.");
      }

      return;
    }

    if (mode === "accept-invite" && invite) {
      const response = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: invite.token,
          name: name.trim() || invite.email.split("@")[0],
          password,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setErrorMessage(data.error ?? "Unable to accept invitation.");
        return;
      }

      const result = await authClient.signIn.email(
        {
          email: invite.email,
          password,
          callbackURL: "/projects",
        },
        {
          onSuccess: () => {
            router.push("/projects");
            router.refresh();
          },
        },
      );

      if (result.error) {
        setErrorMessage(
          result.error.message ?? "Account created but sign-in failed. Try signing in.",
        );
      }

      return;
    }

    const result = await authClient.signUp.email(
      {
        name: name.trim() || "Owner",
        email,
        password,
        callbackURL: "/projects",
      },
      {
        onSuccess: () => {
          router.push("/projects");
          router.refresh();
        },
      },
    );

    if (result.error) {
      setErrorMessage(result.error.message ?? "Unable to create the account.");
    }
  };

  const heading =
    mode === "sign-in"
      ? "Access your workspace"
      : mode === "accept-invite"
        ? "Accept your invitation"
        : "Create the owner account";

  const subheading =
    mode === "accept-invite" && invite ? (
      <>
        You were invited as{" "}
        <span className="font-medium text-foreground">{invite.email}</span>. Set a
        password to finish.
      </>
    ) : mode === "create-account" ? (
      <>
        First run — create the owner account for{" "}
        <span className="font-medium text-foreground">{ownerEmail}</span>.
      </>
    ) : (
      <>Sign in to your workspace.</>
    );

  const showNameField = mode === "create-account" || mode === "accept-invite";
  const emailReadOnly = mode === "accept-invite";

  return (
    <section className="surface-shadow w-full max-w-[1080px] overflow-hidden rounded-md border border-border bg-surface">
      <div className="grid min-h-130 grid-cols-1 lg:grid-cols-[1.02fr_0.98fr]">
        <div className="flex flex-col justify-center border-b border-border bg-background p-8 sm:p-10 lg:border-b-0 lg:border-r">
          <div className="space-y-5">
            <BrandLogo
              systemName={systemName}
              darkUrl={logoDarkUrl}
              lightUrl={logoLightUrl}
              imgClassName="h-9"
            />
            <div className="max-w-xl space-y-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                Project workspace
              </p>
              <h1 className="text-[2.5rem] font-medium tracking-[-0.022em] text-foreground sm:text-5xl">
                Run client work in one quiet system.
              </h1>
              <p className="max-w-lg text-sm leading-7 text-muted sm:text-[15px]">
                Requests, execution, notes, and public updates stay in one shared workspace with a board that is easy to trust.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center bg-surface p-6 sm:p-10">
          <div className="w-full max-w-md rounded-md border border-border bg-surface-strong p-6 sm:p-8">
            {/* A real form, so Enter submits from any field and password
                managers recognise the credential pair. */}
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (isPending) return;
                startTransition(handleEmailFlow);
              }}
            >
              <div>
                <h2 className="text-[1.5rem] font-medium tracking-[-0.022em] text-foreground">
                  {heading}
                </h2>
                <p className="mt-2 text-[13px] leading-6 text-muted">{subheading}</p>
              </div>

              <div className="space-y-3">
                {showNameField ? (
                  <label className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium text-foreground">Display name</span>
                    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2.5">
                      <UserCircle className="size-4 text-muted" />
                      <input
                        name="name"
                        autoComplete="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                        placeholder="Your name"
                      />
                    </div>
                  </label>
                ) : null}

                <label className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-foreground">Email</span>
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2.5",
                      emailReadOnly && "opacity-70",
                    )}
                  >
                    <ArrowRight className="size-4 -rotate-45 text-muted" />
                    <input
                      type="email"
                      name="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      readOnly={emailReadOnly}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                      placeholder="user@user.com"
                    />
                  </div>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-foreground">Password</span>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2.5">
                    <LockKey className="size-4 text-muted" />
                    <input
                      type="password"
                      name="password"
                      autoComplete={
                        mode === "sign-in" ? "current-password" : "new-password"
                      }
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                      placeholder="Minimum 8 characters"
                    />
                  </div>
                </label>
              </div>

              {errorMessage ? (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
                  {errorMessage}
                </div>
              ) : null}

              <div className="space-y-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className="ui-button-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
                  {submitLabel}
                </button>

                {hasGoogleAuth && mode === "sign-in" ? (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() =>
                      authClient.signIn.social({
                        provider: "google",
                        callbackURL: "/projects",
                        // Without this, a rejected Google login (un-invited
                        // account, unlinkable email) lands on Better-Auth's bare
                        // /api/auth/error page. Send failures back to the form
                        // so the panel can show the reason.
                        errorCallbackURL: "/sign-in",
                      })
                    }
                    className="ui-button-secondary w-full"
                  >
                    <GoogleLogo className="size-4" />
                    Continue with Google
                  </button>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
