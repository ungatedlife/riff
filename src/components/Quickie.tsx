import { useState, useEffect, useCallback, useRef } from "react";
import { completionStatus } from "@codemirror/autocomplete";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Editor, { type EditorRef } from "./Editor";
import { isMarkdownEffectivelyEmpty } from "@/utils/normalizeMarkdownForCopy";
import { useTranslation } from "@/hooks/useTranslation";

/// The quickie post-it: a fleeting thought, appended to the running note
/// in the vault. Esc or ⌘↩ captures; blur with nothing typed just hides.
export default function Quickie() {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<EditorRef | null>(null);
  const contentRef = useRef("");
  const isSavingRef = useRef(false);

  const handleChange = useCallback((content: string) => {
    contentRef.current = content;
    setError(null);
  }, []);

  const hideAndReset = useCallback(async () => {
    contentRef.current = "";
    editorRef.current?.clear();
    setError(null);
    await invoke("hide_window").catch(() => {});
  }, []);

  const capture = useCallback(async () => {
    if (isSavingRef.current) return;
    const content = contentRef.current;

    if (isMarkdownEffectivelyEmpty(content)) {
      await hideAndReset();
      return;
    }

    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await invoke("append_quickie", { content });
      setTimeout(async () => {
        setIsSaving(false);
        isSavingRef.current = false;
        await hideAndReset();
      }, 350);
    } catch (err) {
      console.error("Failed to capture quickie:", err);
      setIsSaving(false);
      isSavingRef.current = false;
      setError(String(err));
      if (String(err).includes("No quickies note")) {
        void invoke("open_settings");
      }
    }
  }, [hideAndReset]);

  // Escape captures (or just hides when there's nothing to capture)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      const view = editorRef.current?.getView();
      const status = view ? completionStatus(view.state) : null;
      if (status === "active" || status === "pending") return; // CM closes it
      void capture();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [capture]);

  // Focus the editor on summon
  useEffect(() => {
    const unlisten = listen("quickie-summoned", () => {
      setTimeout(() => editorRef.current?.focus(), 80);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Hide on blur when empty
  useEffect(() => {
    const unlisten = listen("quickie-blur", () => {
      if (isSavingRef.current) return;
      window.setTimeout(async () => {
        if (isSavingRef.current) return;
        const isFocused = await getCurrentWindow()
          .isFocused()
          .catch(() => false);
        if (isFocused) return;
        if (isMarkdownEffectivelyEmpty(contentRef.current)) {
          await invoke("hide_window").catch(() => {});
        }
      }, 140);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Re-focus the editor whenever the window regains OS focus
  useEffect(() => {
    const onFocus = () => {
      if (isSavingRef.current) return;
      setTimeout(() => editorRef.current?.focus(), 50);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const startDrag = useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.error("Failed to start drag:", err);
    }
  }, []);

  if (isSaving) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg rounded-[14px] border-t-2 border-coral">
        <svg
          className="save-checkmark text-coral"
          viewBox="0 0 52 52"
          width="28"
          height="28"
        >
          <circle
            className="save-circle"
            cx="26"
            cy="26"
            r="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="save-check"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 26l7 7 15-15"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className="w-full h-full rounded-[14px] overflow-hidden flex flex-col bg-bg border-t-2 border-coral">
      {/* Compact header — the coral top edge + label mark this as the quickie */}
      <div
        onMouseDown={startDrag}
        className="flex items-center justify-between px-3 py-1.5 border-b border-line drag-handle"
      >
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-stone uppercase tracking-wider">
          <span className="text-coral text-[8px]">●</span>
          {t("quickie.title")}
        </span>
        <button
          onClick={() => void capture()}
          className="px-2 py-1 rounded-md text-[10px] font-semibold bg-coral-light text-coral hover:bg-coral hover:text-white transition-colors"
          title={t("quickie.captureHint")}
        >
          {t("common.esc")}
        </button>
      </div>

      {/* Editor — plain and quick: no toolbar, fixed compact type */}
      <div
        className="flex-1 relative overflow-hidden min-h-0"
        style={{ "--editor-font-size": "14px" } as React.CSSProperties}
      >
        <Editor
          ref={editorRef}
          onChange={handleChange}
          placeholder={t("quickie.placeholder")}
          showFormatToolbar={false}
          onPublish={() => void capture()}
        />
      </div>

      {error && (
        <div className="px-3 py-1.5 border-t border-line text-[10px] text-coral truncate">
          {error}
        </div>
      )}
    </div>
  );
}
