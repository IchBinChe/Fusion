import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useOverlayDismiss } from "../useOverlayDismiss";

function OverlayHarness({ onClose }: { onClose: () => void }) {
  const props = useOverlayDismiss(onClose);
  return (
    <div data-testid="overlay" {...props}>
      <div data-testid="modal-content">content</div>
    </div>
  );
}

describe("useOverlayDismiss", () => {
  it("closes on real overlay mouse down/up", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} />);
    const overlay = getByTestId("overlay");

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores compatibility mouse sequence immediately after touch", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} />);
    const overlay = getByTestId("overlay");

    fireEvent.touchStart(overlay);
    fireEvent.touchEnd(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("does not close when mouse starts inside modal and ends on overlay", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<OverlayHarness onClose={onClose} />);
    const overlay = getByTestId("overlay");
    const modal = getByTestId("modal-content");

    fireEvent.mouseDown(modal);
    fireEvent.mouseUp(overlay);

    expect(onClose).toHaveBeenCalledTimes(0);
  });
});
