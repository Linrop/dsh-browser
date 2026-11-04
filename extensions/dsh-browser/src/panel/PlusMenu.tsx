import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Composer "add" entry: a round plus button that opens an upward menu, matching
 * the DSH Web GUI composer. Image insertion stays the only actionable item;
 * the paste/drop hint is a non-interactive note row.
 */
export interface PlusMenuProps {
  /** Accessible name of the trigger. */
  label: string
  /** Accessible name of the popup menu. */
  menuLabel: string
  /** Menu item label that starts the image picker. */
  addImagesLabel: string
  /** Why image insertion is unavailable; disables the item and shows a tooltip. */
  imageUnavailable: string | null
  /** Non-interactive explanation row about pasting and dropping images. */
  hint: string
  /** Disables the whole control, e.g. while a turn is running. */
  disabled?: boolean
  onPickImages: () => void
}

interface MenuPosition {
  left: number
  bottom: number
}

function PlusGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  )
}

/** Keeps the fixed menu on screen while it is anchored above the trigger. */
function menuPosition(trigger: HTMLButtonElement | null): MenuPosition {
  const rect = trigger?.getBoundingClientRect()
  const width = 240
  const viewportWidth = typeof window === 'undefined' ? width : window.innerWidth
  const left = rect === undefined ? 8 : Math.max(8, Math.min(rect.left, viewportWidth - width - 8))
  const top = rect === undefined ? 0 : rect.top
  return { left, bottom: Math.max(8, window.innerHeight - top + 6) }
}

export function PlusMenu({
  label,
  menuLabel,
  addImagesLabel,
  imageUnavailable,
  hint,
  disabled = false,
  onPickImages,
}: PlusMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>({ left: 8, bottom: 8 })
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    setPosition(menuPosition(triggerRef.current))
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    const first = items?.[0]
    if (first !== undefined) first.focus()
    else menuRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onResize = (): void => { setPosition(menuPosition(triggerRef.current)) }
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  /** Moves focus across enabled menu items, wrapping at both ends. */
  function moveFocus(step: 1 | -1): void {
    const menu = menuRef.current
    if (menu === null) return
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = current === -1 ? 0 : (current + step + items.length) % items.length
    items[next]?.focus()
  }

  function openMenu(): void {
    setOpen(true)
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu()
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(-1)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  const imageDisabled = imageUnavailable !== null

  return (
    <span className="composer-plus" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="plus-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setOpen((current) => !current) }}
        onKeyDown={onTriggerKeyDown}
      >
        <PlusGlyph />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="plus-menu"
          role="menu"
          aria-label={menuLabel}
          tabIndex={-1}
          style={{ left: `${position.left}px`, bottom: `${position.bottom}px` }}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="plus-menu-item"
            disabled={imageDisabled}
            title={imageUnavailable ?? undefined}
            onClick={() => {
              setOpen(false)
              onPickImages()
            }}
          >
            {addImagesLabel}
          </button>
          {imageDisabled && (
            <div className="plus-menu-reason" role="note">{imageUnavailable}</div>
          )}
          <div className="plus-menu-hint" role="note">{hint}</div>
        </div>
      )}
    </span>
  )
}
