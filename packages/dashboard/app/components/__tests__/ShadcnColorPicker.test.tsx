import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShadcnColorPicker } from "../ShadcnColorPicker";
import { SHADCN_CUSTOM_COLOR_TOKENS } from "../shadcnCustomColors";

describe("ShadcnColorPicker", () => {
  it("renders one color control row per customizable token", () => {
    render(<ShadcnColorPicker value={{}} onChange={vi.fn()} resolvedThemeMode="dark" />);

    expect(screen.getByTestId("shadcn-color-picker")).toBeDefined();
    for (const token of SHADCN_CUSTOM_COLOR_TOKENS) {
      expect(screen.getByTestId(`shadcn-color-${token.cssVar}`)).toBeDefined();
      expect(screen.getByText(token.cssVar)).toBeDefined();
    }
  });

  it("uses light defaults when no override exists", () => {
    render(<ShadcnColorPicker value={{}} onChange={vi.fn()} resolvedThemeMode="light" />);

    const bgRow = screen.getByTestId("shadcn-color---bg");
    expect(within(bgRow).getByRole("textbox")).toHaveValue("#ffffff");
  });

  it("emits sanitized changes and rejects invalid hex input", () => {
    const onChange = vi.fn();
    render(<ShadcnColorPicker value={{}} onChange={onChange} resolvedThemeMode="dark" />);

    const accentRow = screen.getByTestId("shadcn-color---accent");
    fireEvent.change(within(accentRow).getByRole("textbox"), { target: { value: "red" } });
    expect(onChange).toHaveBeenLastCalledWith({});

    fireEvent.change(within(accentRow).getByRole("textbox"), { target: { value: "#FF8800" } });
    expect(onChange).toHaveBeenLastCalledWith({ "--accent": "#FF8800" });
  });

  it("normalizes short hex values for the native color input", () => {
    render(<ShadcnColorPicker value={{ "--accent": "#fff" }} onChange={vi.fn()} resolvedThemeMode="dark" />);

    const accentRow = screen.getByTestId("shadcn-color---accent");
    expect(within(accentRow).getByLabelText("Pick Accent color")).toHaveValue("#ffffff");
  });

  it("reset clears all custom color overrides", () => {
    const onChange = vi.fn();
    render(<ShadcnColorPicker value={{ "--accent": "#123456" }} onChange={onChange} resolvedThemeMode="dark" />);

    fireEvent.click(screen.getByRole("button", { name: "Reset custom colors" }));
    expect(onChange).toHaveBeenCalledWith({});
  });
});
