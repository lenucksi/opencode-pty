import { createSignal, onCleanup, onMount } from 'solid-js'
import { type JsxComponent, jsx } from '@opentui/solid/jsx-runtime'
import type { MouseEvent, TextareaRenderable } from '@opentui/core'
import type { Plugin } from '@opencode/plugin/tui'

import type { Tones } from './tones.ts'

/**
 * The send dialog: a line, or the keys a line cannot be.
 *
 * The plugin's own dialog rather than `ui.dialog.prompt`, for one measured reason and
 * one reader decision. Measured: the SDK prompt draws only a title, a field and esc, so
 * a pointer close and key choices the reader asked for cannot exist there. The reader
 * asked: click send, the dialog opens, work inside it, click its ✕ and it is gone -
 * which is content design, and only this plugin's own dialog can draw it.
 *
 * Content rendered through `ui.dialog.show` lands inside the host dialog's inner box,
 * which stops a mouse-up from closing itself while the pointer released over it - so a
 * pointer control in here is safe from the backdrop-closing gesture that made the
 * panel's earlier mousedown-opened prompt die by its own click.
 */

/** What the reader asked the process to receive, once a choice is made. */
export type SendChoice =
  | { readonly kind: 'line'; readonly line: string }
  | { readonly kind: 'keys'; readonly bytes: string }

/**
 * The keys a line cannot be, with the bytes each one is.
 *
 * A control byte is the letter's own code with bit 6 cleared (0x63 & 0x1f for C) - the
 * encoding every terminal driver reads, written here as data instead of computed at a
 * click site. Enter is `\r` and never `\n`: a terminal's line discipline turns a
 * carriage return into the Enter the program reads.
 */
export const KEY_ACTIONS: readonly { readonly label: string; readonly bytes: string }[] = [
  { label: 'Ctrl+C', bytes: '\x03' },
  { label: 'Ctrl+D', bytes: '\x04' },
  { label: 'Ctrl+Z', bytes: '\x1a' },
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: 'Enter', bytes: '\r' },
]

export interface SendDialogRequest {
  readonly tones: Tones
  readonly title: string
  readonly description: string
}

/** The capabilities and content the component needs, snapped from the raw record. */
interface SendDialogProps {
  readonly tones: Tones
  readonly title: string
  readonly description: string
  readonly keys: readonly { readonly label: string; readonly bytes: string }[]
  readonly keymap: Plugin.Context['keymap']
  readonly renderer: Plugin.Context['renderer']
  /** Resolves the caller's promise and closes the dialog, in that order and once. */
  readonly done: (choice: SendChoice | undefined) => void
}

/** The header: what this dialog is, and the pointer close the reader asked for. */
function dialogHeader(props: SendDialogProps): unknown {
  return jsx('box', {
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: [
      jsx('text', { fg: props.tones.base, children: props.title }),
      jsx('text', {
        fg: props.tones.muted,
        children: '✕ close',
        // mouse-up, like the host's own dialog esc controls and the panel's open-once
        // control - the toggles' mousedown-only rule is for toggles.
        onMouseUp: (event: MouseEvent) => {
          event.stopPropagation()
          props.done(undefined)
        },
      }),
    ],
  })
}

/** One clickable key, and the bytes a choice of it sends without the typed line. */
function keyChip(props: SendDialogProps, label: string, bytes: string): unknown {
  return jsx('box', {
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: props.tones.raised,
    children: jsx('text', {
      fg: props.tones.base,
      // The handler sits on the TEXT, not on the box: a box without its own height in a
      // flex row is a hit area of no rows, and a click on it answers nothing. It is
      // inside the host dialog's inner box, so a mouse-down that sends cannot be closed
      // by its own mouse-up (the inner box stops the release).
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation()
        props.done({ kind: 'keys', bytes })
      },
      children: ` ${label} `,
    }),
  })
}

/** The keys the reader asked for, as clickable bytes, and what they mean. */
function dialogKeys(props: SendDialogProps): unknown {
  return jsx('box', {
    flexDirection: 'row',
    gap: 1,
    // A medium dialog is 60 columns and the six chips are wider than one row, so the
    // host's own dialogs wrap here too (`flexWrap` in dialog-shell-output): without it
    // the last chip left the drawn box entirely, measured.
    flexWrap: 'wrap',
    children: props.keys.map((key) => keyChip(props, key.label, key.bytes)),
  })
}

/**
 * The field the layers aim at, or nothing: `isDestroyed` counts as no field, so a layer
 * left from a replacement dialog stays inert rather than holding a dead renderable.
 */
function dialogField(
  textareaTarget: () => TextareaRenderable | undefined
): TextareaRenderable | undefined {
  const current = textareaTarget()
  return current !== undefined && !current.isDestroyed ? current : undefined
}

/**
 * The two layers the dialog lives under while it is open: enter submits the field, and
 * escape walks out.
 *
 * `mode: 'modal'`, priority 1 and the field as target: the pose the host's own dialog
 * prompt uses, so enter submits the field instead of a newline landing inside a one-row
 * box, and escape walks out - including out of a selection the reader may have started
 * between lines.
 */
function registerDialogKeys(
  props: SendDialogProps,
  field: () => TextareaRenderable | undefined
): void {
  props.keymap.layer(() => ({
    mode: 'modal',
    target: field,
    enabled: field() !== undefined,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        // The host's own keybind config names this id for the return key, so giving the
        // command the id is what binds it; the same id `dialog.prompt.submit` is bound
        // in `../opencode/packages/tui/src/config/keybind.ts`.
        id: 'dialog.prompt.submit',
        title: 'Send the line',
        group: 'opencode-pty',
        run: (): void => {
          const current = field()
          if (current === undefined) return
          // An empty field is a press of nothing - the enter chip is how a bare enter
          // is sent, and silently closing on an empty submit would feel like losing
          // what the reader typed.
          if (current.plainText.trim().length === 0) return
          props.done({ kind: 'line', line: current.plainText })
        },
      },
    ],
  }))
  props.keymap.layer(() => ({
    mode: 'modal',
    priority: 1,
    commands: [
      {
        bind: 'escape',
        title: 'Close the send dialog',
        group: 'opencode-pty',
        run: (): void => {
          // A selection release belongs to the selection, not to the dialog: the same
          // first key the host's dialog prompt answers with.
          if (props.renderer.getSelection()) {
            props.renderer.clearSelection()
            return
          }
          props.done(undefined)
        },
      },
    ],
  }))
}

/**
 * The dialog as a Solid component.
 *
 * The props travel as a record, because opentui's `jsx` types built-ins only and a
 * component of our own is a shape the d.ts does not name; the fields are read through
 * typed snapshots below.
 */
function SendDialog(raw: Record<string, unknown>): unknown {
  const props: SendDialogProps = {
    tones: raw.tones as Tones,
    title: raw.title as string,
    description: raw.description as string,
    keys: raw.keys as SendDialogProps['keys'],
    keymap: raw.keymap as Plugin.Context['keymap'],
    renderer: raw.renderer as Plugin.Context['renderer'],
    done: raw.done as (choice: SendChoice | undefined) => void,
  }
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const field = (): TextareaRenderable | undefined => dialogField(textareaTarget)
  registerDialogKeys(props, field)

  onMount(() => {
    // One tick of delay, exactly like the host's own dialogs: the box has to be laid
    // out before it can hold focus.
    void setTimeout(() => {
      const current = field()
      if (current === undefined) return
      current.focus()
      current.gotoLineEnd()
    }, 1)
  })
  onCleanup(() => setTextareaTarget(undefined))

  return jsx('box', {
    flexDirection: 'column',
    width: '100%',
    gap: 1,
    children: [
      dialogHeader(props),
      jsx('text', { fg: props.tones.muted, children: props.description }),
      dialogKeys(props),
      jsx('textarea', {
        height: 1,
        width: '100%',
        wrapMode: 'none',
        placeholder: 'q',
        ref: setTextareaTarget,
      }),
      jsx('text', {
        fg: props.tones.muted,
        children: '↑ keys send at once · enter submit · esc close',
      }),
    ],
  })
}

/**
 * Show the dialog and settle with what the reader chose.
 *
 * The settling order is the point: a choice resolves the promise FIRST and closes the
 * dialog after, so a dismissal and a submission cannot interleave - and a choice that
 * arrives after anything already settled (the host's onClose on a replacement) resolves
 * nothing and closes nothing, leaving whatever dialog is actually open open.
 */
export function openSendDialog(
  context: Plugin.Context,
  request: SendDialogRequest
): Promise<SendChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (choice: SendChoice | undefined): void => {
      if (settled) return
      settled = true
      resolve(choice)
      context.ui.dialog.clear()
    }
    // opentui's `jsx` types built-ins; a component of our own is a shape the d.ts does
    // not name, and the cast is where that is declared rather than guessed.
    context.ui.dialog.show(
      () =>
        jsx(SendDialog as JsxComponent, {
          tones: request.tones,
          title: request.title,
          description: request.description,
          keys: KEY_ACTIONS,
          keymap: context.keymap,
          renderer: context.renderer,
          done,
        }),
      () => {
        if (settled) return
        settled = true
        resolve(undefined)
      }
    )
  })
}

/** The one line a line-choice converts into, its enter appended once. */
export function toLinePayload(line: string): string {
  // A line that already carries its newline is sent as it stands, so a reader who
  // pasted two lines is not handed a third blank one - and a single line without one
  // is closed by a carriage return, which the line discipline makes the enter the
  // program reads.
  return line.endsWith('\n') || line.endsWith('\r') ? line : `${line}\r`
}
