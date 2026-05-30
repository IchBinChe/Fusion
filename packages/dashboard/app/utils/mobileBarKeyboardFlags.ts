export interface MobileBarKeyboardFlagsInput {
  isMobile: boolean;
  keyboardOpen: boolean;
  anyModalOpen: boolean;
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
 */
export function computeMobileBarKeyboardFlags({
  isMobile,
  keyboardOpen,
  anyModalOpen,
  isIOS,
}: MobileBarKeyboardFlagsInput): MobileBarKeyboardFlags {
  const footerHidden = isMobile && keyboardOpen && !anyModalOpen && isIOS;
  const navKeyboardOpen = isMobile && keyboardOpen;
  const footerKeyboardOpen = navKeyboardOpen && isIOS;

  return {
    footerHidden,
    navKeyboardOpen,
    footerKeyboardOpen,
  };
}
