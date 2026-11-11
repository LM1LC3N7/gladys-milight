# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It drives MiLight / LimitlessLED lamps through
their Wi-Fi bridge over UDP, on the local network.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npm run mutants                           # mutation check (scripts/mutants.json), use memcap
```

## Architecture

```
index.js            SDK wiring only (src/handlers.js registers before connect())
src/handlers.js     the SDK handlers -> MilightApp (shared with the tests)
src/app.js          configuration, /data, commands, the protective "off", badges, status
src/link.js         one UDP socket per bridge: priorities, gaps, v6 sessions and acknowledgements
src/protocol.js     bytes of the protocol (pure)
src/devices.js      lamps -> Gladys devices, external ids, value checks (pure)
src/config.js       the configuration normalized (pure)
src/store.js        /data (pin, held offs, last check)
src/i18n.js         every text shown, en/fr
test/helpers/fakeBridge.js   simulated bridge on 127.0.0.1 (real UDP), sped-up real clock
scripts/            cover.png generator, mutation runner and its list
```

## Rules

- **External ids are forever**: `ext:<selector>:lamp:<kind>-<zone>`; never the
  address of the bridge.
- **"Off" is never blocked**: no option, no configuration read, no /data read,
  no identity check, no queue bound in front of it. A change that adds a
  condition to `off()` or to the protective path of `src/link.js` needs a test
  that the off still leaves.
- **Nothing older after an "off"**: queued commands of the lamp are cancelled,
  the resend of a command checks `overtaken()`.
- **Never a broadcast**: one unicast IPv4 address, no `setBroadcast`.
- **Clocks**: decisions on the monotonic clock; the wall clock only for /data
  (restart). Tests run on a sped-up real clock; no wait on an unbounded
  promise.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  the four places agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs kept in sync
  with the code.
