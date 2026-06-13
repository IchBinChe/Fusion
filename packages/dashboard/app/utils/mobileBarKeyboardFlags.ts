export interface MobileBarKeyboardFlagsInput {
  isMobile: boolean;
  keyboardOpen: boolean;
  anyModalOpen: boolean;
  /** True when a fullscreen mobile overlay owns keyboard/viewport layout. */
  overlayOpen: boolean;
  isIOS: boolean;
}

export interface MobileBarKeyboardFlags {
  footerHidden: boolean;
  navKeyboardOpen: boolean;
  footerKeyboardOpen: boolean;
}

/**
 * FN-5707: Android uses `interactive-widget=resizes-content`, so the layout
 * viewport shrinks with the keyboard and the footer's normal stacked bottom
 * position remains correct above the mobile nav. Only iOS should apply the
 * footer keyboard-collapse class (`bottom: 0`) used to let the keyboard cover
 * bars when visualViewport shifts independently.
 *
 * Fullscreen mobile overlays (for example Quick Chat's sheet) own their own
 * visual viewport handling. Treat them like modals for board-layout padding so
 * overlay-local keyboards never shift the underlying board.
 */
export function computeMobileBarKeyboardFlags({
  isMobile,
  keyboardOpen,
  anyModalOpen,
  overlayOpen,
  isIOS,
}: MobileBarKeyboardFlagsInput): MobileBarKeyboardFlags {
  const boardLayoutSuppressed = anyModalOpen || overlayOpen;
  const footerHidden = isMobile && keyboardOpen && !boardLayoutSuppressed && isIOS;
  const navKeyboardOpen = isMobile && keyboardOpen;
  const footerKeyboardOpen = navKeyboardOpen && isIOS;

  return {
    footerHidden,
    navKeyboardOpen,
    footerKeyboardOpen,
  };
}
