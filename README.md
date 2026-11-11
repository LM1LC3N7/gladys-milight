# MiLight for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration that
drives **MiLight / LimitlessLED** lamps through their **Wi-Fi bridge** (iBox
v6, or the legacy v3 to v5 bridges), on the local network (UDP): on, off,
brightness, colour and white temperature.

Unofficial, not affiliated with MiLight, Futlight or LimitlessLED. It has
**never been tested with a real bridge** yet: written from the protocol
published by LimitlessLED, tested against a simulated bridge.

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- MiLight bulbs give **no feedback**: Gladys shows the last command as an
  **assumed** state (badge with an orange dot).
- "Off" goes first, is sent three times, does not depend on the configuration
  being read, and, when the bridge does not acknowledge it, is sent again
  every 30 s for 10 min (restart included). See the guide for the exact cases
  where it is refused.
- No account, no password, no cloud.

## Development

```bash
npm install
npm test            # node --test (simulated UDP bridge on 127.0.0.1, sped-up real clock)
npm run lint
npm run format:check
npm run cover       # cover.png, 800×534, plain Node
npm run mutants     # mutation check of the guards (scripts/mutants.json), one at a time
```

See `CLAUDE.md` for the architecture and the rules, `TODO.md` for the state
and the decisions.

## Credits

The protocol is the one published on the LimitlessLED developer page. The
colour offsets of the v6 bulbs come from
[node-milight-promise](https://github.com/mwittig/node-milight-promise) (MIT,
Marcus Wittig). See `THIRD_PARTY_NOTICES.md`.
