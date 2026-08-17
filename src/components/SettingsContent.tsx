import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import ShortcutRecorder from "./ShortcutRecorder";
import type {
  CustomFontEntry,
  CustomThemeDefinition,
  RiffSettings,
  ThemeColors,
} from "@/types";
import ConfirmDialog from "./ConfirmDialog";
import {
  SYSTEM_SHORTCUT_ACTIONS,
  SYSTEM_SHORTCUT_DEFAULTS,
  SYSTEM_SHORTCUT_LABEL_KEYS,
  type SystemAction,
} from "@/utils/systemShortcuts";
import { hexToRgb, rgbToHex } from "@/utils/color";
import { useTranslation } from "@/hooks/useTranslation";
import { type TranslationKey } from "@/i18n";
import { BUILTIN_THEMES, generateThemeId, type BuiltinTheme } from "@/themes";
import {
  FONTS,
  loadGoogleFont,
  loadCustomFont,
  fontNameFromPath,
} from "@/utils/fonts";

interface DropdownProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
}: DropdownProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const allOptions = options.some((o) => o.value === value)
    ? options
    : [{ value, label: value }, ...options];

  const selectedOption = allOptions.find((o) => o.value === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2.5 bg-bg border border-line rounded-lg text-[13px] text-ink text-left flex items-center justify-between hover:border-coral/50 transition-colors"
      >
        <span className={selectedOption ? "text-ink" : "text-stone"}>
          {selectedOption?.label || placeholder || t("common.select")}
        </span>
        <span
          className={`text-[8px] text-stone transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-bg border border-line rounded-lg shadow-riff overflow-hidden max-h-[220px] overflow-y-auto">
          {allOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2.5 text-[13px] text-left transition-colors ${
                option.value === value
                  ? "bg-coral text-white"
                  : "text-ink hover:bg-line/50"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type SettingsTab = "appearance" | "shortcuts" | "publishing" | "about";

interface SettingsContentProps {
  activeTab: SettingsTab;
  settings: RiffSettings;
  onSettingsChange: (settings: RiffSettings) => void;
  resolvedNotesDir: string;
  appVersion?: string;
}

function SettingsToast({
  message,
  onDone,
}: {
  message: string;
  onDone: () => void;
}) {
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

const COLOR_TOKEN_LABELS: {
  key: keyof ThemeColors;
  labelKey: TranslationKey;
  optional?: boolean;
  default?: string;
}[] = [
  { key: "bg", labelKey: "settings.color.background" },
  { key: "surface", labelKey: "settings.color.surface" },
  { key: "ink", labelKey: "settings.color.text" },
  { key: "stone", labelKey: "settings.color.mutedText" },
  { key: "line", labelKey: "settings.color.borders" },
  { key: "accent", labelKey: "settings.color.accent" },
  { key: "accent_light", labelKey: "settings.color.accentLight" },
  { key: "accent_dark", labelKey: "settings.color.accentDark" },
  {
    key: "highlight",
    labelKey: "settings.color.highlight",
    optional: true,
    default: "253 224 71",
  },
];

function ThemePreviewCard({
  name,
  colors,
  isDark,
  isActive,
  isSystem,
  onClick,
}: {
  name: string;
  colors: ThemeColors;
  isDark: boolean;
  isActive: boolean;
  isSystem?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border transition-all ${
        isActive
          ? "border-coral ring-2 ring-coral/20"
          : "border-line/50 hover:border-coral/40"
      }`}
    >
      <div
        className="relative rounded-t-xl p-3 h-[72px] flex flex-col justify-between overflow-hidden"
        style={{ backgroundColor: `rgb(${colors.bg})` }}
      >
        <div className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: `rgb(${colors.accent})` }}
          />
          <div
            className="h-1.5 rounded-full w-10"
            style={{ backgroundColor: `rgb(${colors.ink})`, opacity: 0.6 }}
          />
        </div>
        <div className="space-y-1">
          <div
            className="h-1.5 rounded-full w-full"
            style={{ backgroundColor: `rgb(${colors.ink})`, opacity: 0.15 }}
          />
          <div
            className="h-1.5 rounded-full w-3/4"
            style={{ backgroundColor: `rgb(${colors.stone})`, opacity: 0.25 }}
          />
        </div>
        <div
          className="absolute bottom-0 left-0 right-0 h-px"
          style={{ backgroundColor: `rgb(${colors.line})` }}
        />
      </div>
      <div className="px-3 py-2 bg-line/20 rounded-b-xl flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink truncate">
          {name}
        </span>
        {isSystem && (
          <span className="text-[9px] text-stone uppercase tracking-wider">
            {t("common.auto")}
          </span>
        )}
        {isDark && !isSystem && (
          <span className="text-[9px] text-stone uppercase tracking-wider">
            {t("theme.dark")}
          </span>
        )}
      </div>
    </button>
  );
}

function CustomThemeEditor({
  theme,
  onChange,
  onSave,
  onCancel,
  onDelete,
  isNew,
}: {
  theme: CustomThemeDefinition;
  onChange: (theme: CustomThemeDefinition) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  const updateColor = (key: keyof ThemeColors, hex: string) => {
    onChange({
      ...theme,
      colors: { ...theme.colors, [key]: hexToRgb(hex) },
    });
  };

  return (
    <div className="space-y-4 p-4 bg-line/30 rounded-xl border border-line/50">
      <div>
        <label
          className="block text-[12px] text-stone mb-1.5"
          htmlFor="theme-name-input"
        >
          {t("settings.theme.name")}
        </label>
        <input
          ref={nameInputRef}
          id="theme-name-input"
          type="text"
          value={theme.name}
          onChange={(e) => onChange({ ...theme, name: e.target.value })}
          placeholder={t("settings.theme.namePlaceholder")}
          maxLength={30}
          className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-[13px] text-ink placeholder:text-stone/70 focus:outline-none focus:border-coral/50"
        />
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-stone">{t("settings.theme.dark")}</span>
        <button
          type="button"
          onClick={() => onChange({ ...theme, is_dark: !theme.is_dark })}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
            theme.is_dark ? "bg-coral" : "bg-line"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white transition-transform pointer-events-none ${
              theme.is_dark ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </label>

      <div>
        <p className="text-[12px] text-stone mb-2">{t("settings.theme.colors")}</p>
        <div className="grid grid-cols-2 gap-2">
          {COLOR_TOKEN_LABELS.map(
            ({ key, labelKey, optional, default: defaultRgb }) => {
              const rgbValue = theme.colors[key] ?? defaultRgb ?? "0 0 0";
              return (
                <div
                  key={key}
                  className="flex items-center gap-2 px-2.5 py-2 bg-bg rounded-lg border border-line/50"
                >
                  <label className="relative w-6 h-6 shrink-0">
                    <input
                      type="color"
                      value={rgbToHex(rgbValue)}
                      onChange={(e) => updateColor(key, e.target.value)}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div
                      className="w-6 h-6 rounded-md border border-line cursor-pointer"
                      style={{ backgroundColor: `rgb(${rgbValue})` }}
                    />
                  </label>
                  <span className="text-[11px] text-ink truncate">
                    {t(labelKey)}
                    {optional && (
                      <span className="ml-1 text-stone/60">opt</span>
                    )}
                  </span>
                </div>
              );
            },
          )}
        </div>
      </div>

      <div
        className="rounded-lg overflow-hidden border border-line/50"
        style={{ backgroundColor: `rgb(${theme.colors.bg})` }}
      >
        <div className="px-3 py-2.5">
          <p
            className="text-[13px] font-medium mb-1"
            style={{ color: `rgb(${theme.colors.ink})` }}
          >
            {t("settings.theme.preview")}
          </p>
          <p
            className="text-[11px] leading-relaxed"
            style={{ color: `rgb(${theme.colors.stone})` }}
          >
            
            {t("settings.theme.previewHint")}{" "}
            <span style={{ color: `rgb(${theme.colors.accent})` }}>
              {t("settings.theme.accentColor")}
            </span>{" "}
            {t("settings.theme.accentColorDesc")}
          </p>
        </div>
        <div
          className="px-3 py-2 flex items-center gap-2"
          style={{
            backgroundColor: `rgb(${theme.colors.surface})`,
            borderTop: `1px solid rgb(${theme.colors.line})`,
          }}
        >
          <div
            className="px-2.5 py-1 rounded-md text-[10px] font-medium"
            style={{
              backgroundColor: `rgb(${theme.colors.accent})`,
              color: theme.is_dark ? `rgb(${theme.colors.bg})` : "#fff",
            }}
          >
            {t("settings.theme.button")}
          </div>
          <div
            className="px-2.5 py-1 rounded-md text-[10px]"
            style={{
              border: `1px solid rgb(${theme.colors.line})`,
              color: `rgb(${theme.colors.stone})`,
            }}
          >
            {t("settings.theme.secondary")}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onSave}
          disabled={!theme.name.trim()}
          className="px-3 py-2 text-[12px] font-medium text-white bg-coral rounded-lg hover:bg-coral/90 transition-colors disabled:opacity-50"
        >
          {isNew ? t("common.create") : t("common.update")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 text-[12px] text-stone hover:text-ink rounded-lg hover:bg-line transition-colors"
        >
          {t("common.cancelAction")}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto px-3 py-2 text-[12px] text-coral hover:bg-coral-light rounded-lg transition-colors"
          >
            {t("common.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

function AppearanceSection({
  settings,
  onSettingsChange,
}: {
  settings: RiffSettings;
  onSettingsChange: (settings: RiffSettings) => void;
}) {
  const { t } = useTranslation();
  const [editingTheme, setEditingTheme] =
    useState<CustomThemeDefinition | null>(null);
  const [isNewTheme, setIsNewTheme] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const selectedFont = settings.font_family ?? null;
  const windowOpacity = settings.window_opacity ?? 1.0;
  const customFonts: CustomFontEntry[] = settings.custom_fonts ?? [];

  // Lazily load all built-in Google Fonts and any saved custom fonts when the tab opens.
  useEffect(() => {
    for (const font of FONTS) {
      loadGoogleFont(font.id);
    }
    for (const cf of customFonts) {
      void loadCustomFont(cf.name, cf.path);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImportFont = async () => {
    const selected = await open({
      multiple: false,
      title: t("settings.font.importFile"),
      filters: [
        { name: t("settings.font.files"), extensions: ["ttf", "otf", "woff", "woff2"] },
      ],
    });
    if (!selected) return;

    const name = fontNameFromPath(selected);
    // Avoid duplicates (same path)
    if (customFonts.some((f) => f.path === selected)) {
      setToast(`Font "${name}" is already imported`);
      return;
    }

    const ok = await loadCustomFont(name, selected);
    if (!ok) {
      setToast(t("settings.font.loadFailed"));
      return;
    }

    const updated = [...customFonts, { name, path: selected }];
    onSettingsChange({ ...settings, custom_fonts: updated });
    setToast(`Font "${name}" imported`);
  };

  const removeCustomFont = (path: string) => {
    const entry = customFonts.find((f) => f.path === path);
    const updated = customFonts.filter((f) => f.path !== path);
    const patch: Partial<RiffSettings> = { custom_fonts: updated };
    // Clear font_family if it was using the removed font
    if (entry && settings.font_family === entry.name) {
      patch.font_family = null;
    }
    onSettingsChange({ ...settings, ...patch });
    if (entry) setToast(`Font "${entry.name}" removed`);
  };

  const activeTheme = settings.active_theme || settings.theme_mode || "system";
  const customThemes = settings.custom_themes ?? [];

  const selectTheme = (id: string) => {
    onSettingsChange({ ...settings, active_theme: id, theme_mode: id });
  };

  const startNewTheme = () => {
    const defaultLight = BUILTIN_THEMES[0];
    setEditingTheme({
      id: generateThemeId(),
      name: "",
      is_dark: false,
      colors: { ...defaultLight.colors },
    });
    setIsNewTheme(true);
  };

  const startEditTheme = (theme: CustomThemeDefinition) => {
    setEditingTheme({ ...theme, colors: { ...theme.colors } });
    setIsNewTheme(false);
  };

  const saveTheme = () => {
    if (!editingTheme || !editingTheme.name.trim()) return;

    let updated: CustomThemeDefinition[];
    if (isNewTheme) {
      updated = [...customThemes, editingTheme];
    } else {
      updated = customThemes.map((t) =>
        t.id === editingTheme.id ? editingTheme : t,
      );
    }

    onSettingsChange({
      ...settings,
      custom_themes: updated,
      active_theme: editingTheme.id,
      theme_mode: editingTheme.id,
    });
    setEditingTheme(null);
    setToast(
      isNewTheme
        ? `Theme "${editingTheme.name}" created`
        : `Theme "${editingTheme.name}" updated`,
    );
  };

  const deleteTheme = (id: string) => {
    const theme = customThemes.find((t) => t.id === id);
    const updated = customThemes.filter((t) => t.id !== id);
    const newSettings: Partial<RiffSettings> = { custom_themes: updated };

    if (activeTheme === id) {
      newSettings.active_theme = "system";
      newSettings.theme_mode = "";
    }

    onSettingsChange({ ...settings, ...newSettings });
    if (editingTheme?.id === id) setEditingTheme(null);
    setConfirmingDelete(null);
    if (theme) setToast(`Theme "${theme.name}" deleted`);
  };

  const handleImport = async () => {
    const selected = await open({
      multiple: false,
      title: t("settings.theme.importFile"),
      filters: [{ name: t("settings.theme.files"), extensions: ["json", "toml"] }],
    });
    if (!selected) return;

    try {
      const imported = await invoke<CustomThemeDefinition>(
        "import_theme_file",
        {
          path: selected,
        },
      );
      const updated = [...customThemes, imported];
      onSettingsChange({
        ...settings,
        custom_themes: updated,
        active_theme: imported.id,
        theme_mode: imported.id,
      });
      setToast(`Theme "${imported.name}" imported`);
    } catch (error) {
      setToast(`Import failed: ${error}`);
    }
  };

  const handleExport = async (theme: {
    name: string;
    is_dark: boolean;
    colors: ThemeColors;
  }) => {
    const selected = await save({
      title: t("settings.theme.export"),
      defaultPath: `${theme.name.toLowerCase().replace(/\s+/g, "-")}.json`,
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "TOML", extensions: ["toml"] },
      ],
    });
    if (!selected) return;

    try {
      await invoke("export_theme_file", {
        path: selected,
        name: theme.name,
        is_dark: theme.is_dark,
        colors: theme.colors,
      });
      setToast(`Theme "${theme.name}" exported`);
    } catch (error) {
      setToast(`Export failed: ${error}`);
    }
  };

  const systemColors: BuiltinTheme = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches
    ? BUILTIN_THEMES[1]
    : BUILTIN_THEMES[0];

  return (
    <>
      <div className="space-y-4">
        <p className="text-[12px] text-stone">
          {t("settings.theme.chooseIntro")}
        </p>

        <div className="grid grid-cols-3 gap-2">
          <ThemePreviewCard
            name={t("common.system")}
            colors={systemColors.colors}
            isDark={systemColors.isDark}
            isActive={activeTheme === "system" || activeTheme === ""}
            isSystem
            onClick={() => selectTheme("system")}
          />
          {BUILTIN_THEMES.map((theme) => (
            <ThemePreviewCard
              key={theme.id}
              name={t(theme.nameKey)}
              colors={theme.colors}
              isDark={theme.isDark}
              isActive={activeTheme === theme.id}
              onClick={() => selectTheme(theme.id)}
            />
          ))}
          {customThemes.map((theme) => (
            <div key={theme.id} className="relative group">
              <ThemePreviewCard
                name={theme.name}
                colors={theme.colors}
                isDark={theme.is_dark}
                isActive={activeTheme === theme.id}
                onClick={() => selectTheme(theme.id)}
              />
              <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditTheme(theme);
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg/80 backdrop-blur-sm text-stone hover:text-ink text-[10px]"
                  title={t("settings.theme.edit")}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExport(theme);
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg/80 backdrop-blur-sm text-stone hover:text-ink text-[10px]"
                  title={t("settings.theme.export")}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingDelete(theme.id);
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg/80 backdrop-blur-sm text-stone hover:text-coral text-[10px]"
                  title={t("settings.theme.delete")}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        {editingTheme ? (
          <CustomThemeEditor
            theme={editingTheme}
            onChange={setEditingTheme}
            onSave={saveTheme}
            onCancel={() => setEditingTheme(null)}
            onDelete={
              !isNewTheme
                ? () => setConfirmingDelete(editingTheme.id)
                : undefined
            }
            isNew={isNewTheme}
          />
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={startNewTheme}
              className="flex-1 px-4 py-3 text-[13px] text-coral hover:bg-coral-light rounded-xl transition-colors flex items-center justify-center gap-2 border border-dashed border-coral/30 hover:border-coral/50"
            >
              <span className="text-lg">+</span>
              <span>{t("settings.theme.create")}</span>
            </button>
            <button
              type="button"
              onClick={handleImport}
              className="px-4 py-3 text-[13px] text-coral hover:bg-coral-light rounded-xl transition-colors flex items-center justify-center gap-2 border border-dashed border-coral/30 hover:border-coral/50"
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{t("common.import")}</span>
            </button>
          </div>
        )}

        {/* ── Font Picker ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[12px] text-stone font-medium">{t("settings.font.editorFont")}</p>
            <button
              type="button"
              onClick={handleImportFont}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] text-coral border border-dashed border-coral/30 hover:bg-coral-light transition-colors"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              
              {t("settings.font.importEllipsis")}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-2">
            <button
              type="button"
              onClick={() =>
                onSettingsChange({ ...settings, font_family: null })
              }
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                selectedFont === null
                  ? "bg-coral text-white border-coral"
                  : "border-line text-stone hover:border-coral/40 hover:text-ink"
              }`}
            >
              {t("settings.font.systemDefault")}
            </button>
          </div>

          {(["sans", "serif", "mono"] as const).map((cat) => (
            <div key={cat} className="mb-2">
              <p className="text-[10px] text-stone uppercase tracking-wider mb-1.5">
                {cat === "sans"
                  ? t("settings.font.sansSerif")
                  : cat === "serif"
                    ? t("settings.font.serif")
                    : t("settings.font.monospace")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {FONTS.filter((f) => f.category === cat).map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    onClick={() => {
                      loadGoogleFont(font.id);
                      onSettingsChange({ ...settings, font_family: font.id });
                    }}
                    style={{ fontFamily: `"${font.id}", sans-serif` }}
                    className={`px-3 py-1.5 rounded-full text-[11px] border transition-colors ${
                      selectedFont === font.id
                        ? "bg-coral text-white border-coral"
                        : "border-line text-ink hover:border-coral/40"
                    }`}
                  >
                    {font.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {customFonts.length > 0 && (
            <div className="mb-1">
              <p className="text-[10px] text-stone uppercase tracking-wider mb-1.5">
                {t("settings.template.custom")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {customFonts.map((cf) => (
                  <div key={cf.path} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        void loadCustomFont(cf.name, cf.path).then((ok) => {
                          if (ok)
                            onSettingsChange({
                              ...settings,
                              font_family: cf.name,
                            });
                          else
                            setToast(
                              `Could not load "${cf.name}" — file may have moved`,
                            );
                        });
                      }}
                      style={{ fontFamily: `"${cf.name}", sans-serif` }}
                      className={`px-3 py-1.5 rounded-l-full text-[11px] border-y border-l transition-colors ${
                        selectedFont === cf.name
                          ? "bg-coral text-white border-coral"
                          : "border-line text-ink hover:border-coral/40"
                      }`}
                    >
                      {cf.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCustomFont(cf.path)}
                      className={`px-1.5 py-1.5 rounded-r-full text-[10px] border-y border-r transition-colors ${
                        selectedFont === cf.name
                          ? "bg-coral text-white border-coral hover:bg-coral/90"
                          : "border-line text-stone hover:text-coral hover:border-coral/40"
                      }`}
                      title={t("settings.font.remove")}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Background Opacity ── */}
        <div className="p-4 bg-line/30 rounded-xl border border-line/50">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[13px] text-ink font-medium">
              {t("settings.opacity.title")}
            </p>
            <span className="text-[12px] font-mono text-stone tabular-nums">
              {Math.round(windowOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            aria-label={t("settings.opacity.title")}
            min={20}
            max={100}
            step={5}
            value={Math.round(windowOpacity * 100)}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                window_opacity: Number(e.target.value) / 100,
              })
            }
            className="w-full accent-coral"
          />
          <p className="mt-2 text-[11px] text-stone leading-relaxed">
            {t("settings.opacity.describe")}
          </p>
        </div>

        <div className="p-3 bg-coral-light/40 border border-coral/20 rounded-xl">
          <p className="text-[12px] text-stone leading-relaxed">
            {t("settings.theme.scopeNote")}
          </p>
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t("settings.theme.deleteConfirm")}
          description={t("settings.theme.deleteDescribe", {
            name: customThemes.find((c) => c.id === confirmingDelete)?.name ?? "",
          })}
          onConfirm={() => deleteTheme(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
      {toast && <SettingsToast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}

export default function SettingsContent({
  activeTab,
  settings,
  onSettingsChange,
  resolvedNotesDir,
  appVersion,
}: SettingsContentProps) {
  const { t } = useTranslation();
  const notesDir = settings.drafts_dir || resolvedNotesDir || "~/Documents/Riff";

  return (
    <div>
      {activeTab === "appearance" && (
        <div className="space-y-4">
          <AppearanceSection
            settings={settings}
            onSettingsChange={onSettingsChange}
          />

          <div className="flex items-center justify-between gap-3 p-4 bg-line/30 rounded-xl border border-line/50">
            <div>
              <p className="text-[13px] text-ink font-medium">{t("settings.fontSize")}</p>
              <p className="mt-1 text-[12px] text-stone leading-relaxed">
                {t("settings.fontSize.describe")}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  onSettingsChange({
                    ...settings,
                    font_size: Math.max((settings.font_size ?? 16) - 1, 12),
                  })
                }
                disabled={(settings.font_size ?? 16) <= 12}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-line text-[14px] text-ink hover:bg-line/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                -
              </button>
              <span className="w-8 text-center text-[13px] font-mono text-ink tabular-nums">
                {settings.font_size ?? 16}
              </span>
              <button
                type="button"
                onClick={() =>
                  onSettingsChange({
                    ...settings,
                    font_size: Math.min((settings.font_size ?? 16) + 1, 48),
                  })
                }
                disabled={(settings.font_size ?? 16) >= 48}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-line text-[14px] text-ink hover:bg-line/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
          </div>

          <div className="p-4 bg-line/30 rounded-xl border border-line/50">
            <p className="text-[13px] text-ink font-medium mb-1">
              {t("settings.textDirection.title")}
            </p>
            <p className="text-[12px] text-stone leading-relaxed mb-3">
              {t("settings.textDirection.describe")}
            </p>
            <div className="max-w-[240px]">
              <Dropdown
                value={settings.text_direction || "auto"}
                options={[
                  { value: "auto", label: t("settings.textDirection.auto") },
                  { value: "ltr", label: t("settings.textDirection.ltr") },
                  { value: "rtl", label: t("settings.textDirection.rtl") },
                ]}
                onChange={(value) =>
                  onSettingsChange({ ...settings, text_direction: value })
                }
              />
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 p-4 bg-line/30 rounded-xl border border-line/50">
            <div>
              <p className="text-[13px] text-ink font-medium">{t("settings.hideDockIcon")}</p>
              <p className="mt-1 text-[12px] text-stone leading-relaxed">
                {t("settings.hideDockIcon.describe")}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                onSettingsChange({
                  ...settings,
                  hide_dock_icon: !settings.hide_dock_icon,
                })
              }
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                settings.hide_dock_icon ? "bg-coral" : "bg-line"
              }`}
              title={t("settings.hideDockIcon.toggle")}
            >
              <span
                className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white transition-transform pointer-events-none ${
                  settings.hide_dock_icon ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </label>

          <label className="flex items-center justify-between gap-3 p-4 bg-line/30 rounded-xl border border-line/50">
            <div>
              <p className="text-[13px] text-ink font-medium">
                {t("settings.hideTrayIcon.title")}
              </p>
              <p className="mt-1 text-[12px] text-stone leading-relaxed">
                {t("settings.hideTrayIcon.describe")}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                onSettingsChange({
                  ...settings,
                  hide_tray_icon: !settings.hide_tray_icon,
                })
              }
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                settings.hide_tray_icon ? "bg-coral" : "bg-line"
              }`}
              title={t("settings.hideTrayIcon.toggle")}
            >
              <span
                className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white transition-transform pointer-events-none ${
                  settings.hide_tray_icon ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        </div>
      )}

      {activeTab === "shortcuts" && (
        <div>
          <p className="mb-4 text-[12px] text-stone">
            {t("settings.shortcut.intro")}
          </p>

          <div>
            <p className="text-[12px] text-stone mb-3">{t("settings.shortcut.system")}</p>
            <div className="space-y-2">
              {SYSTEM_SHORTCUT_ACTIONS.map((action) => {
                const currentShortcut =
                  settings.system_shortcuts?.[action] ??
                  SYSTEM_SHORTCUT_DEFAULTS[action];
                const isDefault =
                  currentShortcut === SYSTEM_SHORTCUT_DEFAULTS[action];
                // Other system shortcuts + all folder shortcuts are reserved for this recorder
                const otherSystemShortcuts = SYSTEM_SHORTCUT_ACTIONS.filter(
                  (a) => a !== action,
                ).map(
                  (a) =>
                    settings.system_shortcuts?.[a] ??
                    SYSTEM_SHORTCUT_DEFAULTS[a],
                );

                return (
                  <div
                    key={action}
                    className="flex items-center gap-2 px-3 py-2 bg-line/30 rounded-xl border border-line/50"
                  >
                    <span className="w-[70px] shrink-0 text-[12px] text-ink font-medium">
                      {t(SYSTEM_SHORTCUT_LABEL_KEYS[action as SystemAction])}
                    </span>
                    <div className="flex-1 min-w-0">
                      <ShortcutRecorder
                        value={currentShortcut}
                        onChange={(value) =>
                          onSettingsChange({
                            ...settings,
                            system_shortcuts: {
                              ...settings.system_shortcuts,
                              [action]: value,
                            },
                          })
                        }
                        reservedShortcuts={otherSystemShortcuts}
                        existingShortcuts={[]}
                      />
                    </div>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() =>
                          onSettingsChange({
                            ...settings,
                            system_shortcuts: {
                              ...settings.system_shortcuts,
                              [action]:
                                SYSTEM_SHORTCUT_DEFAULTS[
                                  action as SystemAction
                                ],
                            },
                          })
                        }
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md hover:bg-coral-light text-stone hover:text-coral transition-colors"
                        title={t("settings.shortcut.resetDefault")}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {SYSTEM_SHORTCUT_ACTIONS.some(
              (a) =>
                (settings.system_shortcuts?.[a] ??
                  SYSTEM_SHORTCUT_DEFAULTS[a]) !== SYSTEM_SHORTCUT_DEFAULTS[a],
            ) && (
              <button
                type="button"
                onClick={() =>
                  onSettingsChange({
                    ...settings,
                    system_shortcuts: { ...SYSTEM_SHORTCUT_DEFAULTS },
                  })
                }
                className="mt-2 text-[11px] text-coral hover:underline"
              >
                {t("settings.shortcut.resetAll")}
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === "publishing" && (
        <div className="space-y-4">
          <div>
            <p className="text-[12px] text-stone mb-1.5">{t("settings.vaultDir")}</p>
            <div className="flex items-center gap-2">
              <div
                className={`flex-1 px-3 py-2.5 bg-bg border border-line rounded-lg text-[13px] font-mono truncate ${
                  settings.vault_dir ? "text-ink" : "text-stone"
                }`}
              >
                {settings.vault_dir || t("settings.vaultDir.none")}
              </div>
              <button
                type="button"
                onClick={async () => {
                  const selected = await open({
                    directory: true,
                    multiple: false,
                    title: t("settings.vaultDir"),
                    defaultPath: settings.vault_dir || undefined,
                  });
                  if (selected) {
                    onSettingsChange({
                      ...settings,
                      vault_dir: selected,
                    });
                  }
                }}
                className="px-3 py-2.5 text-[12px] text-coral border border-coral/30 rounded-lg hover:bg-coral-light transition-colors whitespace-nowrap"
              >
                {t("common.browse")}
              </button>
              {settings.vault_dir && (
                <button
                  type="button"
                  onClick={() =>
                    onSettingsChange({ ...settings, vault_dir: null })
                  }
                  className="px-3 py-2.5 text-[12px] text-stone hover:text-coral border border-line rounded-lg hover:border-coral/30 transition-colors whitespace-nowrap"
                >
                  {t("common.reset")}
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[12px] text-stone leading-relaxed">
              {t("settings.vaultDir.describe")}
            </p>
          </div>

          <div>
            <p className="text-[12px] text-stone mb-1.5">{t("settings.quickiesFile")}</p>
            <div className="flex items-center gap-2">
              <div
                className={`flex-1 px-3 py-2.5 bg-bg border border-line rounded-lg text-[13px] font-mono truncate ${
                  settings.quickies_file ? "text-ink" : "text-stone"
                }`}
              >
                {settings.quickies_file || t("settings.quickiesFile.none")}
              </div>
              <button
                type="button"
                onClick={async () => {
                  const selected = await open({
                    multiple: false,
                    title: t("settings.quickiesFile"),
                    filters: [
                      { name: "Markdown", extensions: ["md", "markdown"] },
                    ],
                    defaultPath:
                      settings.quickies_file ||
                      settings.vault_dir ||
                      undefined,
                  });
                  if (selected) {
                    onSettingsChange({
                      ...settings,
                      quickies_file: selected,
                    });
                  }
                }}
                className="px-3 py-2.5 text-[12px] text-coral border border-coral/30 rounded-lg hover:bg-coral-light transition-colors whitespace-nowrap"
              >
                {t("common.browse")}
              </button>
              {settings.quickies_file && (
                <button
                  type="button"
                  onClick={() =>
                    onSettingsChange({ ...settings, quickies_file: null })
                  }
                  className="px-3 py-2.5 text-[12px] text-stone hover:text-coral border border-line rounded-lg hover:border-coral/30 transition-colors whitespace-nowrap"
                >
                  {t("common.reset")}
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[12px] text-stone leading-relaxed">
              {t("settings.quickiesFile.describe")}
            </p>
          </div>

          <div>
            <p className="text-[12px] text-stone mb-1.5">{t("settings.draftsDir")}</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2.5 bg-bg border border-line rounded-lg text-[13px] font-mono truncate text-ink">
                  {notesDir}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const selected = await open({
                      directory: true,
                      multiple: false,
                      title: t("settings.notesDirectory.choose"),
                      defaultPath:
                        settings.drafts_dir || resolvedNotesDir || undefined,
                    });
                    if (selected) {
                      onSettingsChange({
                        ...settings,
                        drafts_dir: selected,
                      });
                    }
                  }}
                  className="px-3 py-2.5 text-[12px] text-coral border border-coral/30 rounded-lg hover:bg-coral-light transition-colors whitespace-nowrap"
                >
                  {t("common.browse")}
                </button>
                {settings.drafts_dir && (
                  <button
                    type="button"
                    onClick={() =>
                      onSettingsChange({ ...settings, drafts_dir: null })
                    }
                    className="px-3 py-2.5 text-[12px] text-stone hover:text-coral border border-line rounded-lg hover:border-coral/30 transition-colors whitespace-nowrap"
                  >
                    {t("common.reset")}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[12px] text-stone leading-relaxed">
                {t("settings.draftsDir.describe")}
              </p>
          </div>
        </div>
      )}

      {activeTab === "about" && (
        <div className="space-y-4">
          <div className="p-4 bg-line/30 rounded-xl border border-line/50">
            <p className="text-[15px] text-ink font-semibold">Riff</p>
            <p className="mt-1 text-[12px] text-stone leading-relaxed">
              {t("settings.about.tagline")}
            </p>
            {appVersion && (
              <p className="mt-2 text-[11px] font-mono text-stone">
                v{appVersion}
              </p>
            )}
          </div>
          <div className="p-3 bg-coral-light/40 border border-coral/20 rounded-xl">
            <p className="text-[12px] text-stone leading-relaxed">
              {t("settings.about.credit")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

