// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Reads one declaration block by exact selector, first match wins. */
function ruleBody(stylesheet: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
}

describe('panel stylesheet integrity', () => {
  it('is brace-balanced so no rule is swallowed by a stray block', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    expect(styles.split('{').length - 1).toBe(styles.split('}').length - 1)
  })

  it('keeps the session title as a content-sized pill', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const rule = styles.match(/\.session-menu-trigger\s*\{([^}]*)\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/(?:^|\n)\s*width:\s*max-content;/)
    expect(rule).toMatch(/(?:^|\n)\s*border-radius:\s*999px;/)
  })
})

describe('panel layout styles', () => {
  it('places an upward model menu on its own row under the composer', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const modelRule = styles.match(/\.composer-model\s*\{([^}]*)\}/)?.[1]
    const menuRule = styles.match(/\.composer-model-menu\s*\{([^}]*)\}/)?.[1]

    expect(modelRule).toBeDefined()
    expect(modelRule).toMatch(/(?:^|\n)\s*position:\s*relative;/)
    expect(modelRule).toMatch(/(?:^|\n)\s*margin-top:\s*8px;/)
    expect(menuRule).toBeDefined()
    expect(menuRule).toMatch(/(?:^|\n)\s*position:\s*absolute;/)
    expect(menuRule).toMatch(/(?:^|\n)\s*bottom:\s*calc\(100% \+ 6px\);/)
  })

  it('keeps the composer on the narrow-screen input card geometry', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const wrapper = ruleBody(styles, '.composer')
    const card = ruleBody(styles, '.composer-box')
    const textarea = ruleBody(styles, '.composer textarea')
    const actions = ruleBody(styles, '.composer-actions')
    const control = ruleBody(styles, '.composer-actions button')
    const attachment = ruleBody(styles, '.composer-actions button.attachment-button')
    const model = ruleBody(styles, '.composer-model-trigger')

    expect(wrapper).toMatch(/padding:\s*0 8px 4px;/)
    expect(wrapper).not.toMatch(/background:/)

    expect(card).toMatch(/border:\s*0;/)
    expect(card).toMatch(/border-radius:\s*20px;/)
    expect(card).toMatch(/gap:\s*12px;/)
    expect(card).toMatch(/padding-top:\s*8px;/)
    expect(card).toMatch(/inset 0 0 0 1px rgba\(0, 0, 0, 0\.08\)/)

    expect(textarea).toMatch(/padding:\s*4px 8px 0 14px;/)
    expect(textarea).toMatch(/min-height:\s*36px;/)
    expect(textarea).toMatch(/line-height:\s*24px;/)
    expect(textarea).toMatch(/margin-right:\s*4px;/)

    expect(actions).toMatch(/flex-wrap:\s*wrap;/)
    expect(actions).toMatch(/justify-content:\s*space-between;/)
    expect(actions).toMatch(/gap:\s*8px;/)
    expect(actions).toMatch(/padding:\s*2px 8px 6px;/)

    expect(control).toMatch(/width:\s*34px;/)
    expect(control).toMatch(/height:\s*34px;/)
    expect(control).toMatch(/border-radius:\s*999px;/)
    expect(control).toMatch(/background:\s*var\(--blue\);/)

    expect(attachment).toMatch(/width:\s*28px;/)
    expect(attachment).toMatch(/height:\s*28px;/)
    expect(attachment).toMatch(/border-radius:\s*999px;/)

    expect(model).toMatch(/height:\s*28px;/)
    expect(model).toMatch(/border:\s*0;/)
    expect(model).toMatch(/background:\s*transparent;/)

    expect(ruleBody(styles, '.composer-box > .page-selection')).toMatch(/padding:\s*0 14px;/)
    expect(ruleBody(styles, '.draft-images')).toMatch(/padding:\s*0 14px;/)
  })

  it('renders no composer help line', () => {
    const app = readFileSync(`${process.cwd()}/src/panel/App.tsx`, 'utf8')
    expect(app).not.toContain('copy.app.composerHelp')
  })
})
