# Acceptance tests

Owned by the product/E2E reviewer. These are black-box tests: they start the real
server entrypoint and assert observable HTTP, SSE, and browser behavior. They do
not import owner internals, and they never touch a deployed instance.

## Running

```bash
bun test tests/acceptance          # black-box HTTP/SSE suite, disposable SQLite
bun tests/acceptance/browser/run.ts            # opt-in browser loop (agent-browser)
bun tests/acceptance/browser/run.ts --discover # inspect the rendered page and exit
```

The suite spawns `packages/server/src/main.ts` on a free loopback port with a
temporary data directory and a synthetic owner token, then deletes the directory.
No production credentials are read: the child process gets a minimal environment.

`browser/run.ts` is opt-in on purpose. It needs Chromium and `agent-browser`, so it
is not part of `bun run verify` and must not be turned into a silent skip. It
reports each step as pass, fail, or blocked; blocked means the driver could not
find a surface it needs and is never counted as a pass.

## Layout

| File                    | Role                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `harness.ts`            | server lifecycle, authenticated fetch, durable SSE reader                                |
| `contract.ts`           | the only module encoding the wire contract                                               |
| `fixtures.ts`           | synthetic worked-example tangle with a mutual entanglement                               |
| `graph-surface.test.ts` | the graph surface exists and starts empty                                                |
| `graph-loop.test.ts`    | capture, live stream, replay, conflicts, direction, cycles, reframe, undo, restart, auth |
| `browser/run.ts`        | the rendered loop: capture, expand, reframe, undo, restart, narrow layout                |

## Rules these tests encode

- A machine judgment or suggestion is never an assertion, and confidence is never
  permission to apply one.
- Only blocking relations affect the blocking interpretation; reframing keeps the
  original assertion, the rationale, and the idea.
- Cycles are meaningful input, not errors.
- Revision conflicts reject atomically; replays are idempotent; undo respects
  intervening edits.
- Sources and captures are never mutated by node edits, and archived nodes keep
  their references.
- Everything recovers after a restart: revision, nodes, edges, positions,
  corrections, and history.
