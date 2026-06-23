import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ModelPricingSection } from "./ModelPricingSection";
import type { SettingsFormState } from "./context";

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string, vars?: Record<string, unknown>) => {
    if (!vars) return fallback;
    return Object.entries(vars).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), fallback);
  } }),
}));

// Mock the API helper so fetch actions stay deterministic and do not hit the dashboard server.
vi.mock("../../../api", () => ({
  api: apiMock,
}));

function Harness({ initial, addToast = vi.fn() }: { initial: SettingsFormState; addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void }) {
  const [form, setForm] = useState<SettingsFormState>(initial);
  return (
    <ModelPricingSection
      form={form}
      setForm={setForm}
      addToast={addToast}
      projectId="proj-a"
    />
  );
}

const initialForm = (): SettingsFormState => ({
  modelPricingOverrides: {
    "openai:gpt-4o": {
      inputPer1M: 2.5,
      outputPer1M: 10,
      cacheReadPer1M: 1.25,
      cacheWritePer1M: 2.5,
      source: "manual",
    },
  },
} as SettingsFormState);

describe("ModelPricingSection", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("renders existing overrides and edits a row", () => {
    render(<Harness initial={initialForm()} />);

    expect(screen.getByText("openai:gpt-4o")).toBeInTheDocument();
    const inputRate = screen.getByLabelText("openai:gpt-4o input per 1M");
    fireEvent.change(inputRate, { target: { value: "3.75" } });

    expect(screen.getByLabelText("openai:gpt-4o input per 1M")).toHaveValue(3.75);
  });

  it("adds and deletes pricing rows through form state", () => {
    render(<Harness initial={{} as SettingsFormState} />);

    fireEvent.change(screen.getByLabelText("New provider:model key"), { target: { value: "Anthropic:Claude-Test" } });
    fireEvent.change(screen.getByLabelText("New input rate"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("New output rate"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("New cache read rate"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("New cache write rate"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("New source"), { target: { value: "manual-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));

    expect(screen.getByText("anthropic:claude-test")).toBeInTheDocument();
    expect(screen.getByLabelText("anthropic:claude-test output per 1M")).toHaveValue(5);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByText("anthropic:claude-test")).not.toBeInTheDocument();
    expect(screen.getByText("No model pricing overrides yet. Add one manually or fetch the latest LiteLLM prices.")).toBeInTheDocument();
  });

  it("shows an error toast and resets loading when pricing fetch fails", async () => {
    const addToast = vi.fn();
    let rejectFetch: (error: Error) => void = () => undefined;
    apiMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFetch = reject;
    }));

    render(<Harness initial={{} as SettingsFormState} addToast={addToast} />);
    fireEvent.click(screen.getByRole("button", { name: "Fetch latest prices" }));

    expect(await screen.findByRole("button", { name: "Fetching…" })).toBeDisabled();
    rejectFetch(new Error("pricing unavailable"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("pricing unavailable", "error"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch latest prices" })).not.toBeDisabled());
  });

  it("fetch button calls the API and refreshes fetched pricing state", async () => {
    apiMock
      .mockResolvedValueOnce({ count: 1, fetchedAt: "2026-06-22T00:00:00.000Z", source: "litellm" })
      .mockResolvedValueOnce({
        modelPricingFetchedAt: "2026-06-22T00:00:00.000Z",
        modelPricingSource: "litellm",
        modelPricingOverrides: {
          "openai:gpt-test": {
            inputPer1M: 1,
            outputPer1M: 2,
            cacheReadPer1M: 1,
            cacheWritePer1M: 1,
            source: "litellm/model_prices_and_context_window.json",
          },
        },
      });

    render(<Harness initial={{} as SettingsFormState} />);
    fireEvent.click(screen.getByRole("button", { name: "Fetch latest prices" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/command-center/pricing/fetch?projectId=proj-a",
      { method: "POST" },
    ));
    await waitFor(() => expect(screen.getByText("openai:gpt-test")).toBeInTheDocument());
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Prices as of/)).toBeInTheDocument();
    expect(screen.getByText(/litellm/)).toBeInTheDocument();
  });
});
