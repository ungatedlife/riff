import { describe, expect, it } from "vitest";
import { eventMatchesShortcut, parseShortcut } from "./shortcutMatch";

function ev(partial: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string; key: string }>) {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    code: "",
    key: "",
    ...partial,
  };
}

describe("eventMatchesShortcut", () => {
  it("matches letters on the physical key regardless of case", () => {
    expect(eventMatchesShortcut(ev({ metaKey: true, shiftKey: true, code: "KeyP", key: "P" }), "Cmd+Shift+P")).toBe(true);
    expect(eventMatchesShortcut(ev({ metaKey: true, shiftKey: true, code: "KeyP", key: "p" }), "Cmd+Shift+P")).toBe(true);
  });

  it("requires the exact modifier set", () => {
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "KeyP", key: "p" }), "Cmd+Shift+P")).toBe(false);
    expect(eventMatchesShortcut(ev({ metaKey: true, shiftKey: true, altKey: true, code: "KeyP", key: "P" }), "Cmd+Shift+P")).toBe(false);
  });

  it("matches punctuation by key code, not the character the OS reports", () => {
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "Period", key: "." }), "Cmd+Period")).toBe(true);
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "Slash", key: "/" }), "Cmd+Slash")).toBe(true);
    // Option changes the character macOS reports ("÷"); the code still matches.
    expect(eventMatchesShortcut(ev({ metaKey: true, altKey: true, code: "Slash", key: "÷" }), "Cmd+Alt+Slash")).toBe(true);
  });

  it("falls back on the reported key when the event carries no code", () => {
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "", key: "." }), "Cmd+Period")).toBe(true);
    expect(eventMatchesShortcut(ev({ metaKey: true, shiftKey: true, code: "", key: "p" }), "Cmd+Shift+P")).toBe(true);
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "", key: "ArrowUp" }), "Cmd+Up")).toBe(true);
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "", key: "," }), "Cmd+Period")).toBe(false);
  });

  it("matches named keys and arrows", () => {
    expect(eventMatchesShortcut(ev({ metaKey: true, code: "ArrowUp", key: "ArrowUp" }), "Cmd+Up")).toBe(true);
    expect(eventMatchesShortcut(ev({ ctrlKey: true, code: "Space", key: " " }), "Ctrl+Space")).toBe(true);
  });

  it("parses hyper combos", () => {
    expect(parseShortcut("Cmd+Ctrl+Alt+Shift+R")).toEqual({ meta: true, ctrl: true, alt: true, shift: true, key: "R" });
  });
});
