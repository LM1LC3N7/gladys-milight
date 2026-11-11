// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and that the
// four places agree.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG, ZONE_KEYS } from '../src/config.js';
import { ACTIONS, KINDS, ZONES } from '../src/constants.js';
import { buildLamp } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const REPO = 'gladys-milight';
const CATEGORIES = new Set([
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
]);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, and one version in the four places', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/${REPO}:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, REPO);
  assert.equal(manifest.version, pkg.version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pkg.scripts.test, /--test-timeout=\d+/, 'a hanging test never blocks a runner');
  assert.equal(
    manifest.cover_image,
    `https://raw.githubusercontent.com/LM1LC3N7/${REPO}/main/cover.png`,
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.categories.every((c) => CATEGORIES.has(c)));
  // keywords and countries need Gladys 5.3.0: not yet (see TODO.md).
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`)
      .replace(/\*\*/g, '')
      .replace(/\s*\n>?\s*/g, ' ');
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated|sans\s+lien/);
    assert.match(
      docs,
      /never\s+been\s+tested\s+with\s+a\s+real\s+(bridge|device)|jamais\s+été\s+testée\s+avec\s+un\s+vrai\s+(pont|appareil)/,
    );
    assert.match(docs, /assumed|supposé/);
  }
  assert.match(
    read('README.md').replace(/\*\*/g, '').replace(/\s+/g, ' '),
    /never been tested with a real (bridge|device)/,
  );
});

test('the MIT notice of node-milight-promise ships with the code; no name in the LICENSE', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /node-milight-promise/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Louis|Milcent|LM1LC3N7|Wittig|Gladys/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || value !== '') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
    assert.doesNotMatch(field.key, /^gladys_/i, 'the core keeps the GLADYS_* keys');
    assert.notEqual(field.type, 'secret');
    for (const option of field.options ?? []) {
      assert.equal(typeof option.value, 'string', `${field.key}: option values are strings`);
    }
  }
  for (const key of Object.values(ZONE_KEYS)) {
    assert.equal(fields[key].type, 'multi_select');
    assert.deepEqual(
      fields[key].options.map((o) => o.value),
      ZONES.map(String),
    );
  }
  assert.equal(fields.bridge_address.required, true);
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const item of manifest.actions) {
    assert.ok(item.timeout_seconds >= 5 && item.timeout_seconds <= 120, item.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('devices: lights only, written without feedback; supported options follow the core rules', () => {
  const gladys = createFakeGladys({ selector: 'milight' });
  const devices = [
    ...ZONES.map((zone) => buildLamp(gladys, { kind: KINDS.FULL_COLOR, zone })),
    buildLamp(gladys, { kind: KINDS.RGBW, zone: 1 }),
    buildLamp(gladys, { kind: KINDS.WHITE, zone: 2 }),
    buildLamp(gladys, { kind: KINDS.BRIDGE_LAMP, zone: 0 }),
  ];
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  const normalize = existsSync(core) ? createRequire(import.meta.url)(core.pathname) : undefined;
  for (const device of devices) {
    assert.notEqual(device.name, device.external_id);
    for (const feature of device.features) {
      assert.equal(feature.category, 'light');
      assert.equal(feature.has_feedback, false);
      assert.equal(feature.read_only, false);
      assert.equal(feature.unit, undefined, 'the light category has no unit in the core');
      const options = feature.supported_options ?? [];
      const values = new Set();
      for (const option of options) {
        assert.equal(typeof option.label, 'string');
        assert.equal(option.label, option.label.trim());
        assert.ok(option.label.length > 0);
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(option.value));
        values.add(option.value);
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      }
      if (normalize && options.length > 0) {
        const fn = normalize.normalizeSupportedOptions ?? normalize;
        assert.deepEqual(fn(options), options);
      }
    }
  }
});

test('no Bluetooth, no cloud, no imitation of an app, no broadcast', () => {
  const code = ['src/app.js', 'src/link.js', 'src/protocol.js', 'src/constants.js']
    .map(read)
    .join('\n');
  assert.doesNotMatch(code, /bluetooth|https?:\/\/|['"]user-agent['"]|setBroadcast|addMembership/i);
  assert.doesNotMatch(read('package.json'), /bluetooth|noble/i);
  assert.doesNotMatch(read('src/link.js'), /logger|console/);
});
