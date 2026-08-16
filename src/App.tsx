import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PostIt from "./components/PostIt";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import { useTheme } from "./hooks/useTheme";
import type { StikSettings } from "@/types";
import { isMarkdownEffectivelyEmpty } from "@/utils/normalizeMarkdownForCopy";
import { shouldHideCaptureOnBlur } from "@/utils/blurAutoHide";
import { resolveCaptureFolder } from "@/utils/folderSelection";
import { useLanguageSync } from "@/hooks/useTranslation";

type WindowType = "main" | "settings" | "command-palette";

function getWindowInfo(): { type: WindowType } {
  const params = new URLSearchParams(window.location.search);
  const windowType = params.get("window");

  if (windowType === "settings") {
    return { type: "settings" };
  }

  if (
    windowType === "search" ||
    windowType === "manager" ||
    windowType === "command-palette"
  ) {
    return { type: "command-palette" };
  }

  return { type: "main" };
}

export default function App() {
  useTheme();
  useLanguageSync();
  const [currentFolder, setCurrentFolder] = useState("");
  const contentRef = useRef("");
  const blurIgnoreUntilRef = useRef(0);
  const pendingBlurHideRef = useRef<number | null>(null);
  const skipNextBlurHideRef = useRef(false);
  const windowInfo = getWindowInfo();

  const resolveFolder = useCallback(
    async (requestedFolder?: string, settingsFromEvent?: StikSettings) => {
      const folders = await invoke<string[]>("list_folders");
      const settings =
        settingsFromEvent ?? (await invoke<StikSettings>("get_settings"));
      return resolveCaptureFolder({
        requestedFolder: requestedFolder?.trim(),
        defaultFolder: settings.default_folder?.trim(),
        availableFolders: folders,
      });
    },
    [],
  );

  // Initialize the writing room with a valid folder (requested/default/fallback).
  useEffect(() => {
    if (windowInfo.type !== "main") return;

    let cancelled = false;

    const initialize = async () => {
      try {
        const folder = await resolveFolder();
        if (!cancelled) {
          setCurrentFolder(folder);
        }
      } catch {
        if (!cancelled) {
          setCurrentFolder("");
        }
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [windowInfo.type, resolveFolder]);

  // Hide the room on blur only when the editor is empty
  useEffect(() => {
    if (windowInfo.type !== "main") return;

    const handleFocus = () => {
      // Use Math.max so a focus event arriving after shortcut-triggered
      // never shortens the 500ms grace period down to 300ms.
      blurIgnoreUntilRef.current = Math.max(
        blurIgnoreUntilRef.current,
        Date.now() + 300,
      );
      if (pendingBlurHideRef.current !== null) {
        window.clearTimeout(pendingBlurHideRef.current);
        pendingBlurHideRef.current = null;
      }
    };
    window.addEventListener("focus", handleFocus);

    const unlisten = listen("main-blur", async () => {
      if (skipNextBlurHideRef.current) {
        skipNextBlurHideRef.current = false;
        return;
      }
      // The publish flow holds the window open through its confirm and
      // completion states even while the editor is empty.
      if (
        (window as unknown as { __riffHoldOpen?: boolean }).__riffHoldOpen
      ) {
        return;
      }
      if (pendingBlurHideRef.current !== null) {
        window.clearTimeout(pendingBlurHideRef.current);
      }
      pendingBlurHideRef.current = window.setTimeout(async () => {
        pendingBlurHideRef.current = null;

        const nowMs = Date.now();
        if (nowMs < blurIgnoreUntilRef.current) return;
        if (
          (window as unknown as { __riffHoldOpen?: boolean }).__riffHoldOpen
        ) {
          return;
        }

        const isFocused = await getCurrentWindow()
          .isFocused()
          .catch(() => false);
        if (isFocused) return;

        const shouldHide = shouldHideCaptureOnBlur({
          content: contentRef.current,
          nowMs,
          ignoreUntilMs: blurIgnoreUntilRef.current,
        });
        if (shouldHide) {
          await invoke("hide_window");
        }
      }, 140);
    });

    return () => {
      window.removeEventListener("focus", handleFocus);
      if (pendingBlurHideRef.current !== null) {
        window.clearTimeout(pendingBlurHideRef.current);
        pendingBlurHideRef.current = null;
      }
      unlisten.then((fn) => fn());
    };
  }, [windowInfo.type]);

  // Listen for shortcut triggers from Rust backend
  useEffect(() => {
    if (windowInfo.type !== "main") return;

    const unlisten = listen<string>("shortcut-triggered", (event) => {
      skipNextBlurHideRef.current = true;
      blurIgnoreUntilRef.current = Date.now() + 500;
      void resolveFolder(event.payload)
        .then(setCurrentFolder)
        .catch(() => {});
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [windowInfo.type, resolveFolder]);

  // Keep capture folder aligned with settings updates.
  useEffect(() => {
    if (windowInfo.type !== "main") return;

    const unlisten = listen<StikSettings>("settings-changed", (event) => {
      void resolveFolder(undefined, event.payload)
        .then(setCurrentFolder)
        .catch(() => {});
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [windowInfo.type, resolveFolder]);

  // Listen for settings shortcut (Cmd+Shift+,) and Cmd+K palette
  useEffect(() => {
    if (windowInfo.type !== "main") return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ",") {
        e.preventDefault();
        try {
          await invoke("open_settings");
        } catch (error) {
          console.error("Failed to open settings:", error);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [windowInfo.type]);

  const handleSave = useCallback(
    async (
      content: string,
      preferredFolder?: string,
    ): Promise<string | undefined> => {
      if (isMarkdownEffectivelyEmpty(content)) return undefined;

      const resolvedFolder = await resolveFolder(
        preferredFolder ?? currentFolder,
      );

      if (resolvedFolder !== currentFolder) {
        setCurrentFolder(resolvedFolder);
      }

      const result = await invoke<{ path: string }>("save_note", {
        folder: resolvedFolder,
        content,
      });
      return result.path || undefined;
    },
    [currentFolder, resolveFolder],
  );

  const handleClose = useCallback(async () => {
    try {
      await invoke("hide_window");
    } catch (error) {
      console.error("Failed to hide window:", error);
    }
  }, []);

  const handleFolderChange = useCallback((folder: string) => {
    setCurrentFolder(folder);
  }, []);

  const handleContentChange = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  const handleOpenSettings = useCallback(async () => {
    try {
      await invoke("open_settings");
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  }, []);

  if (windowInfo.type === "settings") {
    return <SettingsModal isOpen={true} onClose={() => {}} isWindow={true} />;
  }

  if (windowInfo.type === "command-palette") {
    return <CommandPalette />;
  }

  return (
    <PostIt
      folder={currentFolder}
      onSave={handleSave}
      onClose={handleClose}
      onFolderChange={handleFolderChange}
      onOpenSettings={handleOpenSettings}
      onContentChange={handleContentChange}
    />
  );
}
