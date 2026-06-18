import { PageHeader } from "@/components/app/page-header";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { TokenManager } from "@/components/settings/tokens/token-manager";
import { UserInfoForm } from "@/components/settings/user-info-form";
import { requireViewer } from "@/lib/auth-server";
import { getMyTokens } from "@/lib/data-tokens";

export const dynamic = "force-dynamic";

// The signed-in user's own account settings: profile (everything but email),
// password, and personal access tokens — all self-service, no admin rights
// needed. Reached from the gear on the sidebar user badge.
export default async function SettingsPage() {
  const viewer = await requireViewer();
  const tokens = await getMyTokens(viewer.id);

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Workspace · Settings"
        title="Account settings"
        description="Manage your profile, password, and personal access tokens."
      />

      <section className="ui-panel p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
            User information
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            Update how you appear across the workspace.
          </p>
        </div>
        <UserInfoForm name={viewer.name} email={viewer.email} image={viewer.image} />
      </section>

      <section className="ui-panel p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
            Password
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            Change your sign-in password. Other sessions can be revoked at the
            same time.
          </p>
        </div>
        <ChangePasswordForm />
      </section>

      <section className="ui-panel p-5 sm:p-6">
        <TokenManager tokens={tokens} embedded />
      </section>
    </div>
  );
}
