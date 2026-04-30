import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomProvidersSection } from "../CustomProvidersSection";
import type { CustomProvider } from "../../api";

vi.mock("../../api", () => ({
  fetchCustomProviders: vi.fn(),
  addCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
}));

vi.mock("lucide-react", () => {
  const ForwardRef = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
  return {
    ChevronRight: ForwardRef,
    Plus: ForwardRef,
    Pencil: ForwardRef,
    Trash2: ForwardRef,
    Loader2: ForwardRef,
    AlertCircle: ForwardRef,
  };
});

import { addCustomProvider, deleteCustomProvider, fetchCustomProviders, updateCustomProvider } from "../../api";

const mockedFetchCustomProviders = vi.mocked(fetchCustomProviders);
const mockedAddCustomProvider = vi.mocked(addCustomProvider);
const mockedUpdateCustomProvider = vi.mocked(updateCustomProvider);
const mockedDeleteCustomProvider = vi.mocked(deleteCustomProvider);

const baseProvider: CustomProvider = {
  id: "proxy-1",
  name: "Proxy One",
  apiType: "openai-compatible",
  baseUrl: "https://proxy.example.com/v1",
  models: [{ id: "gpt-4", name: "gpt-4" }],
};

const secondProvider: CustomProvider = {
  id: "proxy-2",
  name: "Proxy Two",
  apiType: "anthropic-compatible",
  baseUrl: "https://anthropic-proxy.example.com/v1",
  models: [{ id: "claude-3-7-sonnet", name: "claude-3-7-sonnet" }],
};

async function openDisclosure(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Advanced: Custom Providers" }));
  return user;
}

describe("CustomProvidersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchCustomProviders.mockResolvedValue([] as CustomProvider[] & { providers: CustomProvider[] });
    mockedAddCustomProvider.mockResolvedValue(baseProvider);
    mockedUpdateCustomProvider.mockResolvedValue(baseProvider);
    mockedDeleteCustomProvider.mockResolvedValue({ success: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders disclosure trigger", () => {
    render(<CustomProvidersSection />);
    expect(screen.getByRole("button", { name: "Advanced: Custom Providers" })).toBeInTheDocument();
  });

  it("fetches providers on first open and shows empty state", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();

    await waitFor(() => expect(mockedFetchCustomProviders).toHaveBeenCalledTimes(1));
    expect(screen.getByText("No custom providers configured.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Custom Provider/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced: Custom Providers" }));
    await user.click(screen.getByRole("button", { name: "Advanced: Custom Providers" }));
    expect(mockedFetchCustomProviders).toHaveBeenCalledTimes(1);
  });

  it("shows form fields when add is clicked", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();

    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));

    expect(screen.getByLabelText("Provider name")).toBeInTheDocument();
    expect(screen.getByLabelText("API type")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.getByLabelText("Available models")).toBeInTheDocument();
  });

  it("validates required fields", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();
    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    expect(screen.getByText("Provider name is required.")).toBeInTheDocument();
    expect(mockedAddCustomProvider).not.toHaveBeenCalled();
  });

  it("validates base url protocol", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();
    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));
    await user.type(screen.getByLabelText("Provider name"), "Proxy");
    await user.type(screen.getByLabelText("Base URL"), "ftp://proxy");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    expect(screen.getByText("Base URL must be a valid http/https URL.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), "not-a-url");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));
    expect(screen.getByText("Base URL must be a valid http/https URL.")).toBeInTheDocument();
  });

  it("adds provider with parsed models payload", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();
    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));

    await user.type(screen.getByLabelText("Provider name"), "Proxy Two");
    await user.selectOptions(screen.getByLabelText("API type"), "openai-compatible");
    await user.type(screen.getByLabelText("Base URL"), "https://proxy2.example.com/v1");
    await user.type(screen.getByLabelText("API key"), "secret");
    await user.type(screen.getByLabelText("Available models"), "gpt-4, gpt-4o-mini,  ");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockedAddCustomProvider).toHaveBeenCalledWith({
        name: "Proxy Two",
        apiType: "openai-compatible",
        baseUrl: "https://proxy2.example.com/v1",
        apiKey: "secret",
        models: [
          { id: "gpt-4", name: "gpt-4" },
          { id: "gpt-4o-mini", name: "gpt-4o-mini" },
        ],
      });
    });
  });

  it("renders existing providers", async () => {
    mockedFetchCustomProviders.mockResolvedValueOnce([baseProvider] as CustomProvider[] & { providers: CustomProvider[] });
    render(<CustomProvidersSection />);
    await openDisclosure();

    expect(await screen.findByText("Proxy One")).toBeInTheDocument();
    expect(screen.getByText("openai-compatible")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/proxy\.example\.com\/v1/)).toBeInTheDocument();
  });

  it("edits provider inline and pre-populates models", async () => {
    mockedFetchCustomProviders.mockResolvedValueOnce(
      [baseProvider, secondProvider] as CustomProvider[] & { providers: CustomProvider[] },
    );
    render(<CustomProvidersSection />);
    const user = await openDisclosure();

    await user.click(await screen.findByRole("button", { name: "Edit Proxy One" }));

    const updatedField = screen.getByLabelText("Provider name");
    expect(updatedField).toHaveValue("Proxy One");
    expect(screen.getByLabelText("Available models")).toHaveValue("gpt-4");
    expect(screen.getByText("Proxy Two")).toBeInTheDocument();

    await user.clear(updatedField);
    await user.type(updatedField, "Proxy Updated");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockedUpdateCustomProvider).toHaveBeenCalledWith("proxy-1", {
        name: "Proxy Updated",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "gpt-4", name: "gpt-4" }],
      });
    });
  });

  it("deletes provider when confirmed", async () => {
    mockedFetchCustomProviders.mockResolvedValueOnce([baseProvider] as CustomProvider[] & { providers: CustomProvider[] });
    render(<CustomProvidersSection />);
    const user = await openDisclosure();

    await user.click(await screen.findByRole("button", { name: "Delete Proxy One" }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockedDeleteCustomProvider).toHaveBeenCalledWith("proxy-1"));
  });

  it("does not delete provider when confirm is canceled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mockedFetchCustomProviders.mockResolvedValueOnce([baseProvider] as CustomProvider[] & { providers: CustomProvider[] });
    render(<CustomProvidersSection />);
    const user = await openDisclosure();

    await user.click(await screen.findByRole("button", { name: "Delete Proxy One" }));

    expect(mockedDeleteCustomProvider).not.toHaveBeenCalled();
  });

  it("cancel closes form without API calls", async () => {
    render(<CustomProvidersSection />);
    const user = await openDisclosure();
    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Provider name")).not.toBeInTheDocument();
    expect(mockedAddCustomProvider).not.toHaveBeenCalled();
    expect(mockedUpdateCustomProvider).not.toHaveBeenCalled();
  });

  it("shows API error state on fetch failure", async () => {
    mockedFetchCustomProviders.mockRejectedValueOnce(new Error("fetch failed"));
    render(<CustomProvidersSection />);
    await openDisclosure();

    expect(await screen.findByText("fetch failed")).toBeInTheDocument();
  });

  it("shows API error state on add failure", async () => {
    mockedAddCustomProvider.mockRejectedValueOnce(new Error("save failed"));
    render(<CustomProvidersSection />);
    const user = await openDisclosure();
    await user.click(screen.getByRole("button", { name: /Add Custom Provider/ }));

    await user.type(screen.getByLabelText("Provider name"), "Proxy Two");
    await user.type(screen.getByLabelText("Base URL"), "https://proxy2.example.com/v1");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });
});
