import { describe, expect, test } from 'bun:test'
import { chunk } from './chunk.ts'

const LIMIT = 100 // small enough that every test deliberately overflows

describe('chunk: basics', () => {
  test('empty string returns single empty chunk', () => {
    expect(chunk('', LIMIT, 'length')).toEqual([''])
    expect(chunk('', LIMIT, 'newline')).toEqual([''])
  })

  test('shorter than limit returns single chunk', () => {
    expect(chunk('hello', LIMIT, 'length')).toEqual(['hello'])
    expect(chunk('hello', LIMIT, 'newline')).toEqual(['hello'])
  })

  test('exactly limit returns single chunk', () => {
    const text = 'a'.repeat(LIMIT)
    expect(chunk(text, LIMIT, 'length')).toEqual([text])
  })

  test('limit + 1 splits into two', () => {
    const text = 'a'.repeat(LIMIT + 1)
    const result = chunk(text, LIMIT, 'length')
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.join('').length).toBe(LIMIT + 1)
  })
})

describe('chunk: length mode', () => {
  test('long unbroken string hard-splits at limit', () => {
    const text = 'a'.repeat(LIMIT * 3 + 17)
    const result = chunk(text, LIMIT, 'length')
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(LIMIT)
    }
    expect(result.join('').length).toBe(text.length)
  })
})

describe('chunk: newline mode', () => {
  test('prefers paragraph boundaries', () => {
    const text =
      'paragraph one with some content here.\n\n' +
      'paragraph two with similar content.\n\n' +
      'paragraph three rounds it out for the test.'
    const result = chunk(text, 80, 'newline')
    // Each chunk should end at a paragraph or line boundary, not mid-word.
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(80)
    }
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test('falls back to line boundaries', () => {
    const text =
      'line one\nline two\nline three\nline four\nline five\nline six'
    const result = chunk(text, 30, 'newline')
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(30)
    }
  })

  test('falls back to space boundaries when no newlines', () => {
    const text = 'word '.repeat(40).trim()
    const result = chunk(text, 30, 'newline')
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(30)
      // Each piece should end (or start) on a word boundary
      expect(piece.endsWith(' ')).toBe(false)
    }
  })
})

describe('chunk: fenced code blocks', () => {
  test('closes and reopens backtick fence at boundary', () => {
    const filler = 'a'.repeat(60)
    const code = 'b'.repeat(60)
    const text = `prose intro line\n\n\`\`\`rust\n${filler}\n${code}\n\`\`\`\n`
    const result = chunk(text, 80, 'newline')
    expect(result.length).toBeGreaterThanOrEqual(2)
    // Every chunk must have balanced fences.
    for (const piece of result) {
      const fences = piece.match(/```/g) ?? []
      expect(fences.length % 2).toBe(0)
    }
    // Reopen must preserve the language tag.
    expect(result.slice(1).every(p => p.includes('```rust') || !p.includes('```'))).toBe(true)
  })

  test('handles tilde fences', () => {
    const filler = 'x'.repeat(60)
    const code = 'y'.repeat(60)
    const text = `intro\n\n~~~js\n${filler}\n${code}\n~~~\n`
    const result = chunk(text, 80, 'newline')
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const piece of result) {
      const fences = piece.match(/~~~/g) ?? []
      expect(fences.length % 2).toBe(0)
    }
  })

  test('handles back-to-back fenced blocks', () => {
    const text =
      '```ts\nconst a = 1\n```\n\n' +
      'middle\n\n' +
      '```py\nb = 2\n```\n'
    const result = chunk(text, 40, 'newline')
    for (const piece of result) {
      const backticks = piece.match(/```/g) ?? []
      expect(backticks.length % 2).toBe(0)
    }
  })

  test('does not break inline backticks', () => {
    const text = 'use the `foo()` method to bar the `baz`. '.repeat(10)
    const result = chunk(text, 80, 'newline')
    // Inline backticks (single) should never trigger fence handling — count
    // triple-backtick sequences only.
    for (const piece of result) {
      expect(piece.match(/```/g)).toBeNull()
    }
  })

  test('joining all chunks recovers (more or less) the original payload', () => {
    const text =
      `Header\n\n\`\`\`rust\n${'x'.repeat(50)}\nfn main() {}\n${'y'.repeat(60)}\n\`\`\`\n\nfooter`
    const result = chunk(text, 100, 'newline')
    // After stripping all the close+reopen overhead, content order is preserved.
    const reassembled = result
      .map(p => p.replace(/```\w*\n?/g, ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    const original = text.replace(/```\w*\n?/g, '').replace(/\s+/g, ' ').trim()
    expect(reassembled).toBe(original)
  })
})

describe('chunk: surrogate-pair safety', () => {
  test('does not split a multi-codeunit emoji', () => {
    const emoji = '🎵' // U+1F3B5, two UTF-16 code units
    const filler = 'a'.repeat(LIMIT - 1)
    const text = filler + emoji + 'rest'
    const result = chunk(text, LIMIT, 'length')
    expect(result.join('')).toContain(emoji)
    // No chunk may end with a high surrogate or start with a low surrogate.
    const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
    const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
    for (const piece of result) {
      if (piece.length === 0) continue
      expect(isHigh(piece.charCodeAt(piece.length - 1))).toBe(false)
      expect(isLow(piece.charCodeAt(0))).toBe(false)
    }
  })
})

describe('chunk: pathological inputs', () => {
  test('single fence longer than limit still terminates', () => {
    // 500 chars of content inside a fence, limit 80. The chunker should
    // make forward progress even though every cut is inside the fence.
    const inner = 'z'.repeat(500)
    const text = `\`\`\`txt\n${inner}\n\`\`\``
    const result = chunk(text, 80, 'newline')
    expect(result.length).toBeGreaterThan(1)
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(80 + 10) // small overshoot tolerated
      const backticks = piece.match(/```/g) ?? []
      expect(backticks.length % 2).toBe(0)
    }
  })

  test('limit less than 8 falls back to char split', () => {
    const text = 'abcdefghij'
    const result = chunk(text, 4, 'length')
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(4)
    }
    expect(result.join('')).toBe(text)
  })
})
