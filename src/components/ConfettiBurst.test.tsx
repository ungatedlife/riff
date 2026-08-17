import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import ConfettiBurst from "./ConfettiBurst";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConfettiBurst", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }),
    );
  });

  it("fires onDone even when canvas is unavailable (jsdom)", () => {
    // jsdom's canvas.getContext returns null — the burst must not strand
    // the publish flow waiting on an animation that can never run.
    const onDone = vi.fn();
    render(<ConfettiBurst onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("skips the animation under prefers-reduced-motion, after a beat", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }),
    );
    const onDone = vi.fn();
    render(<ConfettiBurst onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
