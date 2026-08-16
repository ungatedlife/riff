interface BlurAutoHideInput {
  content: string;
  nowMs: number;
  ignoreUntilMs: number;
}

export function shouldHideCaptureOnBlur(input: BlurAutoHideInput): boolean {
  if (input.nowMs < input.ignoreUntilMs) return false;

  return input.content.trim().length === 0;
}
