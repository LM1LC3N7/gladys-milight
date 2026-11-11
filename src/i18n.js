// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, refusals of commands, badges,
// feature and device names), in English and French. A value typed by the
// user is never shown back; the address of the bridge and its MAC address are
// not secrets (they are on the bridge's sticker and in the router).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const KIND_LABELS = {
  fullColor: { en: 'MiLight RGB+CCT', fr: 'MiLight RGB+CCT' },
  rgbw: { en: 'MiLight RGBW', fr: 'MiLight RGBW' },
  white: { en: 'MiLight dual white', fr: 'MiLight blanc double' },
  bridgeLamp: { en: 'MiLight bridge lamp', fr: 'Lampe du pont MiLight' },
};

const FEATURE_LABELS = {
  binary: { en: 'On / off', fr: 'Allumage' },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  color: { en: 'Colour', fr: 'Couleur' },
  temperature: { en: 'White temperature', fr: 'Température du blanc' },
};

export const kindLabel = (kind, language = 'fr') =>
  KIND_LABELS[kind]?.[language] ?? KIND_LABELS[kind]?.en ?? kind;
export const featureLabel = (key, language = 'fr') =>
  FEATURE_LABELS[key]?.[language] ?? FEATURE_LABELS[key]?.en ?? key;

/** Pairs joined by a space (undefined ones skipped), bounded. */
export function join(...pairs) {
  const list = pairs.filter(Boolean);
  const cut = (text) =>
    text.length > LIMITS.message ? `${text.slice(0, LIMITS.message - 1)}…` : text;
  return {
    en: cut(list.map((p) => p.en).join(' ')),
    fr: cut(list.map((p) => p.fr).join(' ')),
  };
}

/** A duration: "45 s", "3 min" (59.9 s is "1 min", never "60 s"). */
export function age(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

const where = (bridge) => `${bridge.host}:${bridge.port}`;

export const T = {
  noAddress: {
    en: 'Type the IP address of the MiLight bridge.',
    fr: 'Saisissez l’adresse IP du pont MiLight.',
  },
  invalidAddress: {
    en: 'The bridge address is not a valid IPv4 address (with an optional port).',
    fr: 'L’adresse du pont n’est pas une adresse IPv4 valide (port facultatif).',
  },
  broadcastAddress: {
    en: 'The bridge address is a broadcast, multicast or network address: type the address of the bridge itself.',
    fr: 'L’adresse du pont est une adresse de diffusion, de multidiffusion ou de réseau : saisissez celle du pont lui-même.',
  },
  noLamps: {
    en: 'No zone chosen: tick the zones of your lamps in the configuration.',
    fr: 'Aucune zone choisie : cochez les zones de vos lampes dans la configuration.',
  },
  skipped: {
    en: 'RGB+CCT lamps and the bridge lamp need a v6 bridge (iBox): not created.',
    fr: 'Les lampes RGB+CCT et la lampe du pont demandent un pont v6 (iBox) : non créées.',
  },
  configUnread: (ms) => ({
    en: `The configuration could not be read, tried again in ${age(ms)}.`,
    fr: `La configuration n’a pas pu être lue, nouvel essai dans ${age(ms)}.`,
  }),
  storeUnread: {
    en: 'The integration storage (/data) cannot be read: only "off" commands are sent until it reads again.',
    fr: 'Le stockage de l’intégration (/data) est illisible : seules les commandes « éteindre » partent jusqu’à ce qu’il se relise.',
  },
  storeUnwritable: {
    en: 'The integration storage (/data) cannot be written.',
    fr: 'Le stockage de l’intégration (/data) n’accepte pas l’écriture.',
  },
  legacyOk: (bridge) => ({
    en: `Legacy bridge (v3-v5) at ${where(bridge)}: it never answers, commands leave without confirmation.`,
    fr: `Pont ancien (v3-v5) à ${where(bridge)} : il ne répond jamais, les commandes partent sans confirmation.`,
  }),
  v6Ok: (mac) => ({
    en: `v6 bridge answered (MAC ${mac}). Lamps never report their state: Gladys shows the last command.`,
    fr: `Le pont v6 a répondu (MAC ${mac}). Les lampes ne donnent jamais leur état : Gladys affiche la dernière commande.`,
  }),
  v6Unknown: {
    en: 'v6 bridge: not checked since the start, checked at the next command or within 5 min.',
    fr: 'Pont v6 : pas encore vérifié depuis le démarrage, vérifié à la prochaine commande ou sous 5 min.',
  },
  v6NoAnswer: (bridge) => ({
    en: `The v6 bridge at ${where(bridge)} does not answer.`,
    fr: `Le pont v6 à ${where(bridge)} ne répond pas.`,
  }),
  otherBridge: (seen, pinned) => ({
    en: `Another bridge answers at this address (MAC ${seen}, expected ${pinned}): only "off" is sent. Press "Test the bridge" twice to accept it.`,
    fr: `Un autre pont répond à cette adresse (MAC ${seen}, attendu ${pinned}) : seul « éteindre » part. Appuyez deux fois sur « Tester le pont » pour l’accepter.`,
  }),
  // Badges.
  assumed: {
    en: 'Assumed state: MiLight lamps never report it, Gladys shows the last command.',
    fr: 'État supposé : les lampes MiLight ne le donnent jamais, Gladys affiche la dernière commande.',
  },
  held: {
    en: 'Off not confirmed by the bridge yet: sent again every 30 s for 10 min.',
    fr: 'Extinction pas encore confirmée par le pont : renvoyée toutes les 30 s pendant 10 min.',
  },
  lost: {
    en: 'Off never confirmed by the bridge (gave up after 10 min).',
    fr: 'Extinction jamais confirmée par le pont (abandon après 10 min).',
  },
  // Test button.
  testTooSoon: (ms) => ({
    en: `Test already run, try again in ${age(ms)}.`,
    fr: `Test déjà lancé, réessayez dans ${age(ms)}.`,
  }),
  testLegacy: (bridge) => ({
    en: `Legacy bridge (v3-v5) at ${where(bridge)}: it never answers, there is nothing to test. Turn a lamp on to check.`,
    fr: `Pont ancien (v3-v5) à ${where(bridge)} : il ne répond jamais, rien à tester. Allumez une lampe pour vérifier.`,
  }),
  testAccepted: (mac) => ({
    en: `Bridge ${mac} accepted: commands are sent to it again.`,
    fr: `Pont ${mac} accepté : les commandes lui sont de nouveau envoyées.`,
  }),
  testAcceptAgain: (seen, pinned) => ({
    en: `Another bridge answers (MAC ${seen}, expected ${pinned}). Press again within 2 min to accept it.`,
    fr: `Un autre pont répond (MAC ${seen}, attendu ${pinned}). Appuyez de nouveau sous 2 min pour l’accepter.`,
  }),
  testNotSaved: {
    en: 'The new bridge could not be saved in /data: not accepted, try again.',
    fr: 'Le nouveau pont n’a pas pu être enregistré dans /data : non accepté, réessayez.',
  },
};

/** The refusal or failure of a command, as Gladys logs it (never the value typed). */
export const ERRORS = {
  unknown: 'This device is not a MiLight lamp of this integration',
  invalidValue: 'Invalid value for this feature (nothing sent)',
  notThisBridge: 'This lamp does not exist on this kind of bridge (nothing sent)',
  notConfigured: 'Bridge address not configured (nothing sent)',
  configUnread: 'Configuration not read yet (nothing sent)',
  notListed: 'This zone is not ticked in the configuration (nothing sent)',
  storeUnread: 'Storage /data not read: the bridge identity cannot be checked (nothing sent)',
  otherBridge:
    'Another bridge answers at this address: press "Test the bridge" twice to accept it (nothing sent)',
  cancelled: 'Cancelled by a newer command of this lamp',
  late: 'The bridge queue was busy (nothing sent)',
  full: 'Too many commands waiting (nothing sent)',
  noAnswer: 'The bridge does not answer (nothing sent)',
  socket: 'The network refused the datagram (nothing sent)',
  closed: 'The integration is stopping (nothing sent)',
  partly: 'Cancelled after its first datagrams: the lamp may be on',
  unconfirmed: 'Sent, the bridge did not acknowledge it',
  offUnconfirmed: 'Off sent, not acknowledged by the bridge: sent again every 30 s for 10 min',
  overtaken: 'Off not acknowledged, then overtaken by a newer command of this lamp',
  offUnsent: 'Off not sent: tried again every 30 s for 10 min',
};
