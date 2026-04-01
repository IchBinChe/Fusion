import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomModelDropdown } from "../CustomModelDropdown";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />, 
}));

const MOCK_MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

describe("CustomModelDropdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the open dropdown in a portal attached to document.body", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <div data-testid="host-surface">
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));

    const portal = await screen.findByTestId("model-combobox-portal");
    expect(portal).toBeInTheDocument();
    expect(portal).toHaveClass("model-combobox-dropdown--portal");
    expect(document.body).toContainElement(portal);

    const hostSurface = screen.getByTestId("host-surface");
    expect(hostSurface).not.toContainElement(portal);
  });

  it("keeps the portaled list interactive for selecting a model and clearing back to default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CustomModelDropdown
        label="Executor Model"
        value=""
        onChange={onChange}
        models={MOCK_MODELS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const portal = await screen.findByTestId("model-combobox-portal");

    await user.click(within(portal).getByText("Claude Sonnet 4.5"));
    expect(onChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");

    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const reopenedPortal = await screen.findByTestId("model-combobox-portal");
    await user.click(within(reopenedPortal).getByText("Use default"));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("closes the portaled dropdown when clicking outside the trigger and menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <div>
        <button type="button">Outside surface</button>
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    expect(await screen.findByTestId("model-combobox-portal")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Outside surface" }));

    await waitFor(() => {
      expect(screen.queryByTestId("model-combobox-portal")).not.toBeInTheDocument();
    });
  });
});
