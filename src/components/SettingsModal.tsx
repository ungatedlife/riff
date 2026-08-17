import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import SettingsContent from "./SettingsContent";
import type { SettingsTab } from "./SettingsContent";
import type { RiffSettings } from "@/types";
import { createCoalescedTaskRunner } from "@/utils/coalescedTaskRunner";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import {
  SETTINGS_MODAL_MAX_WIDTH,
  SETTINGS_MODAL_MIN_WIDTH,
} from "@/utils/settingsLayout";

const TABS: { id: SettingsTab; labelKey: TranslationKey; icon: React.ReactNode }[] = [
  {
    id: "appearance",
    labelKey: "settings.tab.appearance",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="13.5" cy="6.5" r=".5" />
        <circle cx="17.5" cy="10.5" r=".5" />
        <circle cx="8.5" cy="7.5" r=".5" />
        <circle cx="6.5" cy="12.5" r=".5" />
        <path d="M12 2a10 10 0 1 0 0 20h.5a2.5 2.5 0 0 0 0-5H11a2 2 0 0 1 0-4h2a4 4 0 0 0 0-8Z" />
      </svg>
    ),
  },
  {
    id: "shortcuts",
    labelKey: "settings.tab.shortcuts",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M9 16h6" />
      </svg>
    ),
  },
  {
    id: "publishing",
    labelKey: "settings.tab.publishing",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </svg>
    ),
  },
  {
    id: "about",
    labelKey: "settings.tab.about",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    ),
  },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isWindow?: boolean;
}

export default function SettingsModal({
  isOpen,
  onClose,
  isWindow = false,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [settings, setSettings] = useState<RiffSettings | null>(null);
  const [appVersion, setAppVersion] = useState("");

  const [resolvedNotesDir, setResolvedNotesDir] = useState("");

  useEffect(() => {
    if (isOpen) {
      invoke<RiffSettings>("get_settings").then(setSettings);
      invoke<string>("get_drafts_directory")
        .then(setResolvedNotesDir)
        .catch(() => {});
      getVersion()
        .then(setAppVersion)
        .catch(() => {});
    }
  }, [isOpen]);

  // Resume shortcuts when settings closes/unmounts
  useEffect(() => {
    return () => {
      invoke("resume_shortcuts").catch(() => {});
    };
  }, []);

  const prevDraftsDir = useRef(settings?.drafts_dir ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPendingRef = useRef(false);

  // Track the drafts_dir at load time so we can detect changes on save
  useEffect(() => {
    if (settings) {
      prevDraftsDir.current = settings.drafts_dir ?? "";
    }
    // Only on initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const performSave = useCallback(async (settingsToSave: RiffSettings) => {
    try {
      await invoke("save_settings", { settings: settingsToSave });
      await invoke("reload_shortcuts");
      await invoke("set_dock_icon_visibility", {
        hide: settingsToSave.hide_dock_icon,
      });
      await invoke("set_tray_icon_visibility", {
        hide: settingsToSave.hide_tray_icon ?? false,
      });

      if ((settingsToSave.drafts_dir ?? "") !== prevDraftsDir.current) {
        await invoke("rebuild_index");
        const newDir = await invoke<string>("get_drafts_directory");
        setResolvedNotesDir(newDir);
        prevDraftsDir.current = settingsToSave.drafts_dir ?? "";
      }

      await emit("settings-changed", settingsToSave);
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  }, []);
  const saveQueueRef = useRef(createCoalescedTaskRunner(performSave));

  const handleSettingsChange = useCallback((newSettings: RiffSettings) => {
    setSettings(newSettings);
    hasPendingRef.current = true;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      hasPendingRef.current = false;
      saveQueueRef.current.push(newSettings);
    }, 400);
  }, []);

  const handleClose = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (hasPendingRef.current && settings) {
      hasPendingRef.current = false;
      saveQueueRef.current.push(settings);
    }
    await saveQueueRef.current.flush();
    if (isWindow) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } else {
      onClose();
    }
  }, [settings, isWindow, onClose]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  if (!isOpen || !settings) return null;

  const tabBar = (
    <div className="px-4 pb-3">
      <div className="flex flex-wrap items-center gap-0.5">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1 px-2 py-1.5 text-[12px] font-medium rounded-lg transition-colors whitespace-nowrap ${
                isActive
                  ? "text-coral bg-coral/10"
                  : "text-stone hover:text-ink hover:bg-line/50"
              }`}
            >
              {tab.icon}
              <span>{t(tab.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const settingsContent = (
    <SettingsContent
      activeTab={activeTab}
      settings={settings}
      onSettingsChange={handleSettingsChange}
      resolvedNotesDir={resolvedNotesDir}
      appVersion={appVersion}
    />
  );

  if (isWindow) {
    return (
      <div className="w-full h-full bg-bg rounded-[14px] flex flex-col overflow-hidden">
        <div data-tauri-drag-region className="border-b border-line bg-line/20">
          <div
            className="flex items-center justify-between px-5 pt-4 pb-3"
            data-tauri-drag-region
          >
            <div className="flex items-center gap-2.5">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-coral"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <h2 className="text-[15px] font-semibold text-ink">
                {t("settings.title")}
              </h2>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t("common.closeDialog")}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-stone hover:text-ink hover:bg-line/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral"
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
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          {tabBar}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-hide p-5">
          {settingsContent}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
      <div
        className="bg-bg rounded-[14px] max-h-[85vh] flex flex-col shadow-riff overflow-hidden border border-line/50"
        style={{
          width: `min(96vw, ${SETTINGS_MODAL_MAX_WIDTH}px)`,
          minWidth: `min(96vw, ${SETTINGS_MODAL_MIN_WIDTH}px)`,
        }}
      >
        <div className="border-b border-line bg-line/20">
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="flex items-center gap-2.5">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-coral"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <h2 className="text-[15px] font-semibold text-ink">
                {t("settings.title")}
              </h2>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t("common.closeDialog")}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-stone hover:text-ink hover:bg-line/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral"
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
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          {tabBar}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-hide p-5">
          {settingsContent}
        </div>
      </div>
    </div>
  );
}
