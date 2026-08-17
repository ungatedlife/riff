import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { completionStatus } from "@codemirror/autocomplete";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import Editor, { type EditorRef } from "./Editor";
import type { RiffSettings } from "@/types";
import {
  isMarkdownEffectivelyEmpty,
  normalizeMarkdownForCopy,
} from "@/utils/normalizeMarkdownForCopy";
import { shouldSaveOnGlobalEscape } from "@/utils/captureEscape";
import { markdownToPlainText } from "@/utils/markdownToHtml";
import {
  resolveImagePaths,
  unresolveImagePaths,
} from "@/utils/imageMarkdownPaths";
import { formatShortcutDisplay } from "./ShortcutRecorder";
import { loadGoogleFont, loadCustomFont } from "@/utils/fonts";
import { useTranslation } from "@/hooks/useTranslation";

interface WritingRoomProps {
  onSave: (content: string) => Promise<string | undefined | void>;
  onClose: () => void;
  onOpenSettings?: () => void;
  onContentChange?: (content: string) => void;
}

function fallbackHtmlFromPlainText(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<pre>${escaped}</pre>`;
}

type CopyMode = "markdown" | "rich";

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onDone, 200);
    }, 1800);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className={`
        fixed bottom-6 left-1/2 -translate-x-1/2 z-[250]
        px-4 py-2.5 rounded-xl shadow-riff
        text-[13px] font-medium bg-ink text-bg
        transition-all duration-200 ease-out
        ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}
      `}
    >
      {message}
    </div>
  );
}

export default function WritingRoom({
  onSave,
  onClose,
  onOpenSettings,
  onContentChange,
}: WritingRoomProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  // Path of the draft currently loaded into the room; null = fresh riff.
  const [currentDraftPath, setCurrentDraftPath] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [publishState, setPublishState] = useState<
    "idle" | "confirm" | "publishing" | "done"
  >("idle");
  const [pendingTitle, setPendingTitle] = useState("");
  const [vaultDir, setVaultDir] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(16);
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [windowOpacity, setWindowOpacity] = useState(1.0);
  const [customFonts, setCustomFonts] = useState<
    import("@/types").CustomFontEntry[]
  >([]);
  const [systemShortcuts, setSystemShortcuts] = useState<
    Record<string, string>
  >({});
  const [textDirection, setTextDirection] = useState<"auto" | "ltr" | "rtl">(
    "auto",
  );
  const [zenMode, setZenMode] = useState(false);
  const [formatToolbar, setFormatToolbar] = useState(() => {
    try {
      return localStorage.getItem("riff:format-toolbar") !== "0";
    } catch {
      return true;
    }
  });
  const editorRef = useRef<EditorRef | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef(content);
  const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCursorRef = useRef<{ head: number; anchor: number } | null>(
    null,
  );
  // Suppresses cursor saves until the restore completes — prevents the initial
  // selection at (0,0) from overwriting the previously saved position.
  const isRestoringCursorRef = useRef(true);

  // Cursor positions persist per draft file path.
  const cursorPosKey = currentDraftPath;

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Flush pending cursor save on unmount (don't lose position if closed within debounce window)
  useEffect(() => {
    return () => {
      if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
      if (pendingCursorRef.current && cursorPosKey) {
        const { head, anchor } = pendingCursorRef.current;
        invoke("save_cursor_position", {
          id: cursorPosKey,
          head,
          anchor,
        }).catch(() => {});
      }
    };
  }, [cursorPosKey]);

  // Apply font family: load from custom fonts or Google Fonts, then update the CSS var.
  useEffect(() => {
    if (!fontFamily) {
      document.documentElement.style.setProperty(
        "--editor-font-family",
        "inherit",
      );
      return;
    }
    const customEntry = customFonts.find((f) => f.name === fontFamily);
    if (customEntry) {
      // Custom local font — load async, apply once ready
      loadCustomFont(customEntry.name, customEntry.path).then((ok) => {
        if (ok) {
          document.documentElement.style.setProperty(
            "--editor-font-family",
            `"${fontFamily}", sans-serif`,
          );
        }
      });
    } else {
      loadGoogleFont(fontFamily);
      document.documentElement.style.setProperty(
        "--editor-font-family",
        `"${fontFamily}", sans-serif`,
      );
    }
  }, [fontFamily, customFonts]);

  // Load a draft into the room when the backend asks for it (palette,
  // wiki-link jump, Cmd+Shift+L, or a Finder-opened file).
  useEffect(() => {
    const unlisten = listen<{ path: string; content: string }>(
      "open-draft",
      (event) => {
        const { path, content: draftContent } = event.payload;
        const noteDir = path.substring(0, path.lastIndexOf("/"));
        const resolved = resolveImagePaths(
          draftContent,
          noteDir,
          convertFileSrc,
        );
        setCurrentDraftPath(path);
        setContent(draftContent);
        contentRef.current = draftContent;
        onContentChange?.(draftContent);
        setTimeout(() => {
          editorRef.current?.setContent(resolved);
          editorRef.current?.focus();
          invoke<{ head: number; anchor: number } | null>(
            "get_cursor_position",
            { id: path },
          )
            .then((pos) => {
              if (pos) editorRef.current?.setCursor(pos.head, pos.anchor);
            })
            .catch(() => {});
        }, 80);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onContentChange]);

  // If the open draft is deleted elsewhere (e.g. from the palette), reset the room.
  useEffect(() => {
    const unlisten = listen<string>("note-deleted", (event) => {
      if (currentDraftPath && event.payload === currentDraftPath) {
        setCurrentDraftPath(null);
        setContent("");
        contentRef.current = "";
        onContentChange?.("");
        editorRef.current?.clear();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [currentDraftPath, onContentChange]);

  // Fetch vim mode + folder colors + folder list on mount + listen for changes
  useEffect(() => {
    invoke<RiffSettings>("get_settings")
      .then((s) => {
        setFontSize(s.font_size ?? 16);
        setFontFamily(s.font_family ?? null);
        setWindowOpacity(s.window_opacity ?? 1.0);
        setCustomFonts(s.custom_fonts ?? []);
        setSystemShortcuts(s.system_shortcuts ?? {});
        setVaultDir(s.vault_dir ?? null);
        setTextDirection(
          (s.text_direction as "auto" | "ltr" | "rtl") || "auto",
        );
        setSettingsLoaded(true);
      })
      .catch(() => {
        setSettingsLoaded(true);
      });

    const unlisten = listen<RiffSettings>("settings-changed", (event) => {
      setFontSize(event.payload.font_size ?? 16);
      setFontFamily(event.payload.font_family ?? null);
      setWindowOpacity(event.payload.window_opacity ?? 1.0);
      setCustomFonts(event.payload.custom_fonts ?? []);
      setSystemShortcuts(event.payload.system_shortcuts ?? {});
      setVaultDir(event.payload.vault_dir ?? null);
      setTextDirection(
        (event.payload.text_direction as "auto" | "ltr" | "rtl") || "auto",
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Focus editor on mount, or when it becomes available after settings load
  useEffect(() => {
    if (!settingsLoaded) return; // editor not mounted yet
    setTimeout(() => editorRef.current?.focus(), 100);
  }, [settingsLoaded]);

  // Flush pending cursor save immediately (used on blur / before close)
  const flushCursorSave = useCallback(() => {
    if (!pendingCursorRef.current || !cursorPosKey) return;
    const { head, anchor } = pendingCursorRef.current;
    pendingCursorRef.current = null;
    if (cursorSaveTimerRef.current) {
      clearTimeout(cursorSaveTimerRef.current);
      cursorSaveTimerRef.current = null;
    }
    invoke("save_cursor_position", { id: cursorPosKey, head, anchor }).catch(
      () => {},
    );
  }, [cursorPosKey]);

  // Debounced cursor position save — 500ms after last cursor movement
  const handleCursorChange = useCallback(
    (head: number, anchor: number) => {
      if (isRestoringCursorRef.current) return;
      pendingCursorRef.current = { head, anchor };
      if (!cursorPosKey) return;
      if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
      cursorSaveTimerRef.current = setTimeout(() => {
        pendingCursorRef.current = null;
        invoke("save_cursor_position", {
          id: cursorPosKey,
          head,
          anchor,
        }).catch(() => {});
      }, 500);
    },
    [cursorPosKey],
  );

  // Save cursor position on window blur — fires reliably before close/hide
  useEffect(() => {
    if (!cursorPosKey) return;
    const onBlur = () => flushCursorSave();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [cursorPosKey, flushCursorSave]);

  // Restore cursor position after editor mounts and content loads.
  // isRestoringCursorRef stays true until this completes, suppressing saves so
  // the initial (0,0) selection from editor mount can't overwrite the real position.
  useEffect(() => {
    if (!settingsLoaded || !cursorPosKey) {
      // No restore needed (fresh riff or editor not ready yet) — unsuppress immediately
      isRestoringCursorRef.current = false;
      return;
    }
    isRestoringCursorRef.current = true;
    const timer = setTimeout(() => {
      invoke<{ head: number; anchor: number } | null>("get_cursor_position", {
        id: cursorPosKey,
      })
        .then((pos) => {
          if (pos) editorRef.current?.setCursor(pos.head, pos.anchor);
        })
        .catch(() => {})
        .finally(() => {
          isRestoringCursorRef.current = false;
        });
    }, 50);
    return () => {
      clearTimeout(timer);
      isRestoringCursorRef.current = false;
    };
  }, [settingsLoaded, cursorPosKey]);

  // New shortcut-triggered session: detach from any open draft when the
  // editor is empty (fresh riff).
  useEffect(() => {
    const unlisten = listen("shortcut-triggered", () => {
      if (isMarkdownEffectivelyEmpty(contentRef.current)) {
        setCurrentDraftPath(null);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Re-focus editor when window regains focus (e.g. after hide/show cycle).
  // NOTE: Do NOT call clearTransientSlashQuery here — the OS focus event
  // delivery is nondeterministic and can arrive AFTER the user has already
  // typed into the new session, clearing their input. Stale slash queries
  // are cleaned up by the shortcut-triggered handler (new session) and by
  // the blur-auto-hide logic in App.tsx (empty/slash content → hide window).
  useEffect(() => {
    const handleWindowFocus = () => {
      if (isSaving) return;
      setTimeout(() => editorRef.current?.focus(), 50);
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [isSaving]);

  // Slash-query state is cleared on new sessions via shortcut-triggered
  // and on save via handleSaveAndClose. No separate postit-blur listener
  // needed — it caused a race where a delayed blur during reopen would
  // clear content the user just typed.

  // Read live content from the editor — doc.toString() is the source of truth
  // (unaffected by Decoration.replace widgets). Falls back to contentRef if
  // the editor is unmounted.
  const getLiveContent = useCallback((): string => {
    const view = editorRef.current?.getView();
    if (view) {
      return unresolveImagePaths(view.state.doc.toString());
    }
    return contentRef.current;
  }, []);

  const handleSaveAndClose = useCallback(async () => {
    const currentContent = getLiveContent();
    if (isMarkdownEffectivelyEmpty(currentContent)) {
      // An emptied draft is deleted on close (update_note removes empty notes).
      if (currentDraftPath) {
        await invoke("update_note", {
          path: currentDraftPath,
          content: currentContent,
        }).catch(() => {});
      }
      flushSync(() => {
        setContent("");
        onContentChange?.("");
      });
      editorRef.current?.clear();
      contentRef.current = "";
      setCurrentDraftPath(null);
      await onClose();
      return;
    }

    try {
      setIsSaving(true);
      let savedPath: string | undefined;
      if (currentDraftPath) {
        await invoke("update_note", {
          path: currentDraftPath,
          content: currentContent,
        });
        savedPath = currentDraftPath;
      } else {
        savedPath = (await onSave(currentContent)) || undefined;
      }

      // Save cursor position under the note's file path so Cmd+Shift+L
      // can restore it when reopening the draft.
      if (savedPath && pendingCursorRef.current) {
        const { head, anchor } = pendingCursorRef.current;
        invoke("save_cursor_position", { id: savedPath, head, anchor }).catch(
          () => {},
        );
      }

      setTimeout(async () => {
        setIsSaving(false);
        setContent("");
        onContentChange?.("");
        editorRef.current?.clear();
        setCurrentDraftPath(null);
        await onClose();
      }, 600);
    } catch (error) {
      console.error("Failed to save note:", error);
      setIsSaving(false);
      setToast(t("postit.saveFailed"));
    }
  }, [currentDraftPath, onSave, onClose, onContentChange, getLiveContent]);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  // Handle escape to save and close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (publishState !== "idle") return; // publish flow owns the keys

      const target = e.target as Element | null;
      const inLinkPopover = Boolean(target?.closest(".link-popover"));
      if (inLinkPopover) return;

      const view = editorRef.current?.getView();
      const autocompleteStatus = view ? completionStatus(view.state) : null;
      const isAutocompleteOpen =
        autocompleteStatus === "active" || autocompleteStatus === "pending";

      if (isCopyMenuOpen) {
        e.preventDefault();
        setIsCopyMenuOpen(false);
        return;
      }

      if (
        shouldSaveOnGlobalEscape({
          defaultPrevented: e.defaultPrevented,
          inLinkPopover,
          isCopyMenuOpen,
          isAutocompleteOpen,
          showPicker: false,
          isSaving,
          isPinning: false,
        })
      ) {
        handleSaveAndClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSaving, isCopyMenuOpen, publishState, handleSaveAndClose]);

  // Zen mode shortcut (reads from settings, defaults to Cmd+.)
  useEffect(() => {
    const shortcutStr = systemShortcuts.zen_mode || "Cmd+Period";
    const handleZenToggle = (e: KeyboardEvent) => {
      const parts = shortcutStr.split("+");
      const key = parts[parts.length - 1];
      const needsMeta = parts.some(
        (p) => p === "Cmd" || p === "Command" || p === "Meta",
      );
      const needsShift = parts.some((p) => p === "Shift");
      const needsAlt = parts.some((p) => p === "Alt" || p === "Option");
      const needsCtrl = parts.some((p) => p === "Ctrl" || p === "Control");

      if (needsMeta !== e.metaKey) return;
      if (needsShift !== e.shiftKey) return;
      if (needsAlt !== e.altKey) return;
      if (needsCtrl !== e.ctrlKey) return;

      // Match the key portion
      const eventKey =
        e.key === "." ? "Period" : e.key === "," ? "Comma" : e.key;
      if (eventKey.toLowerCase() !== key.toLowerCase()) return;

      e.preventDefault();
      setZenMode((prev) => !prev);
    };
    window.addEventListener("keydown", handleZenToggle);
    return () => window.removeEventListener("keydown", handleZenToggle);
  }, [systemShortcuts.zen_mode]);

  // CMD+/CMD-/CMD+0 to adjust editor font size
  useEffect(() => {
    const handleZoom = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;

      let newSize: number | null = null;
      if (e.key === "=" || e.key === "+") {
        newSize = Math.min(fontSize + 1, 48);
      } else if (e.key === "-") {
        newSize = Math.max(fontSize - 1, 12);
      } else if (e.key === "0") {
        newSize = 16;
      }

      if (newSize !== null && newSize !== fontSize) {
        e.preventDefault();
        setFontSize(newSize);
        invoke<RiffSettings>("get_settings")
          .then((s) =>
            invoke("save_settings", { settings: { ...s, font_size: newSize } }),
          )
          .then(() => invoke<RiffSettings>("get_settings"))
          .then((s) => getCurrentWindow().emit("settings-changed", s))
          .catch(() => {});
      } else if (newSize !== null) {
        e.preventDefault(); // still prevent browser zoom at boundaries
      }
    };

    window.addEventListener("keydown", handleZoom);
    return () => window.removeEventListener("keydown", handleZoom);
  }, [fontSize]);

  useEffect(() => {
    if (!isCopyMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        copyMenuRef.current &&
        !copyMenuRef.current.contains(event.target as Node)
      ) {
        setIsCopyMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [isCopyMenuOpen]);

  const copyPlainTextViaTextarea = useCallback((plainText: string): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = plainText;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);

    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  }, []);

  const copyPlainText = useCallback(
    async (plainText: string): Promise<boolean> => {
      if (copyPlainTextViaTextarea(plainText)) {
        return true;
      }
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(plainText);
        return true;
      }
      return false;
    },
    [copyPlainTextViaTextarea],
  );

  const handleCopy = useCallback(
    async (mode: CopyMode) => {
      if (isCopying) return;
      if (isMarkdownEffectivelyEmpty(content)) {
        setIsCopyMenuOpen(false);
        showToast(t("postit.nothingToCopy"));
        return;
      }

      flushSync(() => {
        setIsCopying(true);
        setIsCopyMenuOpen(false);
      });

      try {
        if (mode === "rich") {
          const htmlText =
            editorRef.current?.getHTML()?.trim() ||
            fallbackHtmlFromPlainText(content);
          const plainText = markdownToPlainText(
            editorRef.current?.getText()?.trim() || content,
          );

          // Write directly to native macOS clipboard via Rust/arboard.
          // Browser clipboard APIs (ClipboardItem, execCommand) are unreliable
          // in Tauri's WKWebView — HTML MIME type often doesn't land.
          await invoke("copy_rich_text_to_clipboard", {
            html: htmlText,
            plainText,
          });

          showToast(t("postit.copiedRichText"));
        } else {
          const markdownText = normalizeMarkdownForCopy(content);
          const copied = await copyPlainText(markdownText);
          if (!copied) {
            throw new Error(t("postit.markdownCopyFailed"));
          }
          showToast(t("postit.copiedMarkdown"));
        }
      } catch (error) {
        console.error("Failed to copy note:", error);
        showToast(t("postit.copyFailed"));
      } finally {
        setIsCopying(false);
      }
    },
    [content, isCopying, copyPlainText, showToast],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      const stored = unresolveImagePaths(newContent);
      setContent(stored);
      contentRef.current = stored;
      onContentChange?.(stored);
    },
    [],
  );

  // ── Publish ritual ────────────────────────────────────────────────

  // Hold the window open while confirming/publishing — the room otherwise
  // auto-hides on blur once the editor empties.
  useEffect(() => {
    (window as unknown as { __riffHoldOpen?: boolean }).__riffHoldOpen =
      publishState !== "idle";
    return () => {
      (window as unknown as { __riffHoldOpen?: boolean }).__riffHoldOpen =
        false;
    };
  }, [publishState]);

  const requestPublish = useCallback(() => {
    const currentContent = getLiveContent();
    if (isMarkdownEffectivelyEmpty(currentContent)) {
      showToast(t("publish.nothing"));
      return;
    }
    if (!vaultDir) {
      showToast(t("publish.noVault"));
      void invoke("open_settings");
      return;
    }
    const firstLine =
      currentContent.split("\n").find((l) => l.trim().length > 0) ?? "";
    setPendingTitle(
      firstLine
        .replace(/^#+\s*/, "")
        .replace(/[*_`~=]/g, "")
        .trim(),
    );
    setPublishState("confirm");
  }, [getLiveContent, vaultDir, showToast, t]);

  const confirmPublish = useCallback(async () => {
    const currentContent = getLiveContent();
    setPublishState("publishing");
    try {
      let path = currentDraftPath;
      if (path) {
        await invoke("update_note", { path, content: currentContent });
      } else {
        const saved = (await onSave(currentContent)) || undefined;
        path = saved ?? null;
      }
      if (!path) {
        throw new Error("Could not save the draft before publishing");
      }

      const info = await invoke<{ title: string }>("publish_riff", { path });
      setPendingTitle(info.title);
      setPublishState("done");

      setTimeout(async () => {
        setContent("");
        contentRef.current = "";
        onContentChange?.("");
        editorRef.current?.clear();
        setCurrentDraftPath(null);
        setPublishState("idle");
        await onClose();
      }, 1100);
    } catch (error) {
      console.error("Failed to publish riff:", error);
      setPublishState("idle");
      showToast(String(error));
    }
  }, [
    currentDraftPath,
    getLiveContent,
    onSave,
    onClose,
    onContentChange,
    showToast,
  ]);

  // Keys for the confirm overlay: Enter/⌘↩ publishes, Escape keeps riffing.
  useEffect(() => {
    if (publishState !== "confirm") return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void confirmPublish();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPublishState("idle");
        setTimeout(() => editorRef.current?.focus(), 50);
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [publishState, confirmPublish]);

  const startDrag = useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.error("Failed to start drag:", err);
    }
  }, []);

  // Save window size + position on resize/move
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    let unlistenResize: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;

    const saveGeometry = async () => {
      try {
        const win = getCurrentWindow();
        const scaleFactor = await win.scaleFactor();
        const size = await win.innerSize();
        const position = await win.outerPosition();
        await invoke("save_window_geometry", {
          width: size.width / scaleFactor,
          height: size.height / scaleFactor,
          x: position.x,
          y: position.y,
        });
      } catch (error) {
        console.error("Failed to save window geometry:", error);
      }
    };

    const debounced = () => {
      clearTimeout(timeout);
      timeout = setTimeout(saveGeometry, 500);
    };

    getCurrentWindow()
      .onResized(() => debounced())
      .then((fn) => {
        unlistenResize = fn;
      });
    getCurrentWindow()
      .onMoved(() => debounced())
      .then((fn) => {
        unlistenMoved = fn;
      });

    return () => {
      unlistenResize?.();
      unlistenMoved?.();
      clearTimeout(timeout);
    };
  }, []);

  // Handle wiki-link click: save the current riff, then load the target
  // into the room.
  const handleWikiLinkClick = useCallback(
    async (_slug: string, path: string) => {
      if (!path) return;
      try {
        const currentContent = getLiveContent();
        if (!isMarkdownEffectivelyEmpty(currentContent)) {
          if (currentDraftPath) {
            await invoke("update_note", {
              path: currentDraftPath,
              content: currentContent,
            });
          } else {
            await onSave(currentContent);
          }
        }
        await invoke("open_draft", { path });
      } catch (error) {
        console.error("Failed to open wiki-linked note:", error);
      }
    },
    [currentDraftPath, getLiveContent, onSave],
  );

  // Handle image paste/drop: save to disk and return asset URL for the editor
  const handleImagePaste = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const [absPath] = await invoke<[string, string]>("save_note_image", {
          imageData: base64,
        });

        return convertFileSrc(absPath);
      } catch (err) {
        console.error("Failed to save image:", err);
        return null;
      }
    },
    [],
  );

  const handleImageDropPath = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        const [absPath] = await invoke<[string, string]>(
          "save_note_image_from_path",
          {
            filePath: path,
          },
        );

        return convertFileSrc(absPath);
      } catch (err) {
        console.error("Failed to import dropped image:", err);
        return null;
      }
    },
    [],
  );

  // Show save animation
  if (isSaving) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg rounded-[14px]">
        <div className="flex flex-col items-center gap-3">
          <svg
            className="save-checkmark text-coral"
            viewBox="0 0 52 52"
            width="40"
            height="40"
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
          <p className="save-text text-coral font-semibold text-sm">{t("common.saved")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`relative w-full h-full rounded-[14px] overflow-hidden flex flex-col ${
          zenMode ? "zen-mode" : ""
        }`}
        style={{ backgroundColor: `rgb(var(--color-bg) / ${windowOpacity})` }}
      >
        {/* Header - draggable */}
        <div
          onMouseDown={startDrag}
          className="flex items-center justify-between px-4 py-2.5 border-b border-line drag-handle"
        >
          {!zenMode && (
            <>
              <div className="flex items-center gap-2" />

              <div
                data-capture-hide
                className="flex items-center gap-3 text-[10px] text-stone"
              >
                <div className="relative" ref={copyMenuRef}>
                  <button
                    onClick={() => setIsCopyMenuOpen((open) => !open)}
                    className={`p-1 rounded-md transition-colors ${
                      isCopyMenuOpen
                        ? "text-coral bg-coral-light"
                        : "text-stone hover:bg-line hover:text-ink"
                    }`}
                    title={t("postit.actions")}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle cx="7" cy="3" r="1.2" fill="currentColor" />
                      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
                      <circle cx="7" cy="11" r="1.2" fill="currentColor" />
                    </svg>
                  </button>

                  {isCopyMenuOpen && (
                    <div className="absolute top-full right-0 mt-1 w-40 rounded-lg border border-line bg-bg shadow-riff overflow-hidden z-[240]">
                      <button
                        onClick={() => void handleCopy("rich")}
                        className="w-full px-3 py-2 text-left text-[11px] text-ink hover:bg-line/50 transition-colors"
                      >
                        {t("postit.copyRichText")}
                      </button>
                      <button
                        onClick={() => void handleCopy("markdown")}
                        className="w-full px-3 py-2 text-left text-[11px] text-ink hover:bg-line/50 transition-colors"
                      >
                        {t("postit.copyMarkdown")}
                      </button>
                    </div>
                  )}
                </div>

                <button
                  onClick={requestPublish}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-coral text-white hover:bg-coral/90 cursor-pointer"
                  title={t("publish.action")}
                >
                  {t("publish.button")} ⌘↩
                </button>
                <button
                  onClick={handleSaveAndClose}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-coral-light text-coral hover:bg-coral hover:text-white cursor-pointer"
                  title={t("postit.saveAndClose")}
                >
                  {t("common.esc")}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Editor */}
        <div
          className="flex-1 relative overflow-hidden min-h-0"
          style={
            { "--editor-font-size": `${fontSize}px` } as React.CSSProperties
          }
        >
          {!settingsLoaded ? (
            <div className="h-full" /> // placeholder while settings load
          ) : (
            <Editor
              key={textDirection}
              ref={editorRef}
              onChange={handleContentChange}
              placeholder={t("postit.typePlaceholder")}
              showFormatToolbar={zenMode ? false : formatToolbar}
              textDirection={textDirection}
              onPublish={requestPublish}
              onImagePaste={handleImagePaste}
              onImageDropPath={handleImageDropPath}
              onWikiLinkClick={handleWikiLinkClick}
              onCursorChange={handleCursorChange}
            />
          )}
        </div>

        {/* Footer - draggable */}
        {!zenMode && (
            <div
              onMouseDown={startDrag}
              className="flex items-center justify-between px-4 py-2 border-t border-line text-[10px] drag-handle"
            >
              <span className="flex items-center gap-2 font-mono text-stone">
                <span>
                  <span className="text-coral">~</span>/Riff/
                </span>
              </span>
              <div className="flex items-center gap-2">
                <span className="text-stone">
                  <span className="text-coral">✦</span>  {t("postit.markdownSupported")}
                </span>
                {onOpenSettings && (
                  <span data-capture-hide className="contents">
                    <button
                      onClick={() => {
                        const next = !formatToolbar;
                        setFormatToolbar(next);
                        try {
                          localStorage.setItem(
                            "riff:format-toolbar",
                            next ? "1" : "0",
                          );
                        } catch {}
                      }}
                      className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                        formatToolbar
                          ? "text-coral hover:bg-coral-light"
                          : "text-stone hover:bg-line hover:text-ink"
                      }`}
                      title={
                        formatToolbar
                          ? t("postit.hideFormatButtons")
                          : t("postit.showFormatButtons")
                      }
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 7V4h16v3" />
                        <path d="M9 20h6" />
                        <path d="M12 4v16" />
                      </svg>
                    </button>
                    <button
                      onClick={() => invoke("open_command_palette")}
                      className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-line text-stone hover:text-ink transition-colors"
                      title={`${t("postit.commandPalette")} (${formatShortcutDisplay(systemShortcuts.search || "Cmd+Shift+P")})`}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    </button>
                    <button
                      onClick={() => onOpenSettings?.()}
                      className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-line text-stone hover:text-ink transition-colors"
                      title={`Settings (${formatShortcutDisplay(systemShortcuts.settings || "Cmd+Shift+Comma")})`}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                  </span>
                )}
              </div>
            </div>
        )}

        {/* Publish overlay: confirm → publishing → done */}
        {publishState !== "idle" && (
          <div className="absolute inset-0 z-[220] flex items-center justify-center rounded-[14px] bg-bg/90 backdrop-blur-sm">
            {publishState === "done" ? (
              <div className="flex flex-col items-center gap-3 px-6 text-center">
                <svg
                  className="save-checkmark text-coral"
                  viewBox="0 0 52 52"
                  width="40"
                  height="40"
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
                <p className="save-text text-coral font-semibold text-sm">
                  {t("publish.done")}
                </p>
                <p className="text-stone text-xs max-w-[340px] truncate">
                  {pendingTitle}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 text-center">
                <p className="text-ink text-sm font-semibold max-w-[380px] truncate">
                  {pendingTitle || t("publish.button")}
                </p>
                {publishState === "publishing" ? (
                  <p className="text-stone text-xs animate-pulse">
                    {t("publish.publishing")}
                  </p>
                ) : (
                  <p className="text-stone text-xs">
                    {t("publish.confirmHint")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}
