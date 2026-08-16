export interface CustomFontEntry {
  name: string; // font-family CSS name (derived from filename)
  path: string; // absolute path to the font file on disk
}

export interface ThemeColors {
  bg: string;
  surface: string;
  ink: string;
  stone: string;
  line: string;
  accent: string;
  accent_light: string;
  accent_dark: string;
  highlight?: string; // "R G B" format, e.g. "253 224 71"
}

export interface CustomThemeDefinition {
  id: string;
  name: string;
  is_dark: boolean;
  colors: ThemeColors;
}

export interface StikSettings {
  theme_mode: string;
  /** Absolute path of the drafts directory. Empty/undefined = ~/Documents/Riff. */
  drafts_dir?: string | null;
  hide_dock_icon: boolean;
  system_shortcuts: Record<string, string>;
  font_size: number;
  text_direction: string;
  hide_tray_icon: boolean;
  active_theme: string;
  custom_themes: CustomThemeDefinition[];
  font_family?: string | null; // null = system default
  window_opacity?: number; // 0.2–1.0, default 1.0
  custom_fonts?: CustomFontEntry[];
}

export interface NoteInfo {
  path: string;
  filename: string;
  content: string;
  created: string;
}

export interface SearchResult {
  path: string;
  filename: string;
  title: string;
  snippet: string;
  created: string;
}

export interface ClipboardPayload {
  plain_text: string;
  html: string;
}
