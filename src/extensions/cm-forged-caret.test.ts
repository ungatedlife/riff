import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { forgedCaret } from "./cm-forged-caret";

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

  it("survives typing and selection changes without layout (jsdom)", () => {
    const { view, parent } = mountView();
    view.dispatch({ changes: { from: 0, insert: "# " } });
    view.dispatch({ selection: { anchor: 2, head: 7 } }); // range selection
    view.dispatch({ selection: { anchor: 4 } }); // collapse again
    expect(view.scrollDOM.querySelector(".forged-caret")).not.toBeNull();
    view.destroy();
    parent.remove();
  });

  it("removes the caret element when the view is destroyed", () => {
    const { view, parent } = mountView();
    view.destroy();
    expect(document.querySelector(".forged-caret")).toBeNull();
    parent.remove();
  });
});
