import { describe, expect, test } from 'bun:test'
import { runAnchorClear, runAnchorSet, type SectionInput } from './anchor-runner.ts'
import { MockChannel } from './__mocks__/mock-channel.ts'

const passthrough = (s: string): string[] => (s.length === 0 ? [s] : [s])

const splitAt = (every: number) => (s: string) => {
  if (s.length === 0) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length; i += every) out.push(s.slice(i, i + every))
  return out
}

/** Test helper: build SectionInput[] from positional bodies. Tests that don't
 *  care about titles use this; tests that DO care set them explicitly. */
const sec = (...bodies: string[]): SectionInput[] =>
  bodies.map((body, i) => ({ title: `s${i}`, body }))

describe('runAnchorSet — initial set', () => {
  test('creates one message per single-chunk section', async () => {
    const ch = new MockChannel()
    const result = await runAnchorSet(ch, [], sec('hello', 'world'), passthrough)
    expect(result.created).toBe(2)
    expect(result.edited).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.next.sections.length).toBe(2)
    expect(result.next.sections.flatMap(s => s.messageIds).length).toBe(2)
    expect(ch.liveMessages().map(m => m.content)).toEqual(['hello', 'world'])
  })

  test('splits an oversize section across multiple message IDs', async () => {
    const ch = new MockChannel()
    const result = await runAnchorSet(
      ch,
      [],
      sec('xxxxxxxxxxxxxxxxxxxx'), // 20 chars
      splitAt(7),
    )
    expect(result.created).toBe(3) // 7+7+6
    expect(result.next.sections[0]?.messageIds.length).toBe(3)
    const live = ch.liveMessages().map(m => m.content)
    expect(live).toEqual(['xxxxxxx', 'xxxxxxx', 'xxxxxx'])
  })
})

describe('runAnchorSet — edit-in-place', () => {
  test('edits existing single-chunk section without re-creating', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'old text')
    const prev = [{ messageIds: ['m1'] }]
    const result = await runAnchorSet(ch, prev, sec('new text'), passthrough)
    expect(result.created).toBe(0)
    expect(result.edited).toBe(1)
    expect(result.deleted).toBe(0)
    expect(result.next.sections[0]?.messageIds).toEqual(['m1'])
    expect(ch.store.get('m1')?.content).toBe('new text')
  })

  test('skips the edit call when content is unchanged', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'identical')
    const prev = [{ messageIds: ['m1'] }]
    const result = await runAnchorSet(ch, prev, sec('identical'), passthrough)
    expect(result.edited).toBe(0)
    expect(result.created).toBe(0)
    expect(ch.store.get('m1')?.edits).toBe(0)
  })

  test('falls through to send when an existing message was deleted manually', async () => {
    const ch = new MockChannel()
    const seeded = ch.seed('m1', 'gone')
    seeded.deleted = true
    const prev = [{ messageIds: ['m1'] }]
    const result = await runAnchorSet(ch, prev, sec('fresh'), passthrough)
    expect(result.created).toBe(1)
    expect(result.next.sections[0]?.messageIds).not.toContain('m1')
  })
})

describe('runAnchorSet — growth and shrink', () => {
  test('section growth appends new chunks (caveat: at end of channel)', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'aaa')
    const prev = [{ messageIds: ['m1'] }]
    const result = await runAnchorSet(
      ch,
      prev,
      sec('aaabbbccc'), // 9 chars
      splitAt(3),
    )
    expect(result.next.sections[0]?.messageIds.length).toBe(3)
    expect(result.next.sections[0]?.messageIds[0]).toBe('m1') // edit-in-place
    expect(result.created).toBe(2) // two new chunks appended
  })

  test('section shrink deletes surplus chunks', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'a')
    ch.seed('m2', 'b')
    ch.seed('m3', 'c')
    const prev = [{ messageIds: ['m1', 'm2', 'm3'] }]
    const result = await runAnchorSet(ch, prev, sec('only one'), passthrough)
    expect(result.next.sections[0]?.messageIds).toEqual(['m1'])
    expect(result.deleted).toBe(2)
    expect(ch.store.get('m2')?.deleted).toBe(true)
    expect(ch.store.get('m3')?.deleted).toBe(true)
  })

  test('dropping a trailing section deletes its messages', async () => {
    const ch = new MockChannel()
    ch.seed('a1', 'A')
    ch.seed('b1', 'B')
    const prev = [{ messageIds: ['a1'] }, { messageIds: ['b1'] }]
    const result = await runAnchorSet(ch, prev, sec('A'), passthrough)
    expect(result.next.sections.length).toBe(1)
    expect(result.deleted).toBe(1)
    expect(ch.store.get('b1')?.deleted).toBe(true)
  })

  test('adding a new trailing section sends and tracks it', async () => {
    const ch = new MockChannel()
    ch.seed('a1', 'A')
    const prev = [{ messageIds: ['a1'] }]
    const result = await runAnchorSet(ch, prev, sec('A', 'B'), passthrough)
    expect(result.next.sections.length).toBe(2)
    expect(result.created).toBe(1)
  })
})

describe('runAnchorSet — empty section handling', () => {
  test('empty section body does not throw — substitutes a placeholder', async () => {
    const ch = new MockChannel()
    const result = await runAnchorSet(ch, [], sec(''), passthrough)
    expect(result.created).toBe(1)
    expect(ch.liveMessages()[0]?.content.length).toBeGreaterThan(0)
  })
})

describe('runAnchorSet — partial-failure', () => {
  test('attaches partial state to thrown error so caller can persist progress', async () => {
    const ch = new MockChannel()
    ch.failOnSend = 2 // succeed for section 0, fail mid-way through section 1
    let captured: { partial?: unknown } | null = null
    try {
      await runAnchorSet(ch, [], sec('ok', 'will-fail'), passthrough)
    } catch (err) {
      captured = err as { partial?: unknown }
    }
    expect(captured).not.toBeNull()
    const partial = captured?.partial as { next: unknown; created: number } | undefined
    expect(partial).toBeTruthy()
    expect(partial?.created).toBe(1)
  })

  test('preserves un-iterated prev tail so retries can reconcile it', async () => {
    const ch = new MockChannel()
    ch.seed('a1', 'A')
    ch.seed('b1', 'B')
    ch.seed('c1', 'C')
    // Force a send failure when we attempt to overflow section 0 onto a 2nd chunk
    ch.failOnSend = 1
    const prev = [
      { messageIds: ['a1'] },
      { messageIds: ['b1'] },
      { messageIds: ['c1'] },
    ]
    let partial: { next: { sections: { messageIds: string[] }[] } } | undefined
    try {
      await runAnchorSet(ch, prev, sec('AABBCC'), splitAt(3))
    } catch (err) {
      partial = (err as { partial?: typeof partial }).partial
    }
    expect(partial).toBeTruthy()
    // section 0 was being modified; un-iterated sections 1 & 2 must survive
    // in the persisted record so a future call still owns 'b1' and 'c1'.
    const persistedIds = partial!.next.sections.flatMap(s => s.messageIds)
    expect(persistedIds).toContain('b1')
    expect(persistedIds).toContain('c1')
  })
})

describe('runAnchorSet — onSent hook', () => {
  test('invoked for every newly-sent message', async () => {
    const ch = new MockChannel()
    const sent: string[] = []
    await runAnchorSet(ch, [], sec('a', 'b', 'c'), passthrough, {
      onSent: id => sent.push(id),
    })
    expect(sent.length).toBe(3)
  })
})

describe('runAnchorSet — rich section metadata', () => {
  test('persists title + per-chunk preview onto the AnchorSection', async () => {
    const ch = new MockChannel()
    const sections: SectionInput[] = [
      {
        title: 'Plan',
        body: 'item one\nitem two',
        messages: [{ preview: 'roadmap' }],
      },
    ]
    const result = await runAnchorSet(ch, [], sections, passthrough)
    expect(result.next.sections[0]?.title).toBe('Plan')
    expect(result.next.sections[0]?.messages?.[0]?.preview).toBe('roadmap')
  })

  test('pin: true invokes channel.pin on the landed message', async () => {
    const ch = new MockChannel()
    const sections: SectionInput[] = [
      {
        title: 'Pinned',
        body: 'top of board',
        messages: [{ pin: true }],
      },
    ]
    const result = await runAnchorSet(ch, [], sections, passthrough)
    const id = result.next.sections[0]?.messageIds[0]!
    expect(ch.store.get(id)?.pinned).toBe(true)
  })

  test('pin failure surfaces via onPinError but does not abort the run', async () => {
    const ch = new MockChannel()
    ch.failOnPin = 1 // first pin throws
    const errors: string[] = []
    const sections: SectionInput[] = [
      {
        title: 'Will fail',
        body: 'one',
        messages: [{ pin: true }],
      },
      { title: 'Continues', body: 'two' },
    ]
    const result = await runAnchorSet(ch, [], sections, passthrough, {
      onPinError: (id, _err) => errors.push(id),
    })
    expect(errors.length).toBe(1)
    expect(result.next.sections.length).toBe(2) // run continued past pin failure
  })

  test('preview hint shorter than chunk count does not trip', async () => {
    const ch = new MockChannel()
    const sections: SectionInput[] = [
      {
        title: 'Two chunks',
        body: 'aaaaaaa', // 7 chars → 2 chunks at split=4
        messages: [{ preview: 'first' }], // hint for 1 of 2 chunks
      },
    ]
    const result = await runAnchorSet(ch, [], sections, splitAt(4))
    expect(result.next.sections[0]?.messages?.length).toBe(2)
    expect(result.next.sections[0]?.messages?.[0]?.preview).toBe('first')
    expect(result.next.sections[0]?.messages?.[1]?.preview).toBeUndefined()
  })
})

describe('runAnchorSet — pin transitions', () => {
  test('unpins a previously-pinned message when next call drops the pin flag', async () => {
    const ch = new MockChannel()
    const seeded = ch.seed('m1', 'hello')
    seeded.pinned = true
    // prev section records the pin state we last applied (pinned: true).
    const prev = [{ messageIds: ['m1'], messages: [{ id: 'm1', pinned: true }] }]
    const result = await runAnchorSet(
      ch,
      prev,
      [{ title: 's', body: 'hello' /* no pin hint -> desired=false */ }],
      passthrough,
    )
    expect(ch.store.get('m1')?.pinned).toBe(false)
    expect(result.pinned).toBe(1) // counts unpin as a successful pin op
    expect(result.next.sections[0]?.messages?.[0]?.pinned).toBeUndefined()
  })

  test('persists pinned: true on the next AnchorMessage when pin is requested', async () => {
    const ch = new MockChannel()
    const result = await runAnchorSet(
      ch,
      [],
      [{ title: 's', body: 'top', messages: [{ pin: true }] }],
      passthrough,
    )
    expect(result.next.sections[0]?.messages?.[0]?.pinned).toBe(true)
  })

  test('reports pinFailed when discord pin throws', async () => {
    const ch = new MockChannel()
    ch.failOnPin = 1
    const result = await runAnchorSet(
      ch,
      [],
      [{ title: 's', body: 'one', messages: [{ pin: true }] }],
      passthrough,
    )
    expect(result.pinFailed).toBe(1)
    expect(result.pinned).toBe(0)
    expect(result.next.sections[0]?.messages?.[0]?.pinned).toBeUndefined()
  })
})

describe('runAnchorSet — migration carry', () => {
  test('partial-failure carry normalizes legacy {messageIds-only} prev sections', async () => {
    const ch = new MockChannel()
    ch.seed('a1', 'A')
    ch.seed('b1', 'B')
    ch.failOnSend = 1 // fail when section 0 needs a 2nd chunk
    // section 1 is a LEGACY shape — messages absent, only messageIds.
    const prev = [
      { messageIds: ['a1'] },
      { messageIds: ['b1'] },
    ]
    let partial: { next: { sections: { messageIds: string[]; messages?: { id: string }[] }[] } } | undefined
    try {
      await runAnchorSet(ch, prev, sec('AABBCC'), splitAt(3))
    } catch (err) {
      partial = (err as { partial?: typeof partial }).partial
    }
    expect(partial).toBeTruthy()
    // Carried legacy section must have BOTH shapes populated post-normalize.
    const carried = partial!.next.sections[1]!
    expect(carried.messageIds).toEqual(['b1'])
    expect(carried.messages).toEqual([{ id: 'b1' }])
  })
})

describe('runAnchorClear', () => {
  test('deletes every recorded message', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'a')
    ch.seed('m2', 'b')
    ch.seed('m3', 'c')
    const result = await runAnchorClear(ch, [
      { messageIds: ['m1', 'm2'] },
      { messageIds: ['m3'] },
    ])
    expect(result.deleted).toBe(3)
    expect(result.failed).toBe(0)
    expect(ch.liveMessages()).toEqual([])
  })

  test('counts already-gone messages as failed but keeps going', async () => {
    const ch = new MockChannel()
    ch.seed('m1', 'a')
    const seeded = ch.seed('m2', 'b')
    seeded.deleted = true
    const result = await runAnchorClear(ch, [{ messageIds: ['m1', 'm2'] }])
    expect(result.deleted).toBe(1)
    expect(result.failed).toBe(1)
  })
})
