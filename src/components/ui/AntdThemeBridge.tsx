import { useEffect, useState, type ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { useTheme } from "../../hooks/useTheme";

function readToken(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readTokens() {
  return {
    colorPrimary: readToken("--color-accent"),
    colorBgBase: readToken("--color-bg-surface"),
    colorTextBase: readToken("--color-text-primary"),
    colorBorder: readToken("--color-border"),
    colorError: readToken("--color-danger"),
    colorSuccess: readToken("--color-success"),
    borderRadius: parseInt(readToken("--radius-md"), 10) || 6,
    fontFamily: readToken("--font-sans"),
  };
}

export function AntdThemeBridge({ children }: { children: ReactNode }) {
  const { theme, palette } = useTheme();
  const [tokens, setTokens] = useState(readTokens);

  useEffect(() => {
    const id = requestAnimationFrame(() => setTokens(readTokens()));
    return () => cancelAnimationFrame(id);
  }, [theme, palette]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: tokens,
      }}
    >
      {children}
    </ConfigProvider>
  );
}
