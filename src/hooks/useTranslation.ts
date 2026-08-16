/// React binding for the string catalogue. With a single locale this is a
/// thin wrapper, kept so components read strings the same way everywhere.
import { t, type TranslationKey, type TranslationVars } from "@/i18n";

export function useTranslation() {
  return {
    t: (key: TranslationKey, vars?: TranslationVars) => t(key, vars),
  };
}
