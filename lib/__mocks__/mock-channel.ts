import type { ChannelLike, MessageLike } from '../anchor-runner.ts'

export class MockMessage implements MessageLike {
  readonly id: string
  content: string
  deleted = false
  edits = 0
  pinned = false
  /** Back-pointer so pin()/unpin() can consult the channel's failOnPin counter. */
  channel?: MockChannel

  constructor(id: string, content: string) {
    this.id = id
    this.content = content
  }

  async edit(text: string): Promise<MessageLike> {
    if (this.deleted) throw new Error(`Unknown Message: ${this.id}`)
    this.content = text
    this.edits++
    return this
  }

  async delete(): Promise<unknown> {
    if (this.deleted) throw new Error(`Unknown Message: ${this.id}`)
    this.deleted = true
    return undefined
  }

  async pin(): Promise<unknown> {
    if (this.deleted) throw new Error(`Unknown Message: ${this.id}`)
    if (this.channel) {
      this.channel.pinCount++
      if (
        this.channel.failOnPin !== null &&
        this.channel.pinCount === this.channel.failOnPin
      ) {
        throw new Error('mock: simulated pin failure')
      }
    }
    this.pinned = true
    return undefined
  }

  async unpin(): Promise<unknown> {
    if (this.deleted) throw new Error(`Unknown Message: ${this.id}`)
    this.pinned = false
    return undefined
  }
}

export class MockChannel implements ChannelLike {
  readonly store = new Map<string, MockMessage>()
  /** Counter for auto-issued IDs. Starts at 1000 to avoid collision with
   *  arbitrary ids in tests. */
  private nextId = 1000
  /** Records every send/edit/delete for assertion. */
  readonly events: Array<
    | { kind: 'send'; id: string; content: string }
    | { kind: 'edit'; id: string; content: string }
    | { kind: 'delete'; id: string }
  > = []
  /** Optional fault injection — if `failOnSend(seq)` is set the corresponding
   *  send call will throw, simulating a Discord 5xx mid-loop. */
  failOnSend: number | null = null
  /** Same fault-injection idiom as failOnSend, but for pin attempts. */
  failOnPin: number | null = null
  pinCount = 0
  private sendCount = 0

  messages = {
    fetch: async (id: string): Promise<MessageLike> => {
      const m = this.store.get(id)
      if (!m || m.deleted) throw new Error(`Unknown Message: ${id}`)
      return m
    },
  }

  async send(opts: { content: string }): Promise<{ id: string }> {
    this.sendCount++
    if (this.failOnSend !== null && this.sendCount === this.failOnSend) {
      throw new Error('mock: simulated 5xx on send')
    }
    if (opts.content.length === 0) {
      throw new Error('Cannot send an empty message')
    }
    const id = String(this.nextId++)
    const msg = new MockMessage(id, opts.content)
    msg.channel = this
    this.store.set(id, msg)
    this.events.push({ kind: 'send', id, content: opts.content })
    return { id }
  }

  /** Helper for tests: pre-seed a message at a specific id. */
  seed(id: string, content: string): MockMessage {
    const m = new MockMessage(id, content)
    m.channel = this
    this.store.set(id, m)
    return m
  }

  /** Tests use this to record edits as they happen — wraps `MockMessage.edit`. */
  recordEditsThrough(): void {
    const orig = MockMessage.prototype.edit
    const ev = this.events
    MockMessage.prototype.edit = async function (text: string) {
      ev.push({ kind: 'edit', id: this.id, content: text })
      return orig.call(this, text)
    }
  }

  liveMessages(): MockMessage[] {
    return [...this.store.values()].filter(m => !m.deleted)
  }
}
