// -----------------------------------------------------------------------------
// The lamps chosen in the configuration -> Gladys devices (pure).
//
// One Gladys device per kind and zone (a zone is a group of the remote: every
// bulb paired to it obeys together), a `light`:
//   binary       light/binary       on, off
//   brightness   light/brightness   1..100 %   (not on dual white bulbs)
//   color        light/color        0xRRGGBB   (not on dual white bulbs)
//   temperature  light/temperature  153..370 mireds (RGB+CCT only)
// Every feature is written only (`has_feedback: false`): MiLight bulbs never
// say their state, Gladys shows the last command (the badge says so).
//
// Identity rule (frozen: it fixes the external ids): the kind and the zone,
// never the address of the bridge (a new address keeps the devices):
//   device   ext:<selector>:lamp:<fullcolor|rgbw|white>-<1..4>   ext:<selector>:lamp:bridgelamp
//   feature  <device>:<binary|brightness|color|temperature>
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { BRIGHTNESS, FEATURES, KIND_FEATURES, KINDS, MIRED, ZONES } from './constants.js';
import { featureLabel, kindLabel } from './i18n.js';

const SLUGS = {
  [KINDS.FULL_COLOR]: 'fullcolor',
  [KINDS.RGBW]: 'rgbw',
  [KINDS.WHITE]: 'white',
};
const KIND_OF_SLUG = Object.fromEntries(Object.entries(SLUGS).map(([k, s]) => [s, k]));
const BRIDGE_LAMP_ID = 'bridgelamp';

/** The platform id of a lamp: `rgbw-2`, `bridgelamp`. */
export const lampId = ({ kind, zone }) =>
  kind === KINDS.BRIDGE_LAMP ? BRIDGE_LAMP_ID : `${SLUGS[kind]}-${zone}`;

/** The reverse of lampId, or undefined. */
export function lampOf(id) {
  if (id === BRIDGE_LAMP_ID) return { kind: KINDS.BRIDGE_LAMP, zone: 0 };
  const match = /^([a-z]+)-([1-4])$/.exec(id ?? '');
  const kind = match && Object.hasOwn(KIND_OF_SLUG, match[1]) ? KIND_OF_SLUG[match[1]] : undefined;
  return kind && ZONES.includes(Number(match[2])) ? { kind, zone: Number(match[2]) } : undefined;
}

export const lampIds = (gladys, lamp) => gladys.externalIds('lamp', lampId(lamp));

/**
 * `{ kind, zone, key }` of an external id of this integration (key undefined
 * for a device), or undefined. Prefix and parts matched exactly.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  const prefix = gladys.externalId('');
  if (!externalId.startsWith(prefix)) return undefined;
  const [type, id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (type !== 'lamp' || rest.length > 0) return undefined;
  const lamp = lampOf(id);
  if (!lamp) return undefined;
  if (key !== undefined && !KIND_FEATURES[lamp.kind].includes(key)) return undefined;
  return { ...lamp, key };
}

const FEATURE_SPECS = {
  [FEATURES.BINARY]: { type: T.LIGHT.BINARY, min: 0, max: 1 },
  [FEATURES.BRIGHTNESS]: { type: T.LIGHT.BRIGHTNESS, min: BRIGHTNESS.min, max: BRIGHTNESS.max },
  [FEATURES.COLOR]: { type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
  [FEATURES.TEMPERATURE]: { type: T.LIGHT.TEMPERATURE, min: MIRED.min, max: MIRED.max },
};

/** The name of a lamp in Gladys. */
export const lampName = (lamp, language = 'fr') =>
  lamp.kind === KINDS.BRIDGE_LAMP
    ? kindLabel(lamp.kind, language)
    : `${kindLabel(lamp.kind, language)} - zone ${lamp.zone}`;

/** The Gladys device of a lamp. */
export function buildLamp(gladys, lamp, { language = 'fr' } = {}) {
  const ids = lampIds(gladys, lamp);
  return {
    name: lampName(lamp, language),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'MILIGHT_KIND', value: lamp.kind },
      { name: 'MILIGHT_ZONE', value: String(lamp.zone) },
    ],
    features: KIND_FEATURES[lamp.kind].map((key) => ({
      name: featureLabel(key, language),
      external_id: ids.feature(key),
      category: C.LIGHT,
      ...FEATURE_SPECS[key],
      read_only: false,
      has_feedback: false,
      keep_history: key === FEATURES.BINARY,
    })),
  };
}

/**
 * A value sent by Gladys, checked: a finite number in [min, max] (never null,
 * '' nor a boolean: they are not 0), rounded for the integers. Undefined if not.
 */
export function valueOf(key, raw) {
  if (typeof raw === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  const spec = FEATURE_SPECS[key];
  if (!spec || !Number.isFinite(n) || n < spec.min || n > spec.max) return undefined;
  if (key === FEATURES.BINARY) return n === 0 || n === 1 ? n : undefined;
  if (key === FEATURES.COLOR) return Number.isInteger(n) ? n : undefined;
  return Math.round(n);
}
