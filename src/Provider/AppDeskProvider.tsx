import { theme as antdTheme } from "antd";
import { AppDeskProvider as BaseAppDeskProvider } from "@formstr/common-ui";
import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import "@formstr/common-ui/styles.css";

/**
 * Drive host wrapper: maps Ant Design + Drive palette tokens into the shared
 * drawer, and mounts it once for the app.
 */
export function AppDeskProvider({ children }: { children: ReactNode }) {
  const { token } = antdTheme.useToken();
  const { theme } = useTheme();

  const deskStyle = {
    "--fs-desk-bg": token.colorBgElevated,
    "--fs-desk-ink": token.colorText,
    "--fs-desk-muted": token.colorTextSecondary,
    "--fs-desk-line": token.colorBorderSecondary,
    "--fs-desk-line-strong": token.colorBorder,
    "--fs-desk-hover": token.colorFillTertiary,
    "--fs-desk-radius": `${token.borderRadiusLG}px`,
    "--fs-desk-shadow": token.boxShadowSecondary,
  } as CSSProperties;

  return (
    <BaseAppDeskProvider currentAppId="drive" theme={theme} style={deskStyle}>
      {children}
    </BaseAppDeskProvider>
  );
}
