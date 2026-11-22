# Dot

Dot is a Prism desktop-automation plugin backed by the native ChatGPT Dot main conversation. Dot and Codex use the same Hub-managed ChatGPT window. Dot verifies its room before sending messages or reading history.

The manifest targets Hub 0.1.24 or later and Node 22.13.1 through 22.x. The shared desktop host helper is staged in `shared/desktop-host.cjs` when packaging the plugin.

Run `npm ci && npm test` for the adapter, renderer and protocol checks.

The plugin exposes one pinned conversation. Its durable delivery ledger prevents replaying a Prism message ID after a submit attempt, including across process restarts.
