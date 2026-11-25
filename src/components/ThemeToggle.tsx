import { Button } from "@heroui/react";
import { Moon, Sun } from "lucide-react";
import { resolveTheme, usePrefs } from "../store/prefs";
import { t } from "../i18n/es";

/** Flips between light and dark; "system" is chosen in Settings. */
export function ThemeToggle() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const dark = resolveTheme(theme) === "dark";
  return (
    <Button
      isIconOnly
      variant="ghost"
      size="sm"
      aria-label={`${t.settings.theme}: ${dark ? t.settings.themeLight : t.settings.themeDark}`}
      onPress={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </Button>
  );
}
