import { SystemSettingsForm } from "@/components/admin/system/system-settings-form";
import { PageHeader } from "@/components/app/page-header";
import { requireRole } from "@/lib/auth-server";
import { brandingUrl, getSystemSettings } from "@/lib/system-settings";

export const dynamic = "force-dynamic";

export default async function AdminSystemPage() {
  await requireRole(["owner", "admin"]);
  const settings = await getSystemSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · System"
        title="System configuration"
        description="Branding and appearance for the whole workspace — applied to every page, the sign-in screen, and shared client boards."
      />

      <SystemSettingsForm
        webTitle={settings.webTitle}
        systemName={settings.systemName}
        accentColor={settings.accentColor}
        logoDarkKey={settings.logoDarkKey}
        logoLightKey={settings.logoLightKey}
        faviconKey={settings.faviconKey}
        sidebarMarkKey={settings.sidebarMarkKey}
        logoDarkUrl={brandingUrl(settings.logoDarkKey, settings.updatedAt)}
        logoLightUrl={brandingUrl(settings.logoLightKey, settings.updatedAt)}
        faviconUrl={brandingUrl(settings.faviconKey, settings.updatedAt)}
        sidebarMarkUrl={brandingUrl(settings.sidebarMarkKey, settings.updatedAt)}
      />
    </div>
  );
}
