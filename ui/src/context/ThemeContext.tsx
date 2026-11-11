import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";
/** What the user picked. "system" follows the OS / phone setting live. */
export type ThemePreference = "system" | Theme;

interface ThemeContextValue {
  /** The resolved theme actually applied to the document. */
  theme: Theme;
  /** The user's choice: follow the system, or force light/dark. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#0b0a09";
const LIGHT_THEME_COLOR = "#e9e7e3";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return "system";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [system, setSystem] = useState<Theme>(() => systemTheme());
  const theme: Theme = preference === "system" ? system : preference;

  // Follow the OS / phone setting live while the preference is "system".
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    setPreferenceState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setPreferenceState(theme === "dark" ? "light" : "dark");
  }, [theme]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [preference]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setPreference,
      setTheme,
      toggleTheme,
    }),
    [theme, preference, setPreference, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
