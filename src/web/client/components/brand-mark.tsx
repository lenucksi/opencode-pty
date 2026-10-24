/**
 * The mark: a prompt, and a second cursor.
 *
 * A PTY is one process that an agent works in and a human watches - and can type
 * into. The drawing is that sentence in two glyphs: the chevron is the shell prompt
 * the agent is working at, the hollow block is a cursor that is not the agent's -
 * a second one, waiting on the same line.
 *
 * Two tone values: the prompt is the agent's and is drawn at full strength, the
 * second cursor at `0.62` so it reads as present rather than speaking. The favicon
 * (`public/favicon.svg`) is the same geometry in one tone and thicker strokes,
 * because at 16 px a dimmed shape becomes a smudge - it is a reduction of this
 * drawing, not a second logo.
 *
 * It is `aria-hidden`: the sidebar heading and the status line spell the name in
 * text right next to it, so a screen reader would otherwise say it twice.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      {/* The session. */}
      <rect
        x="2.5"
        y="6"
        width="27"
        height="20"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      {/* The prompt the agent is working at. */}
      <path
        d="M8.5 12.4 14 16l-5.5 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The other cursor: someone else can type here. */}
      <rect
        x="18.6"
        y="11.9"
        width="7"
        height="9.2"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        opacity="0.62"
      />
    </svg>
  )
}
