"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Bell,
  Buildings,
  CalendarCheck,
  CalendarDots,
  ChartBar,
  Folders,
  GearSix,
  Kanban,
  List,
  PaperPlaneTilt,
  Plant,
  Power,
  Pulse,
  SidebarSimple,
  UsersThree,
  X,
} from "@phosphor-icons/react";

import { BrandLogo } from "@/components/app/brand-logo";
import { CommandBar } from "@/components/app/command-bar";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Avatar } from "@/components/ui/avatar";
import { SignOutButton } from "@/components/auth/sign-out-button";
import {
  clearAllNotificationsAction,
  markNotificationReadAction,
} from "@/lib/actions";
import type {
  InAppNotificationItem,
  ProjectListItem,
} from "@/lib/data";
import type { UserRole } from "@/lib/db/schema";
import { formatProjectStatus } from "@/lib/project-status";
import { cn, formatDate } from "@/lib/utils";

type AppSidebarProps = {
  notificationCount: number;
  projects: ProjectListItem[];
  userName: string;
  userEmail: string;
  userRole: UserRole;
  userImage: string | null;
  systemName: string;
  logoDarkUrl: string | null;
  logoLightUrl: string | null;
  sidebarMarkUrl: string | null;
};

const SIDEBAR_RENDER_VERSION = "2026-05-04.3";
const SIDEBAR_PROJECT_CAP = 8;

export function AppSidebar({
  notificationCount,
  projects,
  userName,
  userEmail,
  userRole,
  userImage,
  systemName,
  logoDarkUrl,
  logoLightUrl,
  sidebarMarkUrl,
}: AppSidebarProps) {
  const isAdminTier = userRole === "owner" || userRole === "admin";
  const pathname = usePathname();
  const isAdminMode = pathname.startsWith("/admin");
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop icon-rail collapse. The attribute on <html> (set pre-paint by the
  // boot script) is the source of truth; this state just mirrors it for the
  // toggle's icon/aria. CSS drives the actual rail styling.
  const [collapsed, setCollapsed] = useState(false);
  const [liveNotificationCount, setLiveNotificationCount] =
    useState(notificationCount);
  const [notifications, setNotifications] = useState<InAppNotificationItem[] | null>(
    null,
  );
  const [isNotificationsLoading, setIsNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);

  useEffect(() => {
    setLiveNotificationCount(notificationCount);
  }, [notificationCount]);

  useEffect(() => {
    setIsNotificationsOpen(false);
    setMobileOpen(false);
    setNotifications(null);
    setNotificationsError(null);
  }, [pathname]);

  // Sync the collapse mirror from the DOM attribute the boot script set.
  useEffect(() => {
    setCollapsed(
      document.documentElement.getAttribute("data-sidebar-collapsed") === "true",
    );
  }, []);

  const toggleCollapsed = () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-sidebar-collapsed") !== "true";
    if (next) {
      root.setAttribute("data-sidebar-collapsed", "true");
    } else {
      root.removeAttribute("data-sidebar-collapsed");
    }
    try {
      localStorage.setItem("seeder-sidebar-collapsed", String(next));
    } catch {}
    setCollapsed(next);
  };

  useEffect(() => {
    let isMounted = true;

    fetch("/api/notifications", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as Array<
          Omit<InAppNotificationItem, "createdAt" | "readAt"> & {
            createdAt: string;
            readAt: string | null;
          }
        >;
        if (!isMounted) return;
        const hydrated = data.map((notification) => ({
          ...notification,
          createdAt: new Date(notification.createdAt),
          readAt: notification.readAt ? new Date(notification.readAt) : null,
        }));
        setNotifications(hydrated);
        setLiveNotificationCount(
          hydrated.filter((notification) => !notification.readAt).length,
        );
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (!isNotificationsOpen || notifications !== null || isNotificationsLoading) {
      return;
    }

    let isMounted = true;
    setIsNotificationsLoading(true);
    setNotificationsError(null);

    fetch("/api/notifications", {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Notifications request failed.");
        }

        const nextNotifications = (await response.json()) as Array<
          Omit<InAppNotificationItem, "createdAt" | "readAt"> & {
            createdAt: string;
            readAt: string | null;
          }
        >;

        if (!isMounted) {
          return;
        }

        const hydratedNotifications = nextNotifications.map((notification) => ({
          ...notification,
          createdAt: new Date(notification.createdAt),
          readAt: notification.readAt ? new Date(notification.readAt) : null,
        }));

        setNotifications(hydratedNotifications);
        setLiveNotificationCount(
          hydratedNotifications.filter((notification) => !notification.readAt)
            .length,
        );
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        setNotificationsError("Notifications are temporarily unavailable.");
      })
      .finally(() => {
        if (isMounted) {
          setIsNotificationsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isNotificationsOpen, notifications]);

  const toneClassNames = {
    danger: "border-danger/30 bg-danger/10 text-danger",
    warning: "border-accent/30 bg-accent-soft text-accent",
    default: "border-border bg-surface text-muted",
  } as const;
  const hasNotifications = liveNotificationCount > 0;
  const openNotifications = () => {
    setNotifications(null);
    setNotificationsError(null);
    setIsNotificationsOpen(true);
  };
  const hasAnyNotifications = (notifications?.length ?? 0) > 0;
  const clearAllNotifications = () => {
    // Optimistic: empty the list and zero the badge immediately. The server
    // deletes stored rows and sets a "cleared at" watermark that hides every
    // currently-shown (live-computed) notification too.
    setNotifications([]);
    setLiveNotificationCount(0);
    void clearAllNotificationsAction();
  };

  return (
    <>
      {/* Mobile top bar — hamburger opens the drawer; hidden at md+. */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
        >
          <List className="size-5" />
        </button>
        <BrandLogo
          systemName={systemName}
          darkUrl={logoDarkUrl}
          lightUrl={logoLightUrl}
          imgClassName="h-7"
        />
        <button
          type="button"
          onClick={openNotifications}
          className="relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
        >
          <Bell className="size-5" />
          {hasNotifications ? (
            <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-5 animate-pulse-soft items-center justify-center rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-on">
              {liveNotificationCount > 9 ? "9+" : liveNotificationCount}
            </span>
          ) : null}
          <span className="sr-only">Open notifications</span>
        </button>
      </header>

      {/* Drawer backdrop (mobile only). */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-[rgba(10,10,10,0.44)] backdrop-blur-xs md:hidden"
        />
      ) : null}

      <aside
        data-sidebar-version={SIDEBAR_RENDER_VERSION}
        className={cn(
          "app-sidebar fixed inset-y-0 left-0 z-50 flex w-[min(86vw,320px)] -translate-x-full flex-col overflow-y-auto border-r border-border bg-background p-3 transition-transform duration-200 md:static md:z-auto md:h-dvh md:w-65 md:translate-x-0 md:shrink-0 md:overflow-hidden md:border-b-0",
          mobileOpen && "translate-x-0",
        )}
      >
        <div className="shrink-0 space-y-3">
          <div className="sidebar-rail-center flex items-center justify-between gap-2">
            {/* Square 1:1 brand mark — CSS reveals this only in the collapsed
                rail. A custom uploaded icon replaces the bundled mark (which
                uses the brand accent via currentColor). */}
            {sidebarMarkUrl ? (
              <span className="sidebar-rail-mark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sidebarMarkUrl}
                  alt=""
                  className="size-7 object-contain"
                  onError={(event) => {
                    event.currentTarget.src = "/seeder-mark.svg";
                  }}
                />
              </span>
            ) : (
            <span className="sidebar-rail-mark text-accent" aria-hidden="true">
              <svg viewBox="0 0 64 64" fill="none" className="size-7">
                <path
                  d="M16 8h22l14 14v30a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path
                  d="M38 8v8a6 6 0 0 0 6 6h8"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path
                  d="M32 52V36"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
                <path
                  d="M32 40 C 24 40, 18 36, 16 28 C 24 30, 30 34, 32 40 Z"
                  fill="currentColor"
                />
                <path
                  d="M32 36 C 40 36, 46 32, 48 24 C 40 26, 34 30, 32 36 Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            )}
            <BrandLogo
              systemName={systemName}
              darkUrl={logoDarkUrl}
              lightUrl={logoLightUrl}
              wrapperClassName="sidebar-collapsible"
              imgClassName="h-8"
            />
            <div className="sidebar-rail-stack flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground md:hidden"
              >
                <X className="size-5" />
              </button>
              <button
                type="button"
                onClick={openNotifications}
                className="relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
              >
                <Bell className="size-5" />
                {hasNotifications ? (
                  <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-5 animate-pulse-soft items-center justify-center rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-on">
                    {liveNotificationCount > 9 ? "9+" : liveNotificationCount}
                  </span>
                ) : null}
                <span className="sr-only">Open notifications</span>
              </button>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="hidden size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground md:inline-flex"
              >
                <SidebarSimple className="size-5" />
              </button>
            </div>
          </div>
          <div className="sidebar-collapsible">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
              {isAdminMode ? "Admin" : "Personal workspace"}
            </p>
            <h1 className="mt-2 text-[20px] font-medium tracking-[-0.022em] text-foreground">
              {isAdminMode ? "Manage the team." : "Build, review, ship."}
            </h1>
            <p className="mt-1 max-w-[220px] text-[13px] leading-6 text-muted">
              {isAdminMode
                ? "Invitations, members, and audit logs in one place."
                : "Clear queues, no dashboard noise."}
            </p>
          </div>
        </div>

        {isAdminTier ? (
          <div className="sidebar-collapsible mt-6 shrink-0">
            <div className="flex rounded-md border border-border bg-background p-1">
              <Link
                href="/dashboard"
                className={cn(
                  "flex-1 rounded-sm px-3 py-1.5 text-center text-[12px] font-medium transition",
                  isAdminMode
                    ? "text-muted hover:text-foreground"
                    : "bg-accent text-white",
                )}
              >
                Workspace
              </Link>
              <Link
                href="/admin/dashboard"
                className={cn(
                  "flex-1 rounded-sm px-3 py-1.5 text-center text-[12px] font-medium transition",
                  isAdminMode
                    ? "bg-accent text-white"
                    : "text-muted hover:text-foreground",
                )}
              >
                Admin
              </Link>
            </div>
          </div>
        ) : null}

        <div className={cn("sidebar-collapsible shrink-0", isAdminTier ? "mt-3" : "mt-6")}>
          <CommandBar />
        </div>

        <nav className="mt-4 flex shrink-0 flex-col gap-0.5">
          {isAdminMode ? (
            <>
              <NavSection label="Featured" first />
              <NavItem
                href="/admin/dashboard"
                icon={ChartBar}
                label="Dashboard"
                active={pathname.startsWith("/admin/dashboard")}
              />
              <NavItem
                href="/admin/daily"
                icon={CalendarCheck}
                label="Daily Ops"
                active={pathname.startsWith("/admin/daily")}
              />

              <NavSection label="People" />
              <NavItem
                href="/admin/users"
                icon={UsersThree}
                label="Users"
                active={pathname.startsWith("/admin/users")}
              />
              <NavItem
                href="/admin/invites"
                icon={PaperPlaneTilt}
                label="Invite"
                active={pathname.startsWith("/admin/invites")}
              />

              <NavSection label="Workspace" />
              <NavItem
                href="/admin/projects"
                icon={Folders}
                label="Projects"
                active={pathname.startsWith("/admin/projects")}
              />
              <NavItem
                href="/admin/spaces"
                icon={Buildings}
                label="Spaces"
                active={pathname.startsWith("/admin/spaces")}
              />

              <NavSection label="System" />
              <NavItem
                href="/admin/activity"
                icon={Pulse}
                label="Activity"
                active={pathname.startsWith("/admin/activity")}
              />
              <NavItem
                href="/admin/system"
                icon={GearSix}
                label="System"
                active={pathname.startsWith("/admin/system")}
              />
            </>
          ) : (
            <>
              <NavSection label="Featured" first />
              <NavItem
                href="/dashboard"
                icon={ChartBar}
                label="Dashboard"
                active={pathname === "/dashboard"}
              />
              <NavItem
                href="/today"
                icon={CalendarDots}
                label="Today"
                active={pathname === "/today"}
              />
              <NavItem
                href="/daily"
                icon={Plant}
                label="Task"
                active={pathname === "/daily"}
              />

              <NavSection label="Workspace" />
              <NavItem
                href="/projects"
                icon={Folders}
                label="Projects"
                active={pathname === "/projects"}
              />
              <NavItem
                href="/spaces"
                icon={Buildings}
                label="Spaces"
                active={pathname === "/spaces" || pathname.startsWith("/spaces/")}
              />
            </>
          )}
        </nav>

        {/* Fills space in the collapsed rail so the footer stays pinned. */}
        <div className="sidebar-rail-spacer" aria-hidden />

        {isAdminMode ? <div className="mt-6 flex-1" /> : null}

        <div
          className={cn(
            "sidebar-collapsible mt-6 min-h-0 flex-1 overflow-y-auto pr-1",
            isAdminMode && "hidden",
          )}
        >
          <div className="mb-2 flex items-center justify-between px-2">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
              Project list
            </p>
            <span className="font-mono text-[11px] text-muted">{projects.length}</span>
          </div>

          <div className="space-y-0.5">
            {projects.length ? (
              projects.slice(0, SIDEBAR_PROJECT_CAP).map((project) => {
                const href = `/projects/${project.id}`;
                const isActive =
                  pathname === href || pathname.startsWith(`${href}/`);
                const hasColor = Boolean(project.color);
                // Colored rows: soft tint when idle, deepen + invert text to
                // white when active. Token rescope cascades to text-foreground
                // / text-muted-strong / text-muted descendants.
                const colorStyle: React.CSSProperties | undefined = hasColor
                  ? isActive
                    ? {
                        backgroundColor: project.color!,
                        ["--foreground" as never]: "#ffffff",
                        ["--muted" as never]: "rgba(255,255,255,0.78)",
                        ["--muted-strong" as never]: "rgba(255,255,255,0.94)",
                      }
                    : {
                        backgroundColor: `color-mix(in srgb, ${project.color} 18%, transparent)`,
                      }
                  : undefined;

                return (
                  <Link
                    key={project.id}
                    href={href}
                    className={cn(
                      "relative block rounded-sm py-1.5 pl-3 pr-2 transition",
                      isActive
                        ? hasColor
                          ? null
                          : "bg-accent-soft"
                        : hasColor
                          ? null
                          : "hover:bg-surface",
                    )}
                    style={colorStyle}
                  >
                    {isActive && !hasColor ? (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent animate-breathe"
                      />
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "truncate text-[13px] font-medium",
                            isActive ? "text-foreground" : "text-muted-strong",
                          )}
                        >
                          {project.name}
                        </p>
                        <p className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                          {formatProjectStatus(project.status)}
                        </p>
                      </div>
                      <Kanban className="mt-0.5 size-4 text-muted" />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="rounded-md border border-dashed border-border bg-surface px-3 py-5 text-center">
                <div className="mx-auto inline-flex size-8 items-center justify-center rounded-sm border border-border bg-background text-muted">
                  <Folders className="size-4" />
                </div>
                <p className="mt-2 text-[12px] font-medium text-foreground">No projects yet</p>
                <p className="mt-0.5 text-[12px] leading-5 text-muted">Create one to begin.</p>
              </div>
            )}

            {projects.length > SIDEBAR_PROJECT_CAP ? (
              <Link
                href="/projects"
                className="mt-1 flex items-center justify-between rounded-sm px-3 py-1.5 text-[12px] font-medium text-muted transition hover:bg-surface hover:text-foreground"
              >
                <span>Show all projects</span>
                <span className="font-mono text-[11px]">
                  +{projects.length - SIDEBAR_PROJECT_CAP}
                </span>
              </Link>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("seeder:open-shortcuts"))
          }
          title="Keyboard shortcuts (press ?)"
          className={cn(
            "sidebar-collapsible mt-4 flex w-full shrink-0 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-left text-muted transition duration-150",
            "hover:-translate-y-px hover:border-border-strong hover:bg-surface-strong hover:text-foreground",
            "active:translate-y-0 active:scale-[0.98] motion-reduce:transform-none",
            isAdminMode && "hidden",
          )}
        >
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.04em]">
            Shortcuts
          </span>
          <kbd className="inline-flex min-w-[18px] items-center justify-center rounded-sm border border-border bg-surface-strong px-1 py-0.5 font-mono text-[10px] font-medium text-muted">
            ?
          </kbd>
        </button>

        <div className="sidebar-rail-center mt-3 flex shrink-0 items-center gap-2.5 rounded-md border border-border bg-surface p-2">
          <Avatar
            name={userName}
            email={userEmail}
            image={userImage}
            px={32}
            className="size-8 rounded-sm text-[11px]"
          />
          <div className="sidebar-collapsible min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">{userName}</p>
            <p className="truncate font-mono text-[11px] text-muted">{userEmail}</p>
          </div>
          <div className="sidebar-collapsible flex shrink-0 items-center gap-0.5">
            <ThemeToggle />
            <Link
              href="/settings"
              title="Settings"
              aria-label="Settings"
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-sm transition hover:bg-surface-strong hover:text-foreground",
                pathname.startsWith("/settings") && !pathname.startsWith("/settings/tokens")
                  ? "bg-surface-strong text-foreground"
                  : "text-muted",
              )}
            >
              <GearSix className="size-4" />
            </Link>
            <SignOutButton className="inline-flex size-7 min-h-0 items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-muted transition hover:bg-danger/10 hover:text-danger">
              <Power className="size-4" />
              <span className="sr-only">Sign out</span>
            </SignOutButton>
          </div>
        </div>
      </aside>

      {isNotificationsOpen ? (
        <div className="fixed inset-0 z-50 p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close notifications"
            onClick={() => setIsNotificationsOpen(false)}
            className="ui-modal-backdrop absolute inset-0 backdrop-blur-xs"
          />
          <div className="relative mx-auto flex min-h-full max-w-2xl items-start justify-center pt-[10dvh]">
            <div className="ui-modal-panel w-full overflow-hidden rounded-md border border-border bg-surface-strong shadow-xl">
              <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
                <div>
                  <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                    Notifications
                  </p>
                  <h3 className="mt-2 text-[17px] font-medium tracking-[-0.022em] text-foreground">
                    Inbox for action
                  </h3>
                  <p className="mt-1 text-[13px] leading-6 text-muted">
                    Requests, deadlines, and completed tasks that still need a public update.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hasAnyNotifications ? (
                    <button
                      type="button"
                      onClick={clearAllNotifications}
                      className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[12px] font-medium text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                    >
                      Clear all
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setIsNotificationsOpen(false)}
                    className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                  >
                    <X className="size-4" />
                    <span className="sr-only">Close notifications</span>
                  </button>
                </div>
              </div>

              <div className="max-h-[70dvh] overflow-y-auto p-3 sm:p-4">
                {isNotificationsLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="ui-skeleton h-20" />
                    ))}
                  </div>
                ) : notificationsError ? (
                  <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center text-[13px] leading-7 text-muted">
                    {notificationsError}
                  </div>
                ) : notifications?.length ? (
                  <div className="space-y-2">
                    {notifications.map((notification) => {
                      const isRead = Boolean(notification.readAt);
                      return (
                        <Link
                          key={notification.id}
                          href={notification.href}
                          onClick={() => {
                            setIsNotificationsOpen(false);
                            // Optimistic: mark this row read locally first so
                            // the badge count drops immediately, then persist.
                            if (!isRead) {
                              setNotifications((current) =>
                                current
                                  ? current.map((item) =>
                                      item.id === notification.id
                                        ? { ...item, readAt: new Date() }
                                        : item,
                                    )
                                  : current,
                              );
                              setLiveNotificationCount((count) =>
                                Math.max(0, count - 1),
                              );
                              const formData = new FormData();
                              formData.set("notificationId", notification.id);
                              void markNotificationReadAction(formData);
                            }
                          }}
                          className={cn(
                            "block rounded-md border border-border bg-surface px-4 py-3 transition hover:border-border-strong hover:bg-surface-strong",
                            isRead && "opacity-60",
                          )}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={cn(
                                    "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.04em]",
                                    toneClassNames[notification.tone],
                                  )}
                                >
                                  {notification.tone}
                                </span>
                                <p className="truncate text-[13px] font-medium text-foreground">
                                  {notification.title}
                                </p>
                                {isRead ? (
                                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-muted">
                                    read
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-[13px] leading-6 text-muted">
                                {notification.detail}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                                {notification.projectName}
                              </p>
                              <p className="mt-1 font-mono text-[11px] text-muted">
                                {formatDate(notification.createdAt)}
                              </p>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center">
                    <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
                      <Bell className="size-5" />
                    </div>
                    <p className="mt-3 text-[13px] font-medium text-foreground">
                      Nothing needs attention right now.
                    </p>
                    <p className="mt-1 text-[13px] leading-6 text-muted">
                      New requests, due tasks, and finished items waiting for a client update will appear here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// A small uppercase heading that groups the nav rows beneath it into a named
// section. Wrapped in `.sidebar-collapsible` so it disappears in the collapsed
// rail (where only the icons remain); `first` drops the top spacing so the
// opening section sits flush under the command bar.
function NavSection({ label, first }: { label: string; first?: boolean }) {
  return (
    <p
      className={cn(
        "sidebar-collapsible px-2 pb-1 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted",
        first ? "pt-0" : "pt-3",
      )}
    >
      {label}
    </p>
  );
}

// One sidebar nav row. The label is wrapped in `.sidebar-collapsible` so CSS
// hides it in the collapsed rail (leaving the centered icon); `title` gives a
// native tooltip when collapsed.
function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(
        "sidebar-navlink flex min-h-8 items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] font-medium transition",
        active
          ? "bg-accent-soft text-foreground"
          : "text-muted hover:bg-surface hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="sidebar-collapsible">{label}</span>
    </Link>
  );
}
