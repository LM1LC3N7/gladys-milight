// -----------------------------------------------------------------------------
// Fixed values of the integration: ports, timings, bounds, the kinds of lamps.
// Times are in milliseconds of the monotonic clock unless said otherwise.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** The two families of Wi-Fi bridges. */
export const VERSIONS = { V6: 'v6', LEGACY: 'legacy' };

/** Default UDP ports (LimitlessLED developer page). */
export const PORTS = { [VERSIONS.V6]: 5987, [VERSIONS.LEGACY]: 8899 };

/**
 * The kinds of lamps, one Gladys device per kind and zone:
 *   fullColor  RGB+CCT (RGBWW) bulbs and strips, v6 bridge only
 *   rgbw       RGBW bulbs and strips, both bridges
 *   white      dual white (CCT) bulbs: on and off only (their brightness is
 *              a step up or down, never a level)
 *   bridgeLamp the lamp built into the iBox 1 bridge, v6 only, no zone
 */
export const KINDS = {
  FULL_COLOR: 'fullColor',
  RGBW: 'rgbw',
  WHITE: 'white',
  BRIDGE_LAMP: 'bridgeLamp',
};

/** Which bridge drives which kind. */
export const KIND_VERSIONS = {
  [KINDS.FULL_COLOR]: [VERSIONS.V6],
  [KINDS.RGBW]: [VERSIONS.V6, VERSIONS.LEGACY],
  [KINDS.WHITE]: [VERSIONS.V6, VERSIONS.LEGACY],
  [KINDS.BRIDGE_LAMP]: [VERSIONS.V6],
};

/** The features of each kind. */
export const FEATURES = {
  BINARY: 'binary',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  TEMPERATURE: 'temperature',
};

export const KIND_FEATURES = {
  [KINDS.FULL_COLOR]: [FEATURES.BINARY, FEATURES.BRIGHTNESS, FEATURES.COLOR, FEATURES.TEMPERATURE],
  [KINDS.RGBW]: [FEATURES.BINARY, FEATURES.BRIGHTNESS, FEATURES.COLOR],
  [KINDS.WHITE]: [FEATURES.BINARY],
  [KINDS.BRIDGE_LAMP]: [FEATURES.BINARY, FEATURES.BRIGHTNESS, FEATURES.COLOR],
};

/** Zones of a bridge (remote groups 1 to 4). */
export const ZONES = [1, 2, 3, 4];

/** Colour temperature, in mireds (Gladys slider: cold on the left). 6500 K .. 2700 K. */
export const MIRED = { min: 153, max: 370 };
export const KELVIN = { cold: 6500, warm: 2700 };

/** Brightness in Gladys: 1 to 100 % (0 would not be "off" on a MiLight). */
export const BRIGHTNESS = { min: 1, max: 100 };

export const TIMINGS = {
  /** Pause between two datagrams to the bridge (it drops commands sent faster). */
  gap: 100,
  /** Wait for the acknowledgement of a v6 command before sending it again. */
  ackWait: 600,
  /** Wait for the answer to a v6 session request. */
  sessionWait: 700,
  /** Session requests per attempt. */
  sessionTries: 2,
  /** A v6 session not used since this long is asked again before a command. */
  sessionFresh: 30 * SECOND,
  /** Gladys stops waiting at 5 s: every command is answered before this. */
  ackBudget: 3400,
  /** A command not started this long after its arrival is dropped, unsent. */
  startBudget: 2800,
  /** Sends of an "off": at once, then these delays after the first. */
  offResends: [500, 1500],
  /** An "off" not confirmed: tried again this often... */
  heldRetry: 30 * SECOND,
  /** ...for this long at most after the click (wall clock, kept in /data). */
  heldFor: 10 * MINUTE,
  /** The v6 bridge is checked (one session request) at most this often. */
  checkInterval: 5 * MINUTE,
  /** /data unreadable: read again this often. */
  storeRetry: 10 * SECOND,
  /** getConfig() failed: tried again after 5 s, doubled up to 60 s. */
  configRetryMin: 5 * SECOND,
  configRetryMax: MINUTE,
  /** The "Test" button: at most once per this. */
  testSpacing: 5 * SECOND,
  /** Second click that accepts a bridge with another MAC address: within this. */
  acceptWithin: 2 * MINUTE,
};

export const LIMITS = {
  /** Non-protective commands waiting at most (beyond: refused, nothing sent). */
  queue: 40,
  /** Largest datagram read from the bridge (its answers are 8 to 22 bytes). */
  datagram: 64,
  /** States published per minute (Gladys accepts 300). */
  statesPerMinute: 250,
  /** Length of a badge or status message. */
  message: 180,
  /** Size of the /data file read. */
  storeBytes: 16 * 1024,
};

export const ACTIONS = { TEST: 'test_bridge' };
