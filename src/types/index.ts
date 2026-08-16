export interface StickedNote {
  id: string;
  content: string;
  folder: string;
  position: [number, number] | null;
  size: [number, number] | null;
  created_at: string;
  updated_at: string;
  originalPath?: string;
}

export interface ShortcutMapping {
  shortcut: string;
  folder: string;
  enabled: boolean;
}

export interface CustomTemplate {
  name: string;
  body: string;
}

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
  shortcut_mappings: ShortcutMapping[];
  default_folder: string;
  vim_mode_enabled: boolean;
  theme_mode: string;
  notes_directory: string;
  hide_dock_icon: boolean;
  folder_colors: Record<string, string>;
  system_shortcuts: Record<string, string>;
  font_size: number;
  custom_templates: CustomTemplate[];
  sidebar_position: string;
  text_direction: string;
  hide_tray_icon: boolean;
  capture_window_size: [number, number] | null;
  active_theme: string;
  custom_themes: CustomThemeDefinition[];
  font_family?: string | null; // null = system default
  window_opacity?: number; // 0.2–1.0, default 1.0
  custom_fonts?: CustomFontEntry[];
  use_directory_as_root?: boolean;
  /// BCP-47 locale tag for the UI language. "" = follow system language.
  language?: string;
}

export interface NoteInfo {
  path: string;
  filename: string;
  folder: string;
  content: string;
  created: string;
}

export interface SearchResult {
  path: string;
  filename: string;
  folder: string;
  title: string;
  snippet: string;
  created: string;
}

export interface FolderStats {
  name: string;
  note_count: number;
}

export interface ClipboardPayload {
  plain_text: string;
  html: string;
}
