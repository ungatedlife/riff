import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";

/// Mounts theming for a window root: `useTheme` resolves the active theme
/// and writes the CSS variables. Theme changes come from Settings only.
interface Props {
  children: ReactNode;
}

export default function ThemeProvider({ children }: Props) {
  useTheme();
  return <>{children}</>;
}
