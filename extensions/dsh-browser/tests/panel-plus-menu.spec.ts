// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlusMenu, type PlusMenuProps } from '../src/panel/PlusMenu.tsx'

const onPickImages = vi.fn()
const onPickCommand = vi.fn()
const onOpen = vi.fn()

let root: Root
let container: HTMLDivElement

function render(overrides: Partial<PlusMenuProps> = {}): void {
  const props: PlusMenuProps = {
    label: 'Add to message',
    menuLabel: 'Add to message',
    addHeading: 'Add',
    commandHeading: 'Commands',
    commands: [],
    addImagesLabel: 'Add images',
    hint: 'Tip: you can paste or drop images straight into the composer.',
    imageUnavailable: null,
    onOpen,
    onPickImages,
    onPickCommand,
    ...overrides,
  }
  act(() => { root.render(createElement(PlusMenu, props)) })
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.plus-menu-trigger')
  if (button === null) throw new Error('plus trigger missing')
  return button
}

function menu(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="menu"]')
}

function item(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[role="menuitem"]')
  if (button === null) throw new Error('menu item missing')
  return button
}

function press(target: EventTarget, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.querySelector('#root')!
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { root.unmount() })
})

describe('composer plus menu', () => {
  it('starts closed with menu button semantics', () => {
    render()
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
  })

  it('opens on click and reports the expanded state', () => {
    render()
    act(() => { trigger().click() })
    expect(menu()).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(item().textContent).toBe('Add images')
  })

  it('starts the image picker from the menu item and closes', () => {
    render()
    act(() => { trigger().click() })
    act(() => { item().click() })
    expect(onPickImages).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('closes on Escape and restores focus to the trigger', () => {
    render()
    act(() => { trigger().click() })
    expect(document.activeElement).toBe(item())
    press(document, 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on a pointer-down outside the control', () => {
    render()
    act(() => { trigger().click() })
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(menu()).toBeNull()
  })

  it('keeps the item disabled with a reason while image input is unavailable', () => {
    render({ imageUnavailable: 'This dsh host does not advertise image input' })
    act(() => { trigger().click() })
    expect(item().disabled).toBe(true)
    expect(item().getAttribute('title')).toBe('This dsh host does not advertise image input')
    expect(container.textContent).toContain('This dsh host does not advertise image input')
    act(() => { item().click() })
    expect(onPickImages).not.toHaveBeenCalled()
  })

  it('opens from the keyboard and focuses the first item', () => {
    render()
    trigger().focus()
    press(trigger(), 'ArrowDown')
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(item())
  })

  it('leaves the menu open while the mouse moves inside it', () => {
    render()
    act(() => { trigger().click() })
    act(() => {
      item().dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(menu()).not.toBeNull()
  })

  it('cannot be opened while the control is disabled', () => {
    render({ disabled: true })
    expect(trigger().disabled).toBe(true)
  })
})

describe('composer plus menu command section', () => {
  const commands = [
    { name: 'goal', label: '目标', description: 'Set or view the goal' },
    { name: 'compact', label: '压缩', description: 'Compact older history' },
  ]

  it('lists the Host commands under a section heading', () => {
    render({ commands })
    act(() => { trigger().click() })
    const headings = [...container.querySelectorAll('.plus-menu-section')].map((node) => node.textContent)
    expect(headings).toEqual(['Add', 'Commands'])
    const rows = [...container.querySelectorAll('.plus-menu-command')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('目标')
    expect(rows[0]?.textContent).toContain('goal')
    expect(rows[0]?.textContent).toContain('Set or view the goal')
  })

  it('does not repeat the name when the label already is the name', () => {
    render({ commands: [
      { name: 'goal', label: 'goal', description: 'Set or view the goal' },
      { name: 'compact', label: '压缩', description: 'Compact' },
    ] })
    act(() => { trigger().click() })
    const rows = [...container.querySelectorAll('.plus-menu-command')]
    expect(rows[0]?.querySelectorAll('.plus-menu-command-name')).toHaveLength(0)
    expect(rows[1]?.querySelector('.plus-menu-command-name')?.textContent).toBe('compact')
  })

  it('completes the composer with the picked command and closes', () => {
    render({ commands })
    act(() => { trigger().click() })
    act(() => { container.querySelectorAll<HTMLButtonElement>('.plus-menu-command')[1]?.click() })
    expect(onPickCommand).toHaveBeenCalledWith(commands[1])
    expect(menu()).toBeNull()
  })

  it('asks for the catalogue when the menu opens, by click or keyboard', () => {
    render({ commands })
    act(() => { trigger().click() })
    act(() => { trigger().click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
    press(trigger(), 'ArrowDown')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('omits the command section when the Host offers none', () => {
    render()
    act(() => { trigger().click() })
    const headings = [...container.querySelectorAll('.plus-menu-section')].map((node) => node.textContent)
    expect(headings).toEqual(['Add'])
  })
})
