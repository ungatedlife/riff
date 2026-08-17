import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NoteInfo, SearchResult } from "@/types";
import {
  extractNoteTitle,
  normalizeNoteSnippet,
} from "@/utils/notePresentation";
import ConfirmDialog from "./ConfirmDialog";
import NoteList from "./command-palette/NoteList";
import { useTranslation } from "@/hooks/useTranslation";

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onDone, 200);
    }, 2000);
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

export default function CommandPalette() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentNotes, setRecentNotes] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<SearchResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const loadRecent = useCallback(async () => {
    const notes = await invoke<NoteInfo[]>("list_notes");
    setRecentNotes(
      notes.slice(0, 15).map((n) => ({
        path: n.path,
        filename: n.filename,
        title: extractNoteTitle(n.content),
        snippet: normalizeNoteSnippet(n.content),
        created: n.created,
      })),
    );
  }, []);

  useEffect(() => {
    loadRecent().catch((error) => {
      console.error("Failed to load drafts:", error);
    });
  }, [loadRecent]);

  // Search (debounced); empty query shows recent drafts
  useEffect(() => {
    if (!query.trim()) {
      setResults(recentNotes);
      setSelectedIndex(0);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const textResults = await invoke<SearchResult[]>("search_notes", {
        query: query.trim(),
      }).catch(() => [] as SearchResult[]);
      setResults(textResults);
      setSelectedIndex(0);
      setIsSearching(false);
    }, 200);

    return () => clearTimeout(timer);
  }, [query, recentNotes]);

  // Scroll selected note into view
  useEffect(() => {
    if (resultsRef.current) {
      const items = resultsRef.current.querySelectorAll<HTMLElement>("button");
      if (items[selectedIndex]) {
        items[selectedIndex].scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  const closePalette = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      await invoke("hide_window");
    }
  }, []);

  const openNote = useCallback(
    async (result: SearchResult) => {
      try {
        await invoke("open_draft", { path: result.path });
        closePalette();
      } catch (error) {
        console.error("Failed to open note:", error);
        setToast(`Couldn't open note: ${String(error)}`);
      }
    },
    [closePalette],
  );

  const refreshAfterChange = useCallback(async () => {
    await loadRecent();

    if (query.trim()) {
      const searchResults = await invoke<SearchResult[]>("search_notes", {
        query: query.trim(),
      }).catch(() => [] as SearchResult[]);
      setResults(searchResults);
      setSelectedIndex((i) => Math.max(0, Math.min(i, searchResults.length - 1)));
    }
  }, [loadRecent, query]);

  // Refresh when files change externally (file watcher, saves from the room)
  useEffect(() => {
    const unlistenFiles = listen("files-changed", () => {
      refreshAfterChange();
    });
    return () => {
      unlistenFiles.then((fn) => fn());
    };
  }, [refreshAfterChange]);

  const handleDeleteNote = useCallback(
    async (note: SearchResult) => {
      try {
        await invoke("delete_note", { path: note.path });
        setConfirmDelete(null);
        await refreshAfterChange();
      } catch (error) {
        console.error("Failed to delete note:", error);
        setToast(String(error));
      }
    },
    [refreshAfterChange],
  );

  const handleCreateNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!title) {
      setIsCreatingNote(false);
      setNewNoteTitle("");
      return;
    }

    try {
      const content = `# ${title}\n\n`;
      const result = await invoke<{ path: string }>("save_note", { content });
      setIsCreatingNote(false);
      setNewNoteTitle("");
      await refreshAfterChange();

      if (result.path) {
        await invoke("open_draft", { path: result.path });
        closePalette();
      }
    } catch (error) {
      console.error("Failed to create note:", error);
      setToast(String(error));
    }
  }, [newNoteTitle, refreshAfterChange, closePalette]);

  // Keyboard handler
  useEffect(() => {
    // Skip keyboard when overlays are active (they handle their own keys)
    if (confirmDelete || isCreatingNote) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: close palette
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
        return;
      }

      // Any printable character: focus search input
      if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        document.activeElement !== inputRef.current
      ) {
        inputRef.current?.focus();
        return; // Let the key propagate to the input
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results.length > 0) {
        e.preventDefault();
        const item = results[selectedIndex];
        if (item) openNote(item);
      } else if (e.key === "Backspace" && !query.trim() && results.length > 0) {
        e.preventDefault();
        const note = results[selectedIndex];
        if (note) setConfirmDelete(note);
      } else if (e.key === "n" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCreatingNote(true);
        setNewNoteTitle("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    results,
    selectedIndex,
    query,
    confirmDelete,
    isCreatingNote,
    openNote,
    closePalette,
  ]);

  const startDrag = useCallback(async (e: React.MouseEvent) => {
    if (
      (e.target as HTMLElement).closest("input") ||
      (e.target as HTMLElement).closest("button")
    ) {
      return;
    }
    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.error("Failed to start drag:", err);
    }
  }, []);

  return (
    <div className="w-full h-full bg-bg rounded-[14px] flex flex-col overflow-hidden">
      {/* Search bar */}
      <div
        onMouseDown={startDrag}
        className="px-4 py-3 border-b border-line drag-handle"
      >
        <div className="flex items-center gap-3">
          <svg
            className="w-5 h-5 text-coral shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.searchAll")}
            aria-label={t("palette.searchLabel")}
            className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-stone outline-none focus-visible:ring-2 focus-visible:ring-coral focus-visible:rounded-md"
          />
          {isSearching && (
            <span className="text-stone text-sm animate-pulse">...</span>
          )}
        </div>
      </div>

      {/* Draft list */}
      <NoteList
        results={results}
        selectedIndex={selectedIndex}
        query={query}
        isSearching={isSearching}
        resultsRef={resultsRef}
        onSelectResult={openNote}
        onSetSelectedIndex={setSelectedIndex}
        isCreatingNote={isCreatingNote}
        newNoteTitle={newNoteTitle}
        onSetNewNoteTitle={setNewNoteTitle}
        onCreateNote={handleCreateNote}
        onCancelCreateNote={() => {
          setIsCreatingNote(false);
          setNewNoteTitle("");
        }}
      />

      {/* Footer */}
      <div
        onMouseDown={startDrag}
        className="flex items-center justify-between px-4 py-2 border-t border-line text-[10px] text-stone drag-handle"
      >
        <div className="flex items-center gap-3">
          <span>
            <kbd className="px-1.5 py-0.5 bg-line rounded text-[9px]">↑↓</kbd>{" "}
            {t("palette.navigate")}
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-line rounded text-[9px]">↵</kbd>{" "}
            {t("palette.open")}
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-line rounded text-[9px]">⌫</kbd>{" "}
            {t("palette.delete")}
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-line rounded text-[9px]">⌘N</kbd>{" "}
            {t("palette.new")}
          </span>
        </div>
        <span>
          <kbd className="px-1.5 py-0.5 bg-line rounded text-[9px]">esc</kbd>{" "}
          {t("palette.close")}
        </span>
      </div>

      {/* Overlays */}
      {confirmDelete && (
        <ConfirmDialog
          title={t("palette.deleteNote")}
          onConfirm={() => handleDeleteNote(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
