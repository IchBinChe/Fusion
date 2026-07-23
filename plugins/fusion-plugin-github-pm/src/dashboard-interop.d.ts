declare module "@fusion/dashboard/app/plugins/types" {
  import type { ReactNode } from "react";

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks?: unknown[];
    workflowSteps?: unknown[];
    openTaskDetail?: (...args: unknown[]) => void;
    openFile?: (...args: unknown[]) => void;
    renderTaskCard?: (...args: unknown[]) => ReactNode;
    addToast?: (message: string, type?: "success" | "error" | "warning" | "info") => void;
  }
}

/*
FNXC:GithubPmWriteGate 2026-07-24-06:40:
FUSI-017: the dashboard's useConfirm.ts uses the dashboard app's own "bundler" module
resolution (relative imports without explicit .js extensions), which fails this plugin's
stricter node16 typecheck if tsc resolves the REAL source file directly. Mirrors the
PluginDashboardViewContext shim above: this ambient module declares only the narrow type
surface this plugin actually consumes so `tsc --noEmit` never opens the real dashboard
source tree. The real hook module is still used at runtime/in tests via the vitest.config.ts
alias and the package.json dependency/exports subpath -- only the TYPE resolution is shimmed.
*/
declare module "@fusion/dashboard/app/hooks/useConfirm" {
  export interface ConfirmOptions {
    title: string;
    message: string;
    alwaysAsk?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    tertiaryLabel?: string;
    tertiaryDanger?: boolean;
    checkbox?: {
      label: string;
      description?: string;
      defaultChecked?: boolean;
    };
  }

  export type ConfirmChoice = "primary" | "tertiary" | "cancel";

  export function useConfirm(): {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
    confirmWithChoice: (options: ConfirmOptions) => Promise<ConfirmChoice>;
    confirmWithCheckbox: (options: ConfirmOptions) => Promise<{ choice: ConfirmChoice; checkboxValue: boolean }>;
  };
}
