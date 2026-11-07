import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme, type ThemePreference } from "@/context/ThemeContext";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Auto", icon: Monitor },
  { value: "light", label: "Day", icon: Sun },
  { value: "dark", label: "Night", icon: Moon },
];

/**
 * Theme picker: Auto (follows the computer or phone), Day, Night.
 * A compact frosted segmented control for the top bar.
 */
export function TethrThemeSwitch({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full p-0.5",
        "bg-[var(--tethr-frost)] shadow-[inset_0_0_0_1px_var(--tethr-rim)]",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label === "Auto" ? "Auto: match this device" : label}
            onClick={() => setPreference(value)}
            className={cn(
              "tethr-btn h-6 w-6",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

/** Label for menus: what the current preference is called. */
export function themePreferenceLabel(preference: ThemePreference): string {
  return OPTIONS.find((o) => o.value === preference)?.label ?? "Auto";
}

/** Next preference in the Auto → Day → Night cycle (for single-button menus). */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  const i = OPTIONS.findIndex((o) => o.value === preference);
  return OPTIONS[(i + 1) % OPTIONS.length]!.value;
}
