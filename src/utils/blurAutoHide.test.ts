import { describe, expect, it } from "vitest";
import { shouldHideCaptureOnBlur } from "./blurAutoHide";

describe("shouldHideCaptureOnBlur", () => {
  it("hides when empty and grace is inactive", () => {
    expect(
      shouldHideCaptureOnBlur({
        content: "   ",
        nowMs: 2000,
        ignoreUntilMs: 1000,
      })
    ).toBe(true);
  });

  it("does not hide while grace window is active", () => {
    expect(
      shouldHideCaptureOnBlur({
        content: "",
        nowMs: 1200,
        ignoreUntilMs: 1500,
      })
    ).toBe(false);
  });

  it("does not hide when there is meaningful content", () => {
    expect(
      shouldHideCaptureOnBlur({
        content: "hello",
        nowMs: 2000,
        ignoreUntilMs: 1000,
      })
    ).toBe(false);
  });

  it("stays put under Riff's own Settings and Drafts windows", () => {
    for (const label of ["settings", "command-palette", "main"]) {
      expect(
        shouldHideCaptureOnBlur({
          content: "",
          nowMs: 2000,
          ignoreUntilMs: 1000,
          focusedRiffWindow: label,
        })
      ).toBe(false);
    }
  });

  it("still hides an empty room when the quickie or another app takes over", () => {
    expect(
      shouldHideCaptureOnBlur({
        content: "",
        nowMs: 2000,
        ignoreUntilMs: 1000,
        focusedRiffWindow: "quickie",
      })
    ).toBe(true);
    expect(
      shouldHideCaptureOnBlur({
        content: "",
        nowMs: 2000,
        ignoreUntilMs: 1000,
        focusedRiffWindow: null,
      })
    ).toBe(true);
  });
});
