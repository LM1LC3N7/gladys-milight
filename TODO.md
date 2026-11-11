# TODO — MiLight

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm run audit`, `npm run mutants`, then
  update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum post from a module session (one post per wave in /t/10385).

## Status

- [x] **Milestone 1 — core** (2026-11-11, lot 22): v6 and legacy bridges
      over UDP; RGB+CCT, RGBW, dual white zones and the iBox 1 lamp as Gladys
      lights; protective "off" (first, three sends, held in /data and sent
      again every 30 s for 10 min); MAC pin of the v6 bridge; Test button;
      v6 check every 5 min; badges "assumed state"; docs en/fr; cover.
      Tested against a simulated bridge only (Node 24 and 22).
- [ ] **Milestone 2 — real bridge**: try a v6 and a legacy bridge; check the
      colour wheel offsets, the white temperature direction (0 = 2700 K), the
      saturation direction (0 = full colour), whether a brightness order to
      an "off" v6 bulb lights it, the session lifetime (30 s assumed).
- [ ] **Milestone 3 — more**: zone 0 ("all") as one device per kind, night
      mode and effects as a select (not a switch), RGB+CCT 8-zone remote
      (type 0x0A), several bridges, discovery of the bridges (UDP broadcast
      on 48899 is refused today: only with an explicit button and a decision).
- [ ] `keywords` / `countries` and `gladys_version >= 5.3.0` once Gladys 5.3 is
      widespread.

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) for the first milestone, as the lot asks; from now on the
  Release workflow owns it.
- **SDK `^0.16.0`** (latest on npm on 2026-11-11).
- **Reference**: the LimitlessLED developer page (the live page and its
  archive.org copy could not be reached on 2026-11-11: written from the
  protocol as documented, every order code cross-checked against
  node-milight-promise 0.3.2, MIT, latest version, frozen since 2019). Only
  the v6 colour offsets come from that library (THIRD_PARTY_NOTICES.md).
- **No "confirmed" command**: the bulbs never answer. Features are
  `has_feedback: false` (Gladys saves the value of a command that succeeds);
  the badge of every lamp says "assumed state". Success = acknowledged by a v6
  bridge, or sent to a legacy one. After a brightness, colour or temperature
  command, `binary = 1` is published (the order lit the lamp).
- **"Off" is the protective command** (lighting is not a sensitive command:
  nothing behind an option). Never refused but when no bridge is known or the
  kind does not exist on the bridge. Sent three times (0, 0.5 s, 1.5 s),
  each resend skipped only when a newer command of the lamp has left. Not
  acknowledged: held in /data (wall-clock time of the click) and sent again
  every 30 s for 10 min, restart included (it is not a movement: replaying an
  "off" is safe); a newer command of the lamp that left drops it. Confirmed
  late: `binary = 0` published.
- **Ids**: kind and zone only (`lamp:rgbw-2`), never the address: a new address
  or a replaced bridge keeps the devices.
- **Identity (v6)**: the MAC of the first session is pinned in /data. Another
  MAC: every command but "off" refused, checked right before each datagram;
  "Test the bridge" twice within 2 min accepts it (refused if /data cannot be
  written). /data unreadable: no pin learnt, the non-protective v6 commands
  refused, read again every 10 s. Legacy bridges have no identity.
- **Brightness 1..100**: 0 is not "off" on a MiLight (the minimum level);
  refused, not mapped to "off".
- **Dual white**: on/off only (brightness and temperature are relative steps).
- **No broadcast**: IPv4 unicast only (`.0`, `.255`, multicast, 0.0.0.0
  refused); no discovery.
- **Timings**: 100 ms between datagrams; v6 acknowledgement awaited 600 ms,
  a command sent once more if missing (never over a newer one); every answer
  to Gladys within 3.4 s.
