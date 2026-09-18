import { useTheme } from '../theme/ThemeProvider.tsx';
import { themeControlLabel } from '../theme/theme.ts';

/**
 * One control for all three theme choices: System, Light, Dark. The visible label says
 * which is active, and the accessible name also says what pressing it will do, so the
 * state is never carried by the icon alone.
 */
export function ThemeToggle() {
  const { choice, resolved, cycle } = useTheme();
  const { label, accessibleLabel } = themeControlLabel(choice, resolved);

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={accessibleLabel}
      className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-[14px] font-medium text-ink hover:bg-sunken"
    >
      {choice === 'system' ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1" />
          <path d="M5.5 13.5h5" strokeLinecap="round" />
        </svg>
      ) : resolved === 'dark' ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" strokeLinecap="round" />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3.25" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" strokeLinecap="round" />
        </svg>
      )}
      <span aria-hidden="true" className="hidden sm:inline">
        {label}
      </span>
    </button>
  );
}
