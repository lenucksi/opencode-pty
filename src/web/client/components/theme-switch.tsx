import type { ThemePreference } from '../lib/theme.ts'

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

interface ThemeSwitchProps {
  preference: ThemePreference
  onChange: (preference: ThemePreference) => void
}

/** Segmented control for choosing between the system theme and a fixed scheme. */
export function ThemeSwitch({ preference, onChange }: ThemeSwitchProps) {
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Color theme</legend>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="theme-switch-option"
          aria-pressed={preference === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
