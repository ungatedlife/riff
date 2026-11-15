import type { TranslationKey } from "@/i18n";

/// Hotkeys that reach Riff from any app: the three doors.
export const GLOBAL_SHORTCUT_ACTIONS = ["summon", "spark", "quickie"] as const;
/// Shortcuts that only work while Riff itself is active.
export const LOCAL_SHORTCUT_ACTIONS = ["search", "last_note", "zen_mode"] as const;
export const SYSTEM_SHORTCUT_ACTIONS = [
  ...GLOBAL_SHORTCUT_ACTIONS,
  ...LOCAL_SHORTCUT_ACTIONS,
] as const;
export type SystemAction = (typeof SYSTEM_SHORTCUT_ACTIONS)[number];

/// Settings is always ⌘, inside the app — not rebindable, never a hotkey.
export const SETTINGS_SHORTCUT = "Cmd+Comma";

export const SYSTEM_SHORTCUT_DEFAULTS: Record<SystemAction, string> = {
  // ⌃⌥⌘ + R/S/Q: three keys anyone can press. (Riff once shipped with
  // ⇧⌃⌥⌘, which needs a Caps Lock hyper key; setups that use it keep it.)
  summon: "Cmd+Ctrl+Alt+R",
  spark: "Cmd+Ctrl+Alt+S",
  quickie: "Cmd+Ctrl+Alt+Q",
  search: "Cmd+Shift+P",
  last_note: "Cmd+Shift+L",
  zen_mode: "Cmd+Period",
};

export const SYSTEM_SHORTCUT_LABEL_KEYS: Record<SystemAction, TranslationKey> = {
  summon: "shortcut.summon",
  spark: "shortcut.spark",
  quickie: "shortcut.quickie",
  search: "shortcut.search",
  last_note: "shortcut.lastNote",
  zen_mode: "shortcut.zenMode",
};

export function isGlobalAction(action: string): boolean {
  return (GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(action);
}

/** Get all system shortcut values for use as reserved list */
export function getSystemShortcutValues(
  systemShortcuts: Record<string, string>,
): string[] {
  return Object.values(systemShortcuts);
}
