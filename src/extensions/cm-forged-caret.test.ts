import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { forgedCaret, FORGED_CARET_LIVE_CLASS } from "./cm-forged-caret";

// jsdom has no matchMedia. The caret only reads `matches`, but CodeMirror's
// DOMObserver also subscribes via the legacy addListener/removeListener API.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountView(doc = "hello riff") {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [forgedCaret()] }),
    parent,
  });
  return { view, parent };
}

describe("forgedCaret", () => {
  it("mounts its caret element inside the scroller", () => {
    const { view, parent } = mountView();
    const caret = view.scrollDOM.querySelector(".forged-caret");
    expect(caret).not.toBeNull();
    expect(caret).toHaveAttribute("aria-hidden", "true");
    view.destroy();
    parent.remove();
  });

  it("survives focused typing without crashing out of the view", async () => {
    // The v0.2.0 caret died here: measure() ran layout reads synchronously
    // inside update(), CodeMirror threw "Reading the editor layout isn't
    // allowed during an update", logged "plugin crashed", and evicted the
    // plugin — leaving no caret at all. Guard against any recurrence.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { view, parent } = mountView();

    view.focus();
    view.dispatch({ changes: { from: 0, insert: "# " } });
    view.dispatch({ selection: { anchor: 2, head: 7 } }); // range selection
    view.dispatch({ selection: { anchor: 4 } }); // collapse again

    // Let CodeMirror run its scheduled measure cycle (RAF-based).
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const crashes = errorSpy.mock.calls.filter((args) =>
      args.some((a) => String(a).includes("plugin crashed")),
    );
    expect(crashes).toEqual([]);
    expect(view.scrollDOM.querySelector(".forged-caret")).not.toBeNull();

    errorSpy.mockRestore();
    view.destroy();
    parent.remove();
  });

  it("hides the native caret only while alive, restoring it on destroy", () => {
    const { view, parent } = mountView();
    const scroller = view.scrollDOM;
    expect(scroller.classList.contains(FORGED_CARET_LIVE_CLASS)).toBe(true);
    view.destroy();
    // The class is the only thing suppressing the native caret, so its
    // removal is what guarantees a crash can't leave the editor caretless.
    expect(scroller.classList.contains(FORGED_CARET_LIVE_CLASS)).toBe(false);
    expect(document.querySelector(".forged-caret")).toBeNull();
    parent.remove();
  });
});
