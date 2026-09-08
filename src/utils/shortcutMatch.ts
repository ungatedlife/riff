/// Match a keyboard event against a shortcut string in the form the
/// ShortcutRecorder produces ("Cmd+Shift+P", "Cmd+Period"). Keys are compared
/// on `e.code` (the physical key, which is what the recorder stores) with a
/// fallback on the typed character, so a binding works regardless of which
/// modifiers change the character macOS reports.

export interface ShortcutKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
  key: string;
}

interface ParsedShortcut {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const NAMED_KEY_CODES: Record<string, string[]> = {
  Comma: ["Comma"],
  Period: ["Period"],
  Slash: ["Slash"],
  Backslash: ["Backslash"],
  BracketLeft: ["BracketLeft"],
  BracketRight: ["BracketRight"],
  Semicolon: ["Semicolon"],
  Quote: ["Quote"],
  Backquote: ["Backquote"],
  Minus: ["Minus"],
  Equal: ["Equal"],
  Space: ["Space"],
  Enter: ["Enter", "NumpadEnter"],
  Tab: ["Tab"],
  Backspace: ["Backspace"],
  Escape: ["Escape"],
  Up: ["ArrowUp"],
  Down: ["ArrowDown"],
  Left: ["ArrowLeft"],
  Right: ["ArrowRight"],
};

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return {
    meta: mods.some((m) => ["cmd", "command", "meta", "super", "commandorcontrol"].includes(m)),
    ctrl: mods.some((m) => ["ctrl", "control"].includes(m)),
    shift: mods.includes("shift"),
    alt: mods.some((m) => ["alt", "option"].includes(m)),
    key,
  };
}

/// The character (or DOM key name) a named key reports in `e.key`, for
/// events that carry no key code.
const NAMED_KEY_CHARS: Record<string, string[]> = {
  Comma: [","],
  Period: ["."],
  Slash: ["/"],
  Backslash: ["\\"],
  BracketLeft: ["["],
  BracketRight: ["]"],
  Semicolon: [";"],
  Quote: ["'"],
  Backquote: ["`"],
  Minus: ["-"],
  Equal: ["="],
  Space: [" "],
  Enter: ["Enter"],
  Tab: ["Tab"],
  Backspace: ["Backspace"],
  Escape: ["Escape"],
  Up: ["ArrowUp"],
  Down: ["ArrowDown"],
  Left: ["ArrowLeft"],
  Right: ["ArrowRight"],
};

function codesForKey(key: string): string[] {
  if (/^[A-Z]$/i.test(key)) return [`Key${key.toUpperCase()}`];
  if (/^[0-9]$/.test(key)) return [`Digit${key}`, `Numpad${key}`];
  if (/^F\d{1,2}$/.test(key)) return [key];
  return NAMED_KEY_CODES[key] ?? [key];
}

function charsForKey(key: string): string[] {
  const named = NAMED_KEY_CHARS[key];
  if (named) return named;
  return [key.toUpperCase()];
}

export function eventMatchesShortcut(
  e: ShortcutKeyEvent,
  shortcut: string,
): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  if (
    parsed.meta !== e.metaKey ||
    parsed.ctrl !== e.ctrlKey ||
    parsed.shift !== e.shiftKey ||
    parsed.alt !== e.altKey
  ) {
    return false;
  }
  if (e.code && codesForKey(parsed.key).includes(e.code)) return true;
  // Fallback on the reported key: events without a code, and layouts where
  // the physical key doesn't carry the letter.
  return charsForKey(parsed.key).includes(
    e.key.length === 1 ? e.key.toUpperCase() : e.key,
  );
}
