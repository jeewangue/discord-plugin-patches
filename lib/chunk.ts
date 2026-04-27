// Discord-aware text chunker: split long markdown so each piece fits Discord's
// 2000-char per-message cap without breaking fenced code blocks.
//
// Beyond simple length-based splitting, this:
//   1. Tracks ``` and ~~~ fenced code blocks (with optional language tags) so
//      a cut inside a fence emits a closing fence on the current chunk and
//      reopens the same fence on the next.
//   2. Avoids cutting inside a UTF-16 surrogate pair (emoji corruption).
//   3. In 'newline' mode, prefers paragraph (\n\n) → line (\n) → space cuts so
//      bullet lists and prose stay readable across chunk boundaries.

export type ChunkMode = 'length' | 'newline'

type FenceInfo = { delim: string; info: string }
type FenceTransition = { offset: number; state: FenceInfo | null }

// Discord (and CommonMark) fence rules: opening/closing fence is a line whose
// non-whitespace content starts with 3+ backticks or 3+ tildes. Up to 3 leading
// spaces of indent are tolerated. Closing fence must use the same character and
// be at least as long as the opener, and must have no info string.
const FENCE_RE = /^[ \t]{0,3}((?:`{3,})|(?:~{3,}))([^\n]*)$/

function scanFences(text: string): FenceTransition[] {
  // Each transition records the offset *after* the fence line — i.e. the
  // first character that is in the new state. Once `consumed >= transition`
  // the state has switched.
  const transitions: FenceTransition[] = []
  let state: FenceInfo | null = null
  let lineStart = 0
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)
    const m = FENCE_RE.exec(line)
    if (m) {
      const delim = m[1] as string
      const info = (m[2] ?? '').trim()
      if (state === null) {
        state = { delim, info }
        transitions.push({ offset: lineEnd + 1, state })
      } else if (
        delim[0] === state.delim[0] &&
        delim.length >= state.delim.length &&
        info === ''
      ) {
        state = null
        transitions.push({ offset: lineEnd + 1, state })
      }
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return transitions
}

function fenceAt(transitions: FenceTransition[], offset: number): FenceInfo | null {
  // State at `offset` = state after consuming everything strictly before
  // `offset`. Apply transitions whose post-line position is ≤ offset.
  let cur: FenceInfo | null = null
  for (const t of transitions) {
    if (t.offset > offset) break
    cur = t.state
  }
  return cur
}

// Don't cut between a high and low surrogate (emoji outside the BMP).
function backOffSurrogate(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut
  const c = text.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) return cut - 1
  return cut
}

function pickNewlineCut(window: string, hardCut: number): number {
  const para = window.lastIndexOf('\n\n')
  const line = window.lastIndexOf('\n')
  const space = window.lastIndexOf(' ')
  const half = hardCut / 2
  if (para > half) return para + 2 // include the blank line in the previous chunk
  if (line > half) return line + 1
  if (space > 0) return space + 1
  return hardCut
}

export function chunk(text: string, limit: number, mode: ChunkMode): string[] {
  if (limit < 8) {
    // Below this we can't reliably reserve fence overhead; fall back to a
    // brain-dead character split. The caller should never set limit this small.
    const out: string[] = []
    for (let i = 0; i < text.length; i += limit) {
      out.push(text.slice(i, i + limit))
    }
    return out.length === 0 ? [''] : out
  }
  if (text.length === 0) return ['']
  if (text.length <= limit) return [text]

  const transitions = scanFences(text)
  const out: string[] = []
  let pos = 0
  let prefix = ''

  while (pos < text.length) {
    const room = limit - prefix.length
    if (text.length - pos + prefix.length <= limit) {
      out.push(prefix + text.slice(pos))
      break
    }

    let cut = Math.min(pos + room, text.length)
    if (mode === 'newline') {
      const window = text.slice(pos, cut)
      cut = pos + pickNewlineCut(window, room)
    }

    let fAtCut = fenceAt(transitions, cut)
    let closeFence = ''
    let reopenFence = ''
    if (fAtCut) {
      closeFence = '\n' + fAtCut.delim
      reopenFence = fAtCut.delim + (fAtCut.info ? fAtCut.info : '') + '\n'
      const overhead = closeFence.length
      const reopenOverhead = reopenFence.length
      if (prefix.length + (cut - pos) + overhead > limit) {
        const adjustedRoom = Math.max(8, room - overhead)
        cut = pos + adjustedRoom
        if (mode === 'newline') {
          const window = text.slice(pos, cut)
          cut = pos + pickNewlineCut(window, adjustedRoom)
        }
        fAtCut = fenceAt(transitions, cut)
        if (fAtCut) {
          closeFence = '\n' + fAtCut.delim
          reopenFence = fAtCut.delim + (fAtCut.info ? fAtCut.info : '') + '\n'
        } else {
          closeFence = ''
          reopenFence = ''
        }
      }
      // Make sure the next chunk has at least 1 char of payload room.
      if (limit - reopenOverhead < 8) {
        // Pathological tiny limit: bail to char split for the rest.
        // Should never happen with the limit < 8 guard above + reasonable inputs.
        closeFence = ''
        reopenFence = ''
        fAtCut = null
      }
    }

    cut = backOffSurrogate(text, cut)
    if (cut <= pos) cut = pos + 1 // forward progress safeguard

    let piece = prefix + text.slice(pos, cut).replace(/[ \t]+$/, '')
    if (fAtCut) piece = piece.replace(/\n+$/, '') + closeFence

    out.push(piece)
    pos = cut
    // Skip leading whitespace on next chunk (don't lose newlines inside a fence
    // though — the reopen fence itself ends with \n so it's fine).
    while (pos < text.length && (text[pos] === '\n' || text[pos] === ' ' || text[pos] === '\t')) {
      pos++
    }
    prefix = reopenFence
  }

  return out
}
