// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the zones ticked in the configuration (nothing is read from
  // the bridge: it does not know its bulbs).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated(() => app.devicesChanged());
  gladys.onDeviceUpdated(() => app.devicesChanged());
  gladys.onDeviceDeleted(() => app.devicesChanged());

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testBridge());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): /data,
  // the configuration (tried again while it cannot be read), the Discovery,
  // the badges and the status. Nothing is read from the lamps.
  gladys.on('connected', async () => {
    try {
      await app.connected(() => gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
