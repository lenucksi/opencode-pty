import type { ThemePreference } from '../lib/theme.ts'

interface ThemeOption {
  value: ThemePreference
  label: string
  hint: string
}

const OPTIONS: readonly ThemeOption[] = [
  { value: 'auto', label: 'Auto', hint: 'Follow the system colour scheme' },
  { value: 'light', label: 'Light', hint: 'Always use the light theme' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme' },
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
          title={option.hint}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
