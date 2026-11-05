import { useEffect, useRef } from 'react'

/** One row of the composer command menu. */
export interface CommandMenuRow {
  /** Host command name without the slash. */
  name: string
  /** Localized label shown first. */
  label: string
  /** Host-provided summary; may be empty. */
  description: string
}

/**
 * Composer command menu: the `/`-triggered list of Host commands, rendered
 * above the composer and driven by the textarea's own key handling so the
 * caret never leaves the draft.
 */
export interface CommandMenuProps {
  /** Group heading, mirroring the Web GUI's commands section. */
  heading: string
  /** Accessible name of the list. */
  label: string
  /** Rows to show, already ranked and filtered. */
  rows: readonly CommandMenuRow[]
  /** Row the keyboard or pointer selected. */
  activeIndex: number
  /** Row pick handler; the index addresses `rows`. */
  onPick: (index: number) => void
  /** Pointer hover handler; the index addresses `rows`. */
  onHover: (index: number) => void
}

/** Scrolls the active row into view without moving the page. */
function keepVisible(container: HTMLElement | null, active: HTMLElement | null): void {
  if (container === null || active === null) return
  const top = active.offsetTop
  const bottom = top + active.offsetHeight
  if (top < container.scrollTop) container.scrollTop = top
  else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight
  }
}

/** Stable id of the list container, referenced by the textarea's `aria-controls`. */
export const COMMAND_MENU_ID = 'composer-command-menu'

/** DOM id of one menu option, shared with the textarea's `aria-activedescendant`. */
export function optionId(name: string): string {
  return `command-option-${name}`
}

/** The `/` command list above the composer. */
export function CommandMenu(props: CommandMenuProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? null
    keepVisible(listRef.current, active)
  }, [props.activeIndex, props.rows])

  return (
    <div className="command-menu">
      {/* The heading is chrome, not an option, so it stays outside the listbox. */}
      <div className="command-menu-heading" role="presentation">{props.heading}</div>
      <div className="command-menu-rows" id={COMMAND_MENU_ID} role="listbox" aria-label={props.label} ref={listRef}>
        {props.rows.map((row, index) => (
          <button
            key={row.name}
            id={optionId(row.name)}
            type="button"
            role="option"
            aria-selected={index === props.activeIndex}
            data-active={index === props.activeIndex}
            className="command-menu-row"
            // mousedown keeps the textarea focused: a click would blur it and
            // close the menu before the pick lands.
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => props.onPick(index)}
            onMouseEnter={() => props.onHover(index)}
          >
            <span className="command-menu-label">{row.label}</span>
            <span className="command-menu-name">{row.name}</span>
            {row.description === '' ? null : <span className="command-menu-description">{row.description}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
