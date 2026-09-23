# Node colors

The server graph owns node colors. Web, desktop and mobile render the same
saved choices with the existing palette and neighbor blending algorithm.
Desktop uses the web renderer. Client preferences are no longer the authority
for color.

## Wire contract

- `NodeInput.color` and `Node.color` are optional six-digit hex strings or
  `null`. Saved strings are lowercase. An absent property identifies a legacy
  node without an imported choice; `null` explicitly selects the status color.
- Captures include the chosen color in the same command that creates the node.
  All clients use the existing web creation default, the first palette swatch.
- `node.paint` accepts `colors: [{ id, color }]`, from one to 100 entries.
  Duplicate IDs are invalid. Ordinary paint rejects nonexistent nodes.
- `onlyIfUnset: true` is for legacy imports: it writes only when the current
  server node has no `color` property. It skips deleted nodes and never replaces
  an existing hex value or explicit `null`.
- Paint uses the existing authenticated command endpoint, revision checks,
  actor-scoped request replay, transaction journal and SSE notifications.
  It does not create a second database or change the layout API.
- Colors survive ordinary node edits from clients that omit the new property.
  Cosmetic edits leave content provenance unchanged and do not ask Jev to
  reconnect the node. Graph exports include the saved colors.

## Local preference migration

After an authenticated snapshot, clients import valid colors from their former
local storage in bounded batches. They retire entries only after a confirmed
write or a server snapshot proving the entry already resolved. A failed import
keeps the local values available for retry. Session replacement cancels the old
migration work.

Concurrent imports are resolved on the server: the first saved choice wins.
There are no trustworthy timestamps in the old preferences. A subsequent
deliberate picker edit replaces that choice through the normal command path.
Clients retire imported preferences to avoid redundant import attempts.
Undoing a paint that began on a legacy unset node records an explicit `null`
status choice. This server-side barrier prevents another device's later import,
or a retry after a lost response, from reversing that Undo or a status reset.

## Release order

Build and validate the server, web, desktop and mobile changes together.
Deploying the server or publishing client artifacts is a separate release step.
Existing native app installations require an update; they do not acquire new
renderer or protocol code merely by reconnecting to the server.

Older clients lack the `node.paint` command in their history decoder. Update
all active clients before the first import or paint write. Their old local
color maps are migration inputs; do not clear their browser or app data during
the update.
