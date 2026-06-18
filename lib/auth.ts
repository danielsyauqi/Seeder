import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";

import { authTrustedOrigins, serverEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { ensurePersonalSpace } from "@/lib/services/spaces";

const dbProxy = new Proxy(
  {},
  {
    get(_target, property, receiver) {
      const db = getDb() as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(db, property, receiver);

      return typeof value === "function" ? value.bind(db) : value;
    },
  },
);

const googleProvider = serverEnv.hasGoogleAuth
  ? {
      google: {
        clientId: serverEnv.googleClientId!,
        clientSecret: serverEnv.googleClientSecret!,
        // The app is invite-only (emailAndPassword.disableSignUp). That flag
        // does NOT govern social providers, so without this Google would let
        // any Google account self-provision a member. Restrict Google to
        // signing in to an already-existing (invited) account.
        disableImplicitSignUp: true,
      },
    }
  : undefined;

// Invited members get only a `credential` (password) account at invite time —
// there is no Google account row. When they later "Continue with Google",
// Better-Auth must link that Google identity onto their existing user by email.
// By default that auto-link is only allowed when the provider reports the email
// as verified (handleOAuthUserInfo). Google usually does, but some federated
// Google accounts return email_verified:false, which would surface as an
// "account_not_linked" error. Trusting Google here makes the link explicit and
// no longer dependent on that per-login flag. Only meaningful when Google is
// configured.
const accountLinking = serverEnv.hasGoogleAuth
  ? {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google" as const],
      },
    }
  : undefined;

export const auth = betterAuth({
  appName: "Seeder",
  baseURL: serverEnv.betterAuthUrl,
  secret: serverEnv.betterAuthSecret,
  trustedOrigins: authTrustedOrigins,
  database: drizzleAdapter(dbProxy, {
    provider: "sqlite",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // Sign-up is effectively closed (onboarding is invite-only) — the create
    // hook below is the real gate. We can't set disableSignUp:true because that
    // short-circuits the signup route before the hook runs, which would leave a
    // fresh self-host with no way to create its first owner.
    disableSignUp: false,
  },
  socialProviders: googleProvider,
  account: accountLinking,
  databaseHooks: {
    user: {
      create: {
        // First-run bootstrap gate. Onboarding is invite-only, with ONE
        // exception: a brand-new instance with zero users may create the owner
        // account, and only for the configured OWNER_EMAIL. Once any user
        // exists this throws, so it can never be used to self-provision later.
        // (Invite acceptance inserts users directly via Drizzle and never hits
        // this hook, so invited members are unaffected.)
        before: async (candidateUser) => {
          const email = candidateUser.email.toLowerCase();
          const db = getDb();
          const [existing] = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .limit(1);

          if (existing) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is disabled. Ask an admin to invite you.",
            });
          }
          if (email !== serverEnv.ownerEmail) {
            throw new APIError("FORBIDDEN", {
              message: `The first account must use the owner email (${serverEnv.ownerEmail}).`,
            });
          }

          return { data: { ...candidateUser, email } };
        },
        // The bootstrap user is the owner. `role` can't be set via the before
        // hook's return: Better-Auth's adapter strips any field not declared on
        // the user model, and `role` is not declared (no admin plugin / no
        // additionalFields), so it would silently fall back to the 'member'
        // column default. Set it directly with raw Drizzle (the same path
        // accept-invite uses). This only ever runs for the gated bootstrap
        // signup — invites insert directly (no hook) and Google has
        // disableImplicitSignUp, so no other create reaches here.
        after: async (createdUser) => {
          // Every user gets their one Personal space before they can do anything.
          await ensurePersonalSpace(createdUser.id);
          if (createdUser.email.toLowerCase() !== serverEnv.ownerEmail) return;
          const db = getDb();
          await db
            .update(schema.user)
            .set({ role: "owner" })
            .where(eq(schema.user.id, createdUser.id));
        },
      },
    },
  },
  advanced: {
    cookiePrefix: "seeder",
  },
  plugins: [nextCookies()],
});
