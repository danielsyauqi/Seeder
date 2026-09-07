"use client";

import { ProgressProvider } from "@bprogress/next/app";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ProgressProvider
      height="3px"
      color="var(--accent)"
      delay={120}
      options={{ showSpinner: false }}
    >
      {children}
    </ProgressProvider>
  );
}
