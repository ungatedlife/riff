import type { SearchResult } from "@/types";
import { formatRelativeDate } from "@/utils/formatRelativeDate";
import {
  normalizeNoteTitle,
  normalizeNoteSnippet,
} from "@/utils/notePresentation";
import { useTranslation } from "@/hooks/useTranslation";

interface NoteListProps {
  results: SearchResult[];
  selectedIndex: number;
  query: string;
  isSearching: boolean;
  resultsRef: React.RefObject<HTMLDivElement | null>;
  onSelectResult: (result: SearchResult) => void;
  onSetSelectedIndex: (index: number) => void;
  isCreatingNote: boolean;
  newNoteTitle: string;
  onSetNewNoteTitle: (title: string) => void;
  onCreateNote: () => void;
  onCancelCreateNote: () => void;
}

function highlightSnippet(snippet: string, searchQuery: string) {
  if (!searchQuery.trim()) return snippet;
  const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = snippet.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="bg-coral/30 text-coral font-medium">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function NoteList({
  results,
  selectedIndex,
  query,
  isSearching,
  resultsRef,
  onSelectResult,
  onSetSelectedIndex,
  isCreatingNote,
  newNoteTitle,
  onSetNewNoteTitle,
  onCreateNote,
  onCancelCreateNote,
}: NoteListProps) {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;

  if (results.length === 0 && hasQuery && !isSearching) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <span className="text-stone text-sm">
          {t("palette.noNotesFor", { query })}
        </span>
      </div>
    );
  }

  if (results.length === 0 && !hasQuery && !isSearching && !isCreatingNote) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <span className="text-stone text-sm">{t("palette.empty")}</span>
      </div>
    );
  }

  return (
    <div ref={resultsRef} className="flex-1 overflow-y-auto">
      {/* Inline create-note input */}
      {isCreatingNote && (
        <div className="px-4 py-3 border-b border-coral/30 bg-coral/5">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-coral shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <input
              type="text"
              value={newNoteTitle}
              onChange={(e) => onSetNewNoteTitle(e.target.value)}
              placeholder={t("palette.noteTitlePlaceholder")}
              aria-label={t("palette.newNoteLabel")}
              autoFocus
              className="flex-1 text-[14px] font-medium bg-transparent text-ink placeholder:text-stone outline-none focus-visible:ring-2 focus-visible:ring-coral focus-visible:rounded-sm"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCreateNote();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelCreateNote();
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Section header */}
      {!hasQuery && results.length > 0 && (
        <div className="px-4 py-2 border-b border-line/50 bg-line/20">
          <span className="text-[10px] font-semibold text-stone uppercase tracking-wider">
            {t("palette.recent")}
          </span>
        </div>
      )}

      {results.map((result, index) => {
        const displayTitle = normalizeNoteTitle(
          result.title || result.filename || t("common.untitled"),
        );
        const displaySnippet = normalizeNoteSnippet(result.snippet);
        const shouldShowSnippet =
          hasQuery &&
          displaySnippet.length > 0 &&
          displaySnippet !== displayTitle;
        const isSelected = index === selectedIndex;

        return (
          <button
            key={result.path}
            onClick={() => onSelectResult(result)}
            onMouseEnter={() => onSetSelectedIndex(index)}
            className={`w-full px-4 py-3 text-left border-b border-line/50 transition-colors ${
              isSelected ? "bg-coral/10" : "hover:bg-line/30"
            }`}
          >
            <p className="text-[14px] font-medium leading-relaxed truncate text-ink">
              {displayTitle}
            </p>
            <span className="text-[10px] text-stone font-mono">
              {formatRelativeDate(result.created)}
            </span>
            {shouldShowSnippet && (
              <p className="text-[12px] text-stone leading-relaxed mt-0.5">
                {highlightSnippet(displaySnippet, query)}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
