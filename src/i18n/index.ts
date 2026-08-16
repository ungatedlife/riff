/// String catalogue — a lookup plus `{placeholder}` substitution.
/// Riff ships English-only; the catalogue keeps UI strings in one place.
import { en } from "./locales/en";

export type TranslationKey = keyof typeof en;
export type Translations = Record<TranslationKey, string>;

export type TranslationVars = Record<string, string | number>;

export function t(key: TranslationKey, vars?: TranslationVars): string {
  const template = en[key] ?? key;
  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
