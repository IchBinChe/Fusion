import { DEFAULT_LOCALE, isLocale, type Locale, SUPPORTED_LOCALES } from "@fusion/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { LANGUAGE_STORAGE_KEY } from "../i18n";

const isBrowser = typeof window !== "undefined";

function readCachedLanguage(): Locale | undefined {
  if (!isBrowser) return undefined;
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export interface UseLanguageReturn {
  language: Locale;
  supportedLocales: readonly Locale[];
  setLanguage: (locale: Locale) => void;
}

/**
 * Language preference hook. Mirrors useTheme's three-tier persistence:
 * - the i18next browser detector seeds the active locale from localStorage,
 * - the user's choice writes through to localStorage and server GlobalSettings,
 * - server settings hydrate the locale on mount when no local choice exists.
 *
 * Switching applies in place via `i18n.changeLanguage` — no full-page reload,
 * so unsaved state and in-flight agent views survive a language change.
 */
export function useLanguage(): UseLanguageReturn {
  const { i18n } = useTranslation();
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const initial: Locale = isLocale(resolved) ? resolved : DEFAULT_LOCALE;
  const [language, setLanguageState] = useState<Locale>(initial);
  const userSetRef = useRef(false);

  // Reflect any i18next language change (including programmatic ones) into state.
  useEffect(() => {
    const handler = (lng: string) => {
      if (isLocale(lng)) setLanguageState(lng);
    };
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, [i18n]);

  // Hydrate from server settings, but never override a local/user choice.
  useEffect(() => {
    if (!isBrowser) return;
    let cancelled = false;

    void fetchGlobalSettings()
      .then((settings) => {
        if (cancelled || userSetRef.current) return;
        const serverLocale = isLocale(settings.language) ? settings.language : undefined;
        if (serverLocale && !readCachedLanguage() && serverLocale !== i18n.resolvedLanguage) {
          void i18n.changeLanguage(serverLocale);
        }
      })
      .catch((error) => {
        console.warn("[useLanguage] Failed to hydrate language from global settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [i18n]);

  const setLanguage = useCallback(
    (locale: Locale) => {
      userSetRef.current = true;
      setLanguageState(locale);
      // changeLanguage re-renders the tree in place and the detector caches the
      // choice to localStorage; write it explicitly too in case caching is off.
      void i18n.changeLanguage(locale);
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
      } catch {
        // localStorage unavailable — server write-through below still runs.
      }
      void updateGlobalSettings({ language: locale }).catch((error) => {
        console.warn("[useLanguage] Failed to persist language to global settings", error);
      });
    },
    [i18n],
  );

  return { language, supportedLocales: SUPPORTED_LOCALES, setLanguage };
}
