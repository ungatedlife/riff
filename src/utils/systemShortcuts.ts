import type { TranslationKey } from "@/i18n";
export const SYSTEM_SHORTCUT_ACTIONS = [
  "summon",
  "quickie",
  "search",
  "settings",
  "last_note",
  "zen_mode",
] as const;
export type SystemAction = (typeof SYSTEM_SHORTCUT_ACTIONS)[number];

export const SYSTEM_SHORTCUT_DEFAULTS: Record<SystemAction, string> = {
  // Hyper (Cmd+Ctrl+Alt+Shift) + R/Q — pairs with a Caps Lock hyper key.
  summon: "Cmd+Ctrl+Alt+Shift+R",
  quickie: "Cmd+Ctrl+Alt+Shift+Q",
  search: "Cmd+Shift+P",
  settings: "Cmd+Shift+Comma",
  last_note: "Cmd+Shift+L",
  zen_mode: "Cmd+Period",
};

export const SYSTEM_SHORTCUT_LABEL_KEYS: Record<SystemAction, TranslationKey> = {
  summon: "shortcut.summon",
  quickie: "shortcut.quickie",
  search: "shortcut.search",
  settings: "shortcut.settings",
  last_note: "shortcut.lastNote",
  zen_mode: "shortcut.zenMode",
};

/** Get all system shortcut values for use as reserved list */
export function getSystemShortcutValues(
  systemShortcuts: Record<string, string>,
): string[] {
  return Object.values(systemShortcuts);
}
