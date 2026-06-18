import type { ReactNode } from "react";

// The colored accent header card used across top-level pages (Projects, Spaces,
// Settings, Admin) — `.ui-header` paints the brand-accent banner; eyebrow +
// title + optional description + optional right-aligned action.
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="ui-panel ui-header p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-3xl space-y-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
            {eyebrow}
          </p>
          <h1 className="text-3xl font-medium tracking-tighter text-foreground sm:text-[40px]">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-[13px] leading-6 text-muted sm:text-[15px]">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </section>
  );
}
