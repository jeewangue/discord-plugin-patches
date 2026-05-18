# discord-plugin-patches

Patches to the official `claude-plugins-official/discord` MCP plugin (base
version `0.0.4`). Adds extra tools, hardens reply chunking, and persists
state for editable thread anchors.

## What's in here

| File / dir               | Purpose                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `server.ts`              | Patched plugin entry. Imports pure logic from `lib/`, glues to discord.js + MCP transport.             |
| `lib/chunk.ts`           | Code-block-aware chunker (`\`\`\``/`~~~` fences with language tags, surrogate-pair safe).              |
| `lib/file-lock.ts`       | `withFileLock(path, fn, opts)` — `fs.openSync('wx')` + mtime heartbeat + stale-lock steal.             |
| `lib/anchors.ts`         | `readAnchors`, `saveAnchors` (unique tmp), `withAnchorLock`, `commitThreadRecord`.                     |
| `lib/anchor-runner.ts`   | Pure `runAnchorSet` / `runAnchorClear` taking a `ChannelLike` interface; mockable.                     |
| `lib/__mocks__/`         | `MockChannel` for tests.                                                                               |
| `lib/*.test.ts`          | `bun:test` suite (47 tests: chunk fences, file-lock concurrency, anchor commit, runner partial-fail).  |
| `Makefile`               | Wrappers for `install`, `test`, `build`, `apply`, `check-drift`, `typecheck`, `ci`.                    |
| `scripts/apply.sh`       | Copies `server.ts` + runtime `lib/*.ts` (excludes tests / `__mocks__`) onto the cached plugin install. |
| `scripts/check-drift.sh` | `diff -u` between patched and installed `server.ts` + runtime `lib/` files. Exit 1 on any drift.       |
| `package.json`           | Dev deps (matched to upstream so types resolve cleanly under `bun`).                                   |

## Apply / re-apply

```bash
make install         # bun install (first time only)
make apply           # cp server.ts onto the cached plugin
# then restart Claude Code, or run /reload-plugins inside it
```

Override the install path if your version differs:

```bash
make apply PLUGIN_VERSION=0.0.5
make apply PLUGIN_DIR=/custom/path/to/discord
```

`make check-drift` prints the diff and exits 1 if the cached plugin no longer
matches `server.ts` — useful as a CI step or pre-commit guard so an
upstream update doesn't quietly stomp the patches.

## Tools added on top of upstream

All upstream tools (`reply`, `react`, `edit_message`, `download_attachment`,
`fetch_messages`, `create_thread`, `thread_members`) still work. The patches
add or tighten the following.

### `search_messages` — keyword/regex/author/attachment scan

Discord's bot API has no full-text search, so this tool paginates through
`fetch_messages` client-side and filters in-process. Each page is one REST
call (100 messages); default scans 5 pages (~500 messages back) but can go
deeper via `max_pages`.

```jsonc
{
  "channel": "1496379522054885417",
  "query": "lualatex",          // case-insensitive substring
  "regex": "lua(la)?tex",       // alternative; takes precedence over query
  "author_id": "399362457858211851",
  "has_attachment": true,
  "before": "<message_id>",     // cap newest
  "after":  "<message_id>",     // stop scanning beyond this oldest
  "max_pages": 10,              // default 5, max 20
  "max_results": 50             // default 20, max 100
}
```

### `list_threads` — enumerate active (and archived) threads

```jsonc
{ "chat_id": "<channel_id>", "include_archived": false }
```

### `update_thread` — edit thread metadata

Pass any subset of `name`, `archived`, `locked`, `auto_archive_duration`
(60/1440/4320/10080), `rate_limit_per_user`. Parent channel must be
allowlisted via `/discord:access`.

### `pin_message` — pin or unpin

Discord caps pinned messages at 50/channel; pinning when full surfaces a
clean error.

```jsonc
{ "chat_id": "...", "message_id": "...", "action": "pin" }
```

### `delete_message` — retract a bot message

Counterpart to `edit_message` for the case where shrinking is the right
move (interim "starting…" line after the final result has landed; an
obsolete progress update inside a running TODO summary). Refuses to
delete messages authored by anyone other than the bot itself, so the
tool can never be used to remove user content even if the bot holds
`ManageMessages`.

```jsonc
{ "chat_id": "...", "message_id": "..." }
```

### `todo_anchor_set` / `todo_anchor_get` / `todo_anchor_clear` — living thread anchors

The right tool for a "Todo / Followups", status board, or rolling summary
thread. Pass an ordered array of section bodies; the patch keeps message
IDs stable across calls — sections are edited in place, oversize ones
auto-split into multiple ≤2000-char chunks (newline + code-fence-aware),
surplus messages are deleted. **Sections are positionally identified**:
index `N` means the same logical section across calls — reordering
scrambles the rendered thread.

State persists in `~/.claude/channels/discord/anchors.json`, keyed by
thread ID. Reads + writes are file-locked (`~/.claude/channels/discord/locks/`)
with a 5-second heartbeat and 30-second stale-steal, so two concurrent
agents (or two parallel sessions) can't race on the same anchor — same-key
holders serialize, different threads run in parallel.

The bot can only update messages it authored; anything you or others
posted in the thread is left alone.

```jsonc
// Initial set: 3 sections, each becomes one anchor message (or more if
// over the chunk limit).
{
  "thread_id": "1496379522054885417",
  "sections": [
    "## Active\n- [ ] foo\n- [ ] bar",
    "## Backlog\n- baz",
    "## Notes\n_last update: 2026-04-25_"
  ]
}

// Subsequent calls edit those same message IDs in place. Supply fewer
// sections to drop trailing ones (their messages get deleted).
```

**Caveat — order drift on growth.** If a section grows past its current
chunk count, the new chunks are appended to the bottom of the thread (not
inserted between siblings) since Discord doesn't allow reordering. If
visual ordering matters, call `todo_anchor_clear` first and re-`set` to
rebuild from scratch.

```jsonc
// todo_anchor_get — inspect existing anchor (e.g. when resuming a session)
{ "thread_id": "1496379522054885417", "include_bodies": true, "max_chunks": 50 }

// todo_anchor_clear — nuke messages and drop state
{ "thread_id": "1496379522054885417" }
```

### `reply` — auto-split at 2000 chars (code-fence aware)

Already in upstream's chunker; the patches:

- Make `chunkMode='newline'` **code-fence aware**: when a cut would land
  inside a fenced \`\`\` (or ~~~) block, the chunker emits a closing fence
  on the current chunk and reopens with the same delimiter + language tag
  on the next. Tilde fences and surrogate-pair (emoji) cuts are also
  handled.
- Tighten the tool description so the model sees "auto-splits at 2000 chars
  (Discord hard cap), set `chunkMode='newline'` for paragraph + code-fence
  splits" in the schema rather than discovering it by trial and error.
- Update the server `instructions` block with the same guidance, plus an
  explicit warning that **Discord does NOT render markdown tables** —
  prefer bullet lists with bold field labels for tabular data.

Configure split mode in `~/.claude/channels/discord/access.json`:

```json
{
  "chunkMode": "newline",
  "textChunkLimit": 1900,
  "replyToMode": "first",
  "ackReaction": "👀"
}
```

`chunkMode: "newline"` (recommended) prefers paragraph (`\n\n`) → line
(`\n`) → space boundaries when splitting and balances code fences.
`length` is the upstream default and may hard-cut mid-token / mid-fence.

### `fetch_messages` — works for channels and threads

Same upstream tool, clearer description. Pass a channel ID for top-level
messages, or a thread ID for thread-only history — the two scopes are
disjoint (a thread is its own message list, not a subset of the parent
channel).

### Inbound notification: reply / forward context

When a user uses Discord's *reply* feature (or *forward*), the inbound
`<channel …>` tag delivered to the MCP client now carries enough metadata
that the model can answer a bare "yes" or "do it" coherently — the body
in isolation is opaque, but combined with the referenced message it lands.

Fields surfaced on the inbound:

- `reply_to_message_id` — always set when the message is a reply / forward.
- `reply_to_user` / `reply_to_user_id` — author of the referenced message.
- `reply_to_preview` — single-line, ≤200-char preview of the referenced
  message body (newlines collapsed to a visible ⏎, control chars stripped,
  surrogate-pair safe).
- `reply_to_attachment_count` — attachment count of the referenced message
  (only emitted when > 0).
- `reply_to_channel_id` — only emitted on cross-channel forwards.
- `reply_to_unavailable="true"` — referenced message was deleted or
  unreachable; you have the ID but not the content.

Fetch is best-effort: a deleted reference or missing perms still emits
the ID with `reply_to_unavailable=true` so the model isn't blind to the
fact that this *was* a reply.

## Tests + CI

```bash
make test           # bun test lib/ (69 tests)
make build          # bun build → dist/server.bundle.js (sanity check)
make verify-apply   # clean-room smoke: apply into mktemp, assert imports resolve
make check-drift    # diff deploy-manifest files against the install
make check-deps     # assert every deployed import is declared in plugin package.json
make ci             # install + test + build + check-drift + verify-apply
```

`scripts/deploy-manifest.sh` is the single source of truth for what `make
apply` ships. `apply.sh` and `check-drift.sh` both consume it, so adding a
new runtime `lib/*.ts` requires no edits to either script — drop the file
and it's automatically deployed and drift-checked.

`make verify-apply` (wired into `ci`) catches the class of bug where the
deploy contract drifts from the import graph: it deploys the patches into
a fresh `mktemp` dir and runs `bun build` to assert every relative + bare
module import resolves cleanly. Non-zero exit on any unresolved import.

`make check-deps` is intentionally **not** wired into `ci`. It surfaces
one known finding — `zod` is imported in `server.ts` but only declared
in the upstream plugin's `package.json` as a transitive of
`@modelcontextprotocol/sdk@^1.0.0` (currently `1.27.1`, which still
ships `zod`). This is **accepted risk**: vendoring a patched
`package.json` would couple the patch repo to upstream's full dep
matrix, and dropping `zod` would require a parser swap. If a future
`@mcp/sdk` release drops `zod`, the bot will fail to load with
`Cannot find module 'zod'` — at that point either patch the plugin's
`package.json` (and add it to `deploy-manifest.sh`) or replace the
single use of `z` in `server.ts` with hand-rolled validation. Run
`make check-deps` periodically as a watchdog.

Tests cover:
- chunk: empty/short/long input, code-fence boundaries (backtick + tilde),
  language tags, multiple consecutive blocks, single fence longer than
  limit, surrogate-pair safety, edge cases (`limit+1`, `limit<8`).
- file-lock: serialization in same process, throws on timeout, steals
  stale lock, cleans up on success and on throw.
- anchors: round-trip, malformed JSON tolerated, parallel saves don't
  clobber tmp, per-key parallelism, same-key serialization, two parallel
  commits on different threads preserve both.
- anchor-runner: initial set, edit-in-place (skipped when content
  unchanged), fall-through to send when prev message was deleted, growth
  appends, shrink deletes surplus, dropping a trailing section deletes
  its messages, empty section uses placeholder, partial-failure attaches
  recoverable state including un-iterated `prev` tail.

## Bot permissions required

On top of upstream's required scopes:

- `ManageMessages` — for `pin_message`
- `ManageThreads` — for `create_thread` (private), `thread_members`,
  `update_thread`
- `ReadMessageHistory` — for `fetch_messages` and `search_messages` (already
  required by upstream)

## Base version

`claude-plugins-official/discord@0.0.4`. When you bump versions, run
`make check-drift` to see what upstream changed before re-merging the
patches.
