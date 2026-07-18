/*
FNXC:MissionAutoMerge 2026-07-18-12:00:
Mission edits need an explicit inherited state: the client must send null rather than
undefined so JSON serialization clears an existing mission auto-merge override.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockUpdateMission = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    updateMission: (...args: unknown[]) => mockUpdateMission(...args),
  };
});

const now = "2026-07-18T12:00:00.000Z";

function mission(autoMerge?: boolean) {
  return {
    id: "M-001",
    title: "Single PR Mission",
    description: "",
    status: "planning",
    autoMerge,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

function setDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function openEditForm(autoMerge?: boolean) {
  const detail = mission(autoMerge);
  mockFetchMissions.mockResolvedValue([detail]);
  mockFetchMission.mockResolvedValue(detail);
  render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" />);
  fireEvent.click(await screen.findByText("Single PR Mission"));
  const editButtons = await screen.findAllByRole("button", { name: "Edit mission" });
  fireEvent.click(editButtons[0]!);
  return screen.getByLabelText("Mission auto-merge override") as HTMLSelectElement;
}

describe("MissionManager auto-merge override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setDesktopViewport();
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    mockUpdateMission.mockResolvedValue(mission());
  });

  it.each([
    [undefined, "inherit"],
    [true, "on"],
    [false, "off"],
  ] as const)("reflects a %s mission override as %s", async (autoMerge, expected) => {
    const control = await openEditForm(autoMerge);
    expect(control.value).toBe(expected);
  });

  it("sends null when an existing override is returned to inherited", async () => {
    const control = await openEditForm(false);
    fireEvent.change(control, { target: { value: "inherit" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(mockUpdateMission).toHaveBeenCalledWith(
        "M-001",
        expect.objectContaining({ autoMerge: null }),
        "project-1",
      );
    });
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)("sends %s as an explicit %s override", async (selection, expected) => {
    const control = await openEditForm();
    fireEvent.change(control, { target: { value: selection } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(mockUpdateMission).toHaveBeenCalledWith(
        "M-001",
        expect.objectContaining({ autoMerge: expected }),
        "project-1",
      );
    });
  });
});
