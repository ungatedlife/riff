interface BlurAutoHideInput {
  content: string;
  nowMs: number;
  ignoreUntilMs: number;
  /// Label of the Riff window that has focus now, or null when another app does.
  focusedRiffWindow?: string | null;
}

/// The room tucks itself away when the writer leaves it empty for another
/// app. It stays put under Riff's own Settings and Drafts windows — those
/// come back to the room when they close — and the quickie counts as
/// leaving, since a post-it doesn't need a fullscreen room behind it.
export function shouldHideCaptureOnBlur(input: BlurAutoHideInput): boolean {
  if (input.nowMs < input.ignoreUntilMs) return false;

  const focused = input.focusedRiffWindow ?? null;
  if (focused === "main") return false;
  if (focused === "settings" || focused === "command-palette") return false;

  return input.content.trim().length === 0;
}
