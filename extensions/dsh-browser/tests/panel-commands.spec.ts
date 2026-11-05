// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  commandLabel,
  commandQuery,
  filterCommands,
  parseCommandCatalog,
  parseCommandLine,
  type CommandDescriptor,
} from '../src/panel/commands.ts'

const CATALOG: CommandDescriptor[] = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'config', description: 'Show configuration' },
  { name: 'export', description: 'Export the transcript' },
  { name: 'feedback', description: 'Send feedback' },
  { name: 'goal', description: 'Set or view the goal' },
  { name: 'plan', description: 'Enter plan mode' },
]

describe('parseCommandLine', () => {
  it('splits a slash line into its name and argument tail', () => {
    expect(parseCommandLine('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseCommandLine('  /export md  ')).toEqual({ name: 'export', args: 'md' })
  })

  it('rejects plain text, a bare slash, and a spaced name', () => {
    expect(parseCommandLine('compact')).toBeUndefined()
    expect(parseCommandLine('/')).toBeUndefined()
    expect(parseCommandLine('/ /')).toBeUndefined()
  })
})

describe('commandQuery', () => {
  it('opens only while the name is still being typed', () => {
    expect(commandQuery('/')).toBe('')
    expect(commandQuery('/co')).toBe('co')
    expect(commandQuery('/compact ')).toBeUndefined()
    expect(commandQuery('plain text')).toBeUndefined()
  })
})

describe('filterCommands', () => {
  it('ranks exact, prefix, then substring matches', () => {
    expect(filterCommands(CATALOG, 'co').map((entry) => entry.name)).toEqual(['compact', 'config'])
    expect(filterCommands(CATALOG, 'goal').map((entry) => entry.name)).toEqual(['goal'])
    // Prefix matches come first; substring matches keep the Host's order.
    expect(filterCommands(CATALOG, 'p').map((entry) => entry.name)).toEqual(['plan', 'compact', 'export'])
    expect(filterCommands(CATALOG, 'ort').map((entry) => entry.name)).toEqual(['export'])
  })

  it('returns every row in Host order for an empty query', () => {
    expect(filterCommands(CATALOG, '')).toEqual(CATALOG)
    expect(filterCommands(CATALOG, 'zzz')).toEqual([])
  })
})

describe('parseCommandCatalog', () => {
  it('accepts both the wrapped and bare shapes', () => {
    expect(parseCommandCatalog({ commands: CATALOG })).toEqual(CATALOG)
    expect(parseCommandCatalog(CATALOG)).toEqual(CATALOG)
  })

  it('drops malformed rows instead of poisoning the menu', () => {
    expect(parseCommandCatalog({
      commands: [
        { name: 'compact', description: 'Compact' },
        { name: '', description: 'empty name' },
        { name: 'two words', description: 'spaced name' },
        { name: 42 },
        null,
        { description: 'no name' },
      ],
    })).toEqual([{ name: 'compact', description: 'Compact' }])
    expect(parseCommandCatalog(undefined)).toEqual([])
    expect(parseCommandCatalog({})).toEqual([])
  })
})

describe('commandLabel', () => {
  it('localizes built-in names and leaves plugin names alone', () => {
    expect(commandLabel('compact', 'zh')).toBe('压缩')
    expect(commandLabel('goal', 'en')).toBe('goal')
    expect(commandLabel('my-plugin', 'zh')).toBe('my-plugin')
  })
})
