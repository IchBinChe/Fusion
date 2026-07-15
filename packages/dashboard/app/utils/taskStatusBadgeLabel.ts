/*
FNXC:MergeQueue 2026-07-15-10:45:
AI merge sets task.status to reviewing/landing for most of the live merge window. Board/list badges must never show those raw engine strings; map the full active-merge pipeline to operator-facing Merging… (and Merging fixes… for merging-fix).
*/
import type { TFunction } from "i18next";
import { isActiveMergeStatus } from "../../../core/src/active-merge-status";

export function getTaskStatusBadgeLabel(
  status: string | null | undefined,
  t: TFunction<"app">,
): string {
  if (!status) return "";
  if (status === "merging-fix") {
    return t("tasks.statusMergingFix", "Merging fixes…");
  }
  if (isActiveMergeStatus(status)) {
    return t("tasks.statusMerging", "Merging…");
  }
  return status;
}
