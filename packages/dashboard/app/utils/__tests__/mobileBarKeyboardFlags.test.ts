import { describe, expect, it } from "vitest";
import { computeMobileBarKeyboardFlags } from "../mobileBarKeyboardFlags";

describe("computeMobileBarKeyboardFlags", () => {
  it("keeps footer rendered and uncollapsed on Android when keyboard is open", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: false,
      isIOS: false,
    });

    expect(flags.footerKeyboardOpen).toBe(false);
    expect(flags.footerHidden).toBe(false);
    expect(flags.navKeyboardOpen).toBe(true);
  });

  it("hides and collapses footer on iOS when keyboard is open and no overlay is open", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: false,
      isIOS: true,
    });

    expect(flags.footerHidden).toBe(true);
    expect(flags.navKeyboardOpen).toBe(true);
    expect(flags.footerKeyboardOpen).toBe(true);
  });

  it("keeps footer visible when iOS keyboard is open over a modal", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: true,
      overlayOpen: false,
      isIOS: true,
    });

    expect(flags.footerHidden).toBe(false);
    expect(flags.footerKeyboardOpen).toBe(true);
    expect(flags.navKeyboardOpen).toBe(true);
  });

  it("returns all false when keyboard is closed", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: false,
      anyModalOpen: false,
      overlayOpen: false,
      isIOS: true,
    });

    expect(flags).toEqual({
      footerHidden: false,
      navKeyboardOpen: false,
      footerKeyboardOpen: false,
    });
  });

  it("returns all false when not mobile", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: false,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: false,
      isIOS: true,
    });

    expect(flags).toEqual({
      footerHidden: false,
      navKeyboardOpen: false,
      footerKeyboardOpen: false,
    });
  });

  it("keeps the board footer visible on iOS when a fullscreen overlay owns the keyboard", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: true,
      isIOS: true,
    });

    expect(flags.footerHidden).toBe(false);
    expect(flags.navKeyboardOpen).toBe(true);
    expect(flags.footerKeyboardOpen).toBe(true);
  });

  it("keeps Android board-layout behavior unchanged when a fullscreen overlay owns the keyboard", () => {
    const flags = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: true,
      isIOS: false,
    });

    expect(flags.footerHidden).toBe(false);
    expect(flags.navKeyboardOpen).toBe(true);
    expect(flags.footerKeyboardOpen).toBe(false);
  });

  it("suppresses the original iOS board-shift trigger only when the Quick Chat overlay flag is set", () => {
    const originalBoardShiftTrigger = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: false,
      isIOS: true,
    });
    const quickChatOverlayKeyboard = computeMobileBarKeyboardFlags({
      isMobile: true,
      keyboardOpen: true,
      anyModalOpen: false,
      overlayOpen: true,
      isIOS: true,
    });

    expect(originalBoardShiftTrigger.footerHidden).toBe(true);
    expect(quickChatOverlayKeyboard.footerHidden).toBe(false);
    expect(quickChatOverlayKeyboard.navKeyboardOpen).toBe(true);
    expect(quickChatOverlayKeyboard.footerKeyboardOpen).toBe(true);
  });
});
