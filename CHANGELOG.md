# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- MiLight / LimitlessLED lamps through their Wi-Fi bridge, on the local
  network: v6 bridges (iBox 1 and 2, UDP 5987) and legacy v3 to v5 bridges
  (UDP 8899).
- One Gladys light per kind and zone: RGB+CCT (on/off, brightness, colour,
  white temperature, v6), RGBW (on/off, brightness, colour), dual white
  (on/off), the lamp of the iBox 1 bridge.
- The assumed state on the badge of each lamp (the bulbs never answer).
- "Off" first, sent three times, independent of the configuration read (the
  bridge address is kept in /data), sent again every 30 s for 10 min when the
  v6 bridge does not acknowledge it, restart included.
- The MAC address of the v6 bridge pinned: another bridge at the address gets
  "off" only until "Test the bridge" is pressed twice.
- "Test the bridge" button; a v6 bridge checked at most every 5 min.

[Unreleased]: https://github.com/LM1LC3N7/gladys-milight/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-milight/releases/tag/v0.1.1
