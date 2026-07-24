import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { LOCAL_STORAGE_KEYS, getItem, setItem } from "../utils/localStorage";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type Palette = "ember" | "violet" | "ocean" | "forest";

export const PALETTES: Palette[] = ["ember", "violet", "ocean", "forest"];

interface ThemeContextValue {
  mode: ThemeMode;
  theme: ResolvedTheme;
  palette: Palette;
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: Palette) => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): ResolvedTheme {
  const attr = document.documentElement.dataset.theme;
  return attr === "dark" ? "dark" : "light";
}

function readInitialPalette(): Palette {
  const attr = document.documentElement.dataset.palette as Palette | undefined;
  return attr && PALETTES.includes(attr) ? attr : "ember";
}

function readInitialMode(): ThemeMode {
  const stored = getItem<string>(LOCAL_STORAGE_KEYS.THEME, { parseAsJson: false });
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);
  const [theme, setTheme] = useState<ResolvedTheme>(readInitialTheme);
  const [palette, setPaletteState] = useState<Palette>(readInitialPalette);

  // Resolve mode -> actual theme, and follow the OS only while on "system".
  useEffect(() => {
    if (mode !== "system") {
      setTheme(mode);
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const resolve = () => setTheme(mql.matches ? "dark" : "light");
    resolve();
    mql.addEventListener("change", resolve);
    return () => mql.removeEventListener("change", resolve);
  }, [mode]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    setItem(LOCAL_STORAGE_KEYS.THEME, next, { parseAsJson: false });
  }, []);

  const setPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    setItem(LOCAL_STORAGE_KEYS.PALETTE, next, { parseAsJson: false });
  }, []);

  const toggleTheme = useCallback(() => {
    setMode(theme === "dark" ? "light" : "dark");
  }, [theme, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, theme, palette, setMode, setPalette, toggleTheme }),
    [mode, theme, palette, setMode, setPalette, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
