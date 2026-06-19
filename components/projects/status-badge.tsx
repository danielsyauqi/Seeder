// A small status pill tinted with the status's own swatch color (the same
// PROJECT_SWATCHES palette used for categories/labels). Colors come from the DB
// where they're validated against the palette on write, so the inline
// color-mix() values are safe to interpolate. Falls back to a neutral pill when
// no color is supplied (e.g. an unknown/legacy status).
import { cn } from "@/lib/utils";

export function StatusBadge({
  name,
  color,
  className,
}: {
  name: string;
  color?: string | null;
  className?: string;
}) {
  const base =
    "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]";
  if (!color) {
    return (
      <span className={cn(base, "border-border bg-surface text-muted", className)}>
        {name}
      </span>
    );
  }
  return (
    <span
      className={cn(base, className)}
      style={{
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
        color,
      }}
    >
      {name}
    </span>
  );
}
