// Ambient host interop (no runtime dependency on @fusion/dashboard).
// Vite aliases resolve these to the real dashboard sources at build time.
// Mirrors fusion-plugin-compound-engineering/src/dashboard-interop.d.ts.

declare module "@fusion/dashboard/app/plugins/types" {
  export interface PluginDashboardViewContext {
    projectId?: string;
  }
}

declare module "@fusion/dashboard/app/components/ViewHeader" {
  import type { ComponentType, ReactNode } from "react";
  import type { LucideProps } from "lucide-react";

  export interface ViewHeaderProps {
    icon: ComponentType<LucideProps>;
    title: string;
    actions?: ReactNode;
    titleId?: string;
  }

  export function ViewHeader(props: ViewHeaderProps): ReactNode;
}
