/**
 * The mark: one terminal, two readers.
 *
 * A PTY is a process that a model reads and types into while a human watches the
 * same screen. The drawing is that sentence: one frame (the session) holding two
 * cursors - a filled one and an outlined one - side by side on the same line. It is
 * deliberately two shapes and no text, so it survives 16 px in a favicon.
 *
 * `currentColor` throughout: the mark takes the colour of whatever it sits in, so
 * the same file works on the dark and the light theme without a variant.
 *
 * It is `aria-hidden`: the sidebar heading and the status line spell the name in
 * text right next to it, so a screen reader would otherwise say it twice.
 */

/**
 * The two cursors, as data rather than as two nearly identical `<rect>` blocks.
 *
 * `strokeWidth: undefined` is the filled one - it needs no outline, and drawing one
 * would make it a pixel wider on every side than the outlined cursor beside it.
 */
const CURSORS = [
  { x: 8, filled: true, strokeWidth: undefined },
  { x: 17.5, filled: false, strokeWidth: 2 },
] as const

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
      {/* The one who types, and the one who watches: same line, same buffer. */}
      {CURSORS.map((cursor) => (
        <rect
          key={cursor.x}
          x={cursor.x}
          y="12.5"
          width="6.5"
          height="9"
          rx="1.5"
          fill={cursor.filled ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={cursor.strokeWidth}
        />
      ))}
    </svg>
  )
}
