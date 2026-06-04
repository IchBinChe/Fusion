import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import * as dashboardApi from "../../api";
import { FileBrowserProvider } from "../../context/FileBrowserContext";

setupTaskDetailModalHooks();

function renderModal(task = makeTask({ column: "done" })) {
  return render(
    <FileBrowserProvider openFile={vi.fn()}>
      <TaskDetailModal
        task={task}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />
    </FileBrowserProvider>,
  );
}

describe("TaskDetailModal custom fields (U13/KTD-14)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders no fields section when the workflow declares no fields (today's UI)", async () => {
    vi.spyOn(dashboardApi, "fetchBoardWorkflows").mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{ id: "builtin:coding", name: "Coding", columns: [] }],
      taskWorkflowIds: {},
    });
    renderModal();
    // Allow the field-defs fetch to settle.
    await waitFor(() => expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.queryByTestId("task-fields-section")).toBeNull();
  });

  it("renders the schema-driven fields section when the workflow declares fields", async () => {
    vi.spyOn(dashboardApi, "fetchBoardWorkflows").mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [],
          fields: [
            { id: "owner", name: "Owner", type: "string", render: { placement: "detail" } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    renderModal(makeTask({ id: "FN-001", column: "done", customFields: { owner: "alice" } }));
    await waitFor(() => expect(screen.getByTestId("task-fields-section")).toBeTruthy());
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("alice");
  });
});
