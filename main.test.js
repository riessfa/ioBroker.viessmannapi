'use strict';

const EventEmitter = require('events');
const Module = require('module');
const { expect } = require('chai');
const { extractKeys } = require('./lib/extractKeys');

const noop = () => {};
let testCounter = 0;

function loadAdapterFactory() {
  const originalLoad = Module._load;

  class MockAdapter extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.config = {};
      this.log = {
        debug: noop,
        error: noop,
        info: noop,
        warn: noop,
      };
    }

    setState() {}
  }

  Module._load = function mockAdapterCore(request, parent, isMain) {
    if (request === '@iobroker/adapter-core') {
      return { Adapter: MockAdapter };
    }

    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    delete require.cache[require.resolve('./main')];
    return require('./main');
  } finally {
    Module._load = originalLoad;
  }
}

function createAdapter() {
  return loadAdapterFactory()({});
}

function transientServerError(config, status = 500) {
  const error = new Error('Request failed with status code ' + status);
  error.config = config;
  error.response = {
    status,
    data: { message: 'transient error' },
    headers: {},
  };
  return error;
}

function createExtractKeysAdapterMock() {
  const objects = new Map();
  const states = new Map();
  const stateWrites = [];

  return {
    objects,
    states,
    stateWrites,
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
    async setObjectNotExistsAsync(id, object) {
      if (!objects.has(id)) {
        objects.set(id, object);
      }
    },
    async getObjectAsync(id) {
      return objects.get(id);
    },
    async delObjectAsync(id, options) {
      if (options && options.recursive) {
        for (const objectId of Array.from(objects.keys())) {
          if (objectId === id || objectId.startsWith(id + '.')) {
            objects.delete(objectId);
          }
        }
        return;
      }
      objects.delete(id);
    },
    async setStateAsync(id, value, ack) {
      stateWrites.push({ id, value, ack });
      states.set(id, { val: value, ack });
    },
  };
}

function useFakeTimers() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, active: true, type: 'timeout' };
    timeouts.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) {
      timer.active = false;
      clearedTimeouts.push(timer);
    }
  };
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay, active: true, type: 'interval' };
    intervals.push(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    if (timer) {
      timer.active = false;
      clearedIntervals.push(timer);
    }
  };

  return {
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    },
  };
}

function axiosError(status, data = { message: 'error' }) {
  const error = new Error('Request failed with status code ' + status);
  error.response = {
    status,
    data,
    headers: {},
  };
  return error;
}

function testRoot(name) {
  testCounter += 1;
  return `test.${testCounter}.${name}`;
}

function setupDeviceUpdateTest(options = {}) {
  const adapter = createAdapter();
  const requests = [];
  const extracted = [];
  const logs = {
    debug: [],
    error: [],
    info: [],
    warn: [],
  };

  adapter.config = {
    featureFilter: '',
    allowVirtual: false,
    ...options.config,
  };
  adapter.session = { access_token: 'access-token' };
  adapter.log = {
    debug: (msg) => logs.debug.push(String(msg)),
    error: (msg) => logs.error.push(String(msg)),
    info: (msg) => logs.info.push(String(msg)),
    warn: (msg) => logs.warn.push(String(msg)),
  };
  adapter.installationArray = [
    {
      id: 'installation-1',
      gateways: [
        {
          devices: [
            {
              id: 'device-1',
              gatewaySerial: 'gateway-1',
              roles: [],
              deviceType: 'boiler',
            },
          ],
        },
      ],
    },
  ];
  adapter.gatewayIndexObject = { 'installation-1': 1 };
  adapter.extractKeys = async (...args) => {
    extracted.push(args);
  };
  adapter.requestClient.defaults.adapter = async (config) => {
    requests.push(config);
    if (options.errorStatus) {
      throw axiosError(options.errorStatus, options.errorData || { message: 'error-' + options.errorStatus });
    }
    return {
      config,
      data: {
        data: options.features || [],
      },
      headers: {},
      status: 200,
      statusText: 'OK',
    };
  };

  return { adapter, requests, extracted, logs };
}

describe('Viessmannapi auth timer handling', () => {
  let timers;

  beforeEach(() => {
    timers = useFakeTimers();
  });

  afterEach(() => {
    timers.restore();
    delete require.cache[require.resolve('./main')];
  });

  it('uses a safe minimum refresh delay when expires_in is missing', () => {
    const adapter = createAdapter();

    adapter.session = { access_token: 'access-token' };
    adapter.scheduleTokenRefresh();

    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].delay).to.equal(30 * 1000);
    expect(adapter.refreshTokenTimeout).to.equal(timers.timeouts[0]);
  });

  it('uses a safe minimum refresh delay when expires_in is not greater than the refresh buffer', () => {
    const adapter = createAdapter();

    adapter.session = { access_token: 'access-token', expires_in: 100 };
    adapter.scheduleTokenRefresh();

    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].delay).to.equal(30 * 1000);
  });

  it('clears previous refresh timers when repeated 401 responses schedule a retry refresh', async () => {
    const adapter = createAdapter();

    adapter.config = {};
    adapter.session = { access_token: 'access-token' };
    adapter.installationArray = [
      {
        id: 'installation-1',
        gateways: [
          {
            devices: [
              {
                id: 'device-1',
                gatewaySerial: 'gateway-1',
                roles: [],
              },
            ],
          },
        ],
      },
    ];
    adapter.gatewayIndexObject = { 'installation-1': 1 };
    adapter.requestClient.defaults.adapter = async () => {
      throw axiosError(401, { error: 'unauthorized' });
    };

    await adapter.updateDevices();
    await adapter.updateDevices();

    expect(timers.timeouts).to.have.length(2);
    expect(timers.timeouts[0].active).to.equal(false);
    expect(timers.timeouts[1].active).to.equal(true);
    expect(timers.clearedTimeouts).to.include(timers.timeouts[0]);
    expect(adapter.refreshTokenTimeout).to.equal(timers.timeouts[1]);
  });

  it('clears previous refresh timers when repeated event 401 responses schedule a retry refresh', async () => {
    const adapter = createAdapter();

    adapter.config = {};
    adapter.session = { access_token: 'access-token' };
    adapter.installationArray = [
      {
        id: 'installation-1',
        gateways: [
          {
            devices: [],
          },
        ],
      },
    ];
    adapter.gatewayIndexObject = { 'installation-1': 1 };
    adapter.requestClient.defaults.adapter = async () => {
      throw axiosError(401, { error: 'unauthorized' });
    };

    await adapter.getEvents();
    await adapter.getEvents();

    expect(timers.timeouts).to.have.length(2);
    expect(timers.timeouts[0].active).to.equal(false);
    expect(timers.timeouts[1].active).to.equal(true);
    expect(timers.clearedTimeouts).to.include(timers.timeouts[0]);
    expect(adapter.refreshTokenTimeout).to.equal(timers.timeouts[1]);
  });

  it('clears auth timers and schedules a single relogin when refresh fails', async () => {
    const adapter = createAdapter();

    adapter.config = { client_id: 'client-id' };
    adapter.session = { refresh_token: 'refresh-token', expires_in: 3600 };
    adapter.scheduleTokenRefresh();
    const oldRefreshTimer = adapter.refreshTokenTimeout;
    adapter.requestClient.defaults.adapter = async () => {
      throw axiosError(500);
    };

    await adapter.refreshToken();

    expect(oldRefreshTimer.active).to.equal(false);
    expect(timers.timeouts).to.have.length(2);
    expect(timers.timeouts[1].delay).to.equal(60 * 1000);
    expect(adapter.reLoginTimeout).to.equal(timers.timeouts[1]);
    expect(adapter.refreshTokenTimeout).to.equal(null);
  });

  it('does not duplicate polling intervals after a successful scheduled relogin', async () => {
    const adapter = createAdapter();
    const updateInterval = { type: 'interval', active: true };
    const eventInterval = { type: 'interval', active: true };

    adapter.updateInterval = updateInterval;
    adapter.eventInterval = eventInterval;
    adapter.deviceDiscoveryDone = true;
    adapter.login = async () => {
      adapter.session = { access_token: 'access-token', expires_in: 3600 };
      adapter.scheduleTokenRefresh();
    };

    adapter.scheduleRelogin();
    await timers.timeouts[0].callback();

    expect(adapter.updateInterval).to.equal(updateInterval);
    expect(adapter.eventInterval).to.equal(eventInterval);
    expect(timers.intervals).to.have.length(0);
    expect(timers.clearedIntervals).to.have.length(0);
    expect(adapter.reloginAttempts).to.equal(0);
  });

  it('schedules relogin retries with exponential backoff and resets after success', async () => {
    const adapter = createAdapter();
    let loginSucceeds = false;

    adapter.config = { interval: 5, eventInterval: 300 };
    adapter.deviceDiscoveryDone = true;
    adapter.login = async () => {
      if (loginSucceeds) {
        adapter.session = { access_token: 'access-token', expires_in: 3600 };
      }
    };

    await adapter.connect();

    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].delay).to.equal(60 * 1000);
    expect(adapter.reloginAttempts).to.equal(1);
    expect(adapter.updateInterval).to.equal(null);

    await timers.timeouts[0].callback();

    expect(timers.timeouts).to.have.length(2);
    expect(timers.timeouts[1].delay).to.equal(2 * 60 * 1000);
    expect(adapter.reloginAttempts).to.equal(2);

    loginSucceeds = true;
    await timers.timeouts[1].callback();

    expect(adapter.reloginAttempts).to.equal(0);
    expect(timers.intervals).to.have.length(2);
    expect(adapter.updateInterval).to.equal(timers.intervals[0]);
    expect(adapter.eventInterval).to.equal(timers.intervals[1]);
  });

  it('caps the relogin backoff delay at 30 minutes', () => {
    const adapter = createAdapter();

    adapter.reloginAttempts = 20;
    adapter.scheduleRelogin();

    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].delay).to.equal(30 * 60 * 1000);
  });
});

describe('Viessmannapi auth happy paths', () => {
  let timers;

  beforeEach(() => {
    timers = useFakeTimers();
  });

  afterEach(() => {
    timers.restore();
    delete require.cache[require.resolve('./main')];
  });

  function trackSetState(adapter) {
    const calls = [];
    adapter.setState = (id, val, ack) => {
      calls.push({ id, val, ack });
    };
    return calls;
  }

  it('completes a happy-path login, sets the session, and schedules a refresh', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);
    const requests = [];

    adapter.config = { username: 'user', password: 'pass', client_id: 'client-id' };
    adapter.requestClient.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.method === 'get') {
        const error = new Error('redirect intercepted');
        error.request = { _currentUrl: 'http://localhost:4200/?code=auth-code' };
        throw error;
      }
      return {
        config,
        data: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };

    await adapter.login();

    expect(requests).to.have.length(2);
    expect(requests[0].url).to.include('/idp/v3/authorize');
    expect(requests[1].url).to.include('/idp/v3/token');
    expect(requests[1].data).to.include('grant_type=authorization_code');
    expect(requests[1].data).to.include('code=auth-code');
    expect(adapter.session).to.deep.equal({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    });
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: true, ack: true });
    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].active).to.equal(true);
    expect(adapter.refreshTokenTimeout).to.equal(timers.timeouts[0]);
  });

  it('refreshes the session and reschedules on a successful refresh', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);
    const requests = [];

    adapter.config = { client_id: 'client-id' };
    adapter.session = { refresh_token: 'old-refresh', expires_in: 3600 };
    adapter.requestClient.defaults.adapter = async (config) => {
      requests.push(config);
      return {
        config,
        data: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };

    await adapter.refreshToken();

    expect(requests).to.have.length(1);
    expect(requests[0].method).to.equal('post');
    expect(requests[0].url).to.include('/idp/v3/token');
    expect(requests[0].data).to.include('grant_type=refresh_token');
    expect(requests[0].data).to.include('refresh_token=old-refresh');
    expect(adapter.session).to.deep.equal({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 1800,
    });
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: true, ack: true });
    expect(timers.timeouts).to.have.length(1);
    expect(adapter.refreshTokenTimeout).to.equal(timers.timeouts[0]);
    expect(adapter.reLoginTimeout).to.equal(null);
  });

  it('onUnload clears auth and polling timers, detaches the retry interceptor, and runs the callback', () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);

    const refreshTimer = setTimeout(noop, 1000);
    const reloginTimer = setTimeout(noop, 1000);
    const updateInterval = setInterval(noop, 1000);
    const eventInterval = setInterval(noop, 1000);
    adapter.refreshTokenTimeout = refreshTimer;
    adapter.reLoginTimeout = reloginTimer;
    adapter.updateInterval = updateInterval;
    adapter.eventInterval = eventInterval;

    const interceptorIdBeforeUnload = adapter.retryInterceptorId;
    expect(interceptorIdBeforeUnload).to.be.a('number');

    let callbackCalls = 0;
    adapter.onUnload(() => {
      callbackCalls += 1;
    });

    expect(callbackCalls).to.equal(1);
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: false, ack: true });
    expect(refreshTimer.active).to.equal(false);
    expect(reloginTimer.active).to.equal(false);
    expect(updateInterval.active).to.equal(false);
    expect(eventInterval.active).to.equal(false);
    expect(adapter.refreshTokenTimeout).to.equal(null);
    expect(adapter.reLoginTimeout).to.equal(null);
    expect(adapter.updateInterval).to.equal(null);
    expect(adapter.eventInterval).to.equal(null);
    expect(adapter.retryInterceptorId).to.equal(undefined);
  });
});

describe('Viessmannapi auth failure paths', () => {
  let timers;

  beforeEach(() => {
    timers = useFakeTimers();
  });

  afterEach(() => {
    timers.restore();
    delete require.cache[require.resolve('./main')];
  });

  function trackSetState(adapter) {
    const calls = [];
    adapter.setState = (id, val, ack) => {
      calls.push({ id, val, ack });
    };
    return calls;
  }

  it('does not exchange a token when authorization fails without a redirect code', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);
    const requests = [];

    adapter.config = { username: 'user', password: 'pass', client_id: 'client-id' };
    adapter.requestClient.defaults.adapter = async (config) => {
      requests.push(config);
      throw axiosError(400, { error: 'invalid_request' });
    };

    await adapter.login();

    expect(requests).to.have.length(1);
    expect(requests[0].method).to.equal('get');
    expect(requests[0].url).to.include('/idp/v3/authorize');
    expect(adapter.session).to.deep.equal({});
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: false, ack: true });
    expect(timers.timeouts).to.have.length(0);
  });

  it('keeps the session empty and marks the adapter disconnected when token exchange fails', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);
    const requests = [];

    adapter.config = { username: 'user', password: 'pass', client_id: 'client-id' };
    adapter.requestClient.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.method === 'get') {
        const error = new Error('redirect intercepted');
        error.request = { _currentUrl: 'http://localhost:4200/?code=auth-code' };
        throw error;
      }
      throw axiosError(400, { error: 'invalid_grant' });
    };

    await adapter.login();

    expect(requests).to.have.length(2);
    expect(requests[1].method).to.equal('post');
    expect(requests[1].data).to.include('grant_type=authorization_code');
    expect(adapter.session).to.deep.equal({});
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: false, ack: true });
    expect(timers.timeouts).to.have.length(0);
  });

  it('marks the adapter disconnected and schedules relogin when refresh fails', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);

    adapter.config = { client_id: 'client-id' };
    adapter.session = { refresh_token: 'refresh-token', expires_in: 3600 };
    adapter.requestClient.defaults.adapter = async () => {
      throw axiosError(400, { error: 'invalid_grant' });
    };

    await adapter.refreshToken();

    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: false, ack: true });
    expect(timers.timeouts).to.have.length(1);
    expect(timers.timeouts[0].delay).to.equal(60 * 1000);
    expect(adapter.reLoginTimeout).to.equal(timers.timeouts[0]);
  });

  it('handles authorization failures whose response has no body without throwing', async () => {
    const adapter = createAdapter();
    const setStateCalls = trackSetState(adapter);

    adapter.config = { username: 'user', password: 'pass', client_id: 'client-id' };
    adapter.requestClient.defaults.adapter = async () => {
      const error = new Error('Request failed with status code 400');
      error.response = { status: 400, headers: {} };
      throw error;
    };

    await adapter.login();

    expect(adapter.session).to.deep.equal({});
    expect(setStateCalls).to.deep.include({ id: 'info.connection', val: false, ack: true });
  });
});

describe('Viessmannapi PKCE and token encoding', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  it('generates a 64-char hex verifier and a base64url challenge', () => {
    const adapter = createAdapter();

    const [verifier, challenge] = adapter.getCodeChallenge();

    expect(verifier).to.match(/^[0-9a-f]{64}$/);
    expect(challenge).to.match(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates a different verifier on each call', () => {
    const adapter = createAdapter();

    const [first] = adapter.getCodeChallenge();
    const [second] = adapter.getCodeChallenge();

    expect(first).to.not.equal(second);
  });

  it('URL-encodes the refresh token request body', async () => {
    const timers = useFakeTimers();
    try {
      const adapter = createAdapter();
      const requests = [];

      adapter.config = { client_id: 'client id&x' };
      adapter.session = { refresh_token: 'refresh+token=y', expires_in: 3600 };
      adapter.requestClient.defaults.adapter = async (config) => {
        requests.push(config);
        return {
          config,
          data: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 },
          headers: {},
          status: 200,
          statusText: 'OK',
        };
      };

      await adapter.refreshToken();

      expect(requests).to.have.length(1);
      expect(requests[0].data).to.include('client_id=client%20id%26x');
      expect(requests[0].data).to.include('refresh_token=refresh%2Btoken%3Dy');
    } finally {
      timers.restore();
    }
  });
});

describe('Viessmannapi wrapped callback handling', () => {
  function trackUnhandledRejections() {
    const unhandled = [];
    const listener = (reason) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    return {
      unhandled,
      cleanup() {
        process.removeListener('unhandledRejection', listener);
      },
    };
  }

  it('logs and swallows updateDevices interval callback errors', async () => {
    const timers = useFakeTimers();
    try {
      const adapter = createAdapter();
      const errors = [];
      const unhandledRejections = trackUnhandledRejections();
      adapter.log = { debug: noop, info: noop, warn: noop, error: (msg) => errors.push(String(msg)) };
      adapter.config = { interval: 1, eventInterval: 5 };
      adapter.subscribeStates = noop;
      adapter.getAdapterObjectsAsync = async () => ({});
      adapter.delObjectAsync = async () => {};
      adapter.login = async () => {
        adapter.session = { access_token: 'token', expires_in: 3600 };
      };
      adapter.getDeviceIds = async () => {};
      adapter.getEvents = async () => {};
      let updateCalls = 0;
      adapter.updateDevices = async () => {
        updateCalls += 1;
        if (updateCalls > 1) {
          throw new Error('boom update');
        }
      };
      adapter.scheduleTokenRefresh = noop;

      await adapter.onReady();
      await timers.intervals[0].callback();

      expect(errors.some((line) => line.includes('updateDevices interval failed: boom update'))).to.equal(true);
      expect(unhandledRejections.unhandled).to.have.length(0);
      unhandledRejections.cleanup();
    } finally {
      timers.restore();
    }
  });

  it('logs and swallows getEvents interval callback errors', async () => {
    const timers = useFakeTimers();
    try {
      const adapter = createAdapter();
      const errors = [];
      const unhandledRejections = trackUnhandledRejections();
      adapter.log = { debug: noop, info: noop, warn: noop, error: (msg) => errors.push(String(msg)) };
      adapter.config = { interval: 1, eventInterval: 5 };
      adapter.subscribeStates = noop;
      adapter.getAdapterObjectsAsync = async () => ({});
      adapter.delObjectAsync = async () => {};
      adapter.login = async () => {
        adapter.session = { access_token: 'token', expires_in: 3600 };
      };
      adapter.getDeviceIds = async () => {};
      adapter.updateDevices = async () => {};
      let eventCalls = 0;
      adapter.getEvents = async () => {
        eventCalls += 1;
        if (eventCalls > 1) {
          throw new Error('boom events');
        }
      };
      adapter.scheduleTokenRefresh = noop;

      await adapter.onReady();
      await timers.intervals[1].callback();

      expect(errors.some((line) => line.includes('getEvents interval failed: boom events'))).to.equal(true);
      expect(unhandledRejections.unhandled).to.have.length(0);
      unhandledRejections.cleanup();
    } finally {
      timers.restore();
    }
  });

  it('logs and swallows refresh updateDevices callback errors', async () => {
    const timers = useFakeTimers();
    try {
      const adapter = createAdapter();
      const errors = [];
      const unhandledRejections = trackUnhandledRejections();
      adapter.log = { debug: noop, info: noop, warn: noop, error: (msg) => errors.push(String(msg)) };
      adapter.config = { interval: 1, eventInterval: 5 };
      adapter.subscribeStates = noop;
      adapter.getAdapterObjectsAsync = async () => ({});
      adapter.delObjectAsync = async () => {};
      adapter.login = async () => {
        adapter.session = { access_token: 'token', expires_in: 3600 };
      };
      adapter.getDeviceIds = async () => {};
      adapter.updateDevices = async () => {};
      adapter.getEvents = async () => {};
      adapter.scheduleTokenRefresh = noop;
      adapter.getObjectAsync = async () => ({ common: { param: 'temperature' } });
      adapter.getStateAsync = async () => ({ val: 'https://example.com/command' });
      adapter.requestClient.defaults.adapter = async () => ({
        config: {},
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      });

      await adapter.onReady();

      adapter.updateDevices = async () => {
        throw new Error('boom refresh');
      };
      await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
        ack: false,
        val: '21',
      });
      await timers.timeouts[timers.timeouts.length - 1].callback();

      expect(errors.some((line) => line.includes('refresh updateDevices failed: boom refresh'))).to.equal(true);
      expect(unhandledRejections.unhandled).to.have.length(0);
      unhandledRejections.cleanup();
    } finally {
      timers.restore();
    }
  });
});

describe('Viessmannapi retry handling', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  it('attaches the retry interceptor and keeps retries disabled by default', () => {
    const adapter = createAdapter();

    expect(adapter.retryInterceptorId).to.be.a('number');
    expect(adapter.requestClient.defaults.raxConfig).to.include({
      retry: 0,
    });
    expect(adapter.requestClient.defaults.raxConfig.httpMethodsToRetry).to.deep.equal(['POST']);
    expect(adapter.requestClient.defaults.raxConfig.statusCodesToRetry).to.deep.equal([[500, 599]]);
  });

  it('retries command POST writes after a transient 500 response', async () => {
    const adapter = createAdapter();
    const calls = [];

    adapter.session = { access_token: 'access-token' };
    adapter.getStateAsync = async () => ({ val: 'https://example.com/command' });
    adapter.getObjectAsync = async () => ({ common: { param: 'temperature' } });
    adapter.updateDevices = async () => {};
    adapter.requestClient.interceptors.request.use((config) => {
      config.raxConfig.retryDelay = 0;
      return config;
    });
    adapter.requestClient.defaults.adapter = async (config) => {
      calls.push(config);

      if (calls.length === 1) {
        throw transientServerError(config);
      }

      return {
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };

    const commandWrite = adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '21',
    });

    await commandWrite;

    expect(calls).to.have.length(2);
    expect(calls[0].method).to.equal('post');
    expect(calls[1].method).to.equal('post');
    expect(calls[0].data).to.equal(JSON.stringify({ temperature: 21 }));
  });

  for (const status of [502, 504]) {
    it('retries command POST writes after a transient ' + status + ' response', async () => {
      const adapter = createAdapter();
      const calls = [];

      adapter.session = { access_token: 'access-token' };
      adapter.getStateAsync = async () => ({ val: 'https://example.com/command' });
      adapter.getObjectAsync = async () => ({ common: { param: 'temperature' } });
      adapter.updateDevices = async () => {};
      adapter.requestClient.interceptors.request.use((config) => {
        config.raxConfig.retryDelay = 0;
        return config;
      });
      adapter.requestClient.defaults.adapter = async (config) => {
        calls.push(config);

        if (calls.length === 1) {
          throw transientServerError(config, status);
        }

        return {
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        };
      };

      await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
        ack: false,
        val: '21',
      });

      expect(calls).to.have.length(2);
      expect(calls[0].method).to.equal('post');
      expect(calls[1].method).to.equal('post');
      expect(calls[0].data).to.equal(JSON.stringify({ temperature: 21 }));
    });
  }

  it('keeps the intended per-request retry settings for command writes', async () => {
    const adapter = createAdapter();
    const calls = [];

    adapter.session = { access_token: 'access-token' };
    adapter.getStateAsync = async () => ({ val: 'https://example.com/command' });
    adapter.getObjectAsync = async () => ({ common: { param: 'mode' } });
    adapter.updateDevices = async () => {};
    adapter.requestClient.defaults.adapter = async (config) => {
      calls.push(config);

      return {
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };

    const commandWrite = adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: 'comfort',
    });

    await commandWrite;

    expect(calls).to.have.length(1);
    expect(calls[0].raxConfig).to.include({
      retry: 5,
      retryDelay: 5000,
      backoffType: 'static',
    });
    expect(calls[0].raxConfig.statusCodesToRetry).to.deep.equal([[500, 599]]);
    expect(calls[0].raxConfig.httpMethodsToRetry).to.deep.equal(['POST']);
    expect(calls[0].raxConfig.onRetryAttempt).to.be.a('function');
  });

  it('does not retry GET requests even when a request sets a retry count', async () => {
    const adapter = createAdapter();
    const calls = [];

    adapter.requestClient.defaults.adapter = async (config) => {
      calls.push(config);
      throw transientServerError(config);
    };

    await adapter.requestClient({
      method: 'get',
      url: 'https://example.com/status',
      raxConfig: {
        retry: 5,
        retryDelay: 1,
      },
    }).catch(noop);

    expect(calls).to.have.length(1);
  });

  it('does not retry non-command POST requests without per-request retry settings', async () => {
    const adapter = createAdapter();
    const calls = [];

    adapter.requestClient.defaults.adapter = async (config) => {
      calls.push(config);
      throw transientServerError(config);
    };

    await adapter.requestClient({
      method: 'post',
      url: 'https://example.com/token',
    }).catch(noop);

    expect(calls).to.have.length(1);
  });
});

describe('Viessmannapi feature update handling', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  it('filters features by exact matches and removes logbook features', async () => {
    const { adapter, extracted } = setupDeviceUpdateTest({
      config: {
        featureFilter: 'heating.dhw.temperature, ventilation.quickmodes.active',
      },
      features: [
        { feature: 'heating.dhw.temperature', value: 50 },
        { feature: 'heating.boiler.temperature', value: 60 },
        { feature: 'ventilation.quickmodes.active', value: true },
        { feature: 'device.messages.logbook.active', value: true },
      ],
    });

    await adapter.updateDevices();

    expect(extracted).to.have.length(1);
    expect(extracted[0][2]).to.deep.equal([
      { feature: 'heating.dhw.temperature', value: 50 },
      { feature: 'ventilation.quickmodes.active', value: true },
    ]);
  });

  it('filters features by wildcard patterns including the base path', async () => {
    const { adapter, extracted } = setupDeviceUpdateTest({
      config: {
        featureFilter: ' heating.* ',
      },
      features: [
        { feature: 'heating', value: true },
        { feature: 'heating.boiler.temperature', value: 60 },
        { feature: 'heatingExtra.boiler.temperature', value: 70 },
        { feature: 'dhw.heating.temperature', value: 55 },
      ],
    });

    await adapter.updateDevices();

    expect(extracted).to.have.length(1);
    expect(extracted[0][2]).to.deep.equal([
      { feature: 'heating', value: true },
      { feature: 'heating.boiler.temperature', value: 60 },
    ]);
  });

  it('logs rate limits at info level without an error dump for feature update 429 responses', async () => {
    const { adapter, logs } = setupDeviceUpdateTest({
      errorStatus: 429,
      errorData: { message: 'rate limited' },
    });

    await adapter.updateDevices();

    expect(logs.info.join('\n')).to.include('Rate limit reached');
    expect(logs.error).to.have.length(0);
  });

  it('logs full error details for unexpected feature update failures', async () => {
    const { adapter, logs } = setupDeviceUpdateTest({
      errorStatus: 418,
      errorData: { message: 'unexpected' },
    });

    await adapter.updateDevices();

    expect(logs.error.join('\n')).to.include('Feature update request failed');
    expect(logs.error.join('\n')).to.include('/iot/v2/features/installations');
  });

  it('continues polling remaining installations when one has no gateway', async () => {
    const { adapter, requests } = setupDeviceUpdateTest();

    adapter.installationArray = [
      {
        id: 'installation-0',
        gateways: [],
      },
      ...adapter.installationArray,
    ];
    adapter.gatewayIndexObject = { 'installation-0': 1, 'installation-1': 1 };

    await adapter.updateDevices();

    expect(requests).to.have.length(1);
    expect(requests[0].url).to.include('installation-1');
  });

  it('logs a generic unstable-server message for feature update 500 responses', async () => {
    const { adapter, logs } = setupDeviceUpdateTest({
      errorStatus: 500,
      errorData: { message: 'server error' },
    });

    await adapter.updateDevices();

    expect(logs.info.join('\n')).to.include('Error 500');
    expect(logs.info.join('\n')).to.include('unstable server');
    expect(logs.error).to.have.length(0);
  });

  it('logs gateway guidance for feature update 502 responses', async () => {
    const { adapter, logs } = setupDeviceUpdateTest({
      errorStatus: 502,
      errorData: { message: 'bad gateway' },
    });

    await adapter.updateDevices();

    expect(logs.info.join('\n')).to.include('bad gateway');
    expect(logs.info.join('\n')).to.include('Please check the connection of your gateway');
    expect(logs.info.join('\n')).not.to.include('unstable server');
  });

  it('logs availability guidance for feature update 504 responses', async () => {
    const { adapter, logs } = setupDeviceUpdateTest({
      errorStatus: 504,
      errorData: { message: 'gateway timeout' },
    });

    await adapter.updateDevices();

    expect(logs.info.join('\n')).to.include('Viessmann API is not available please try again later');
    expect(logs.info.join('\n')).not.to.include('unstable server');
  });
});

describe('Viessmannapi axios error logging', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  function collectErrorLogs(adapter) {
    const logs = [];
    adapter.log.error = (message) => logs.push(String(message));
    return logs;
  }

  it('redacts bearer authorization headers and token-bearing URLs', () => {
    const adapter = createAdapter();
    const logs = collectErrorLogs(adapter);

    adapter.logAxiosError('Token URL request failed', {
      message: 'Request failed for https://api.example.com/iot/path?access_token=secret-token&client_id=client-secret',
      config: {
        method: 'get',
        url: 'https://api.example.com/iot/path?access_token=secret-token&client_id=client-secret',
        headers: {
          Authorization: 'Bearer secret-bearer-token',
        },
        params: {
          refresh_token: 'secret-refresh-token',
          client_id: 'secret-client-id',
        },
      },
      request: {
        _currentUrl: 'https://api.example.com/iot/path?code=secret-code&password=secret-password',
      },
      response: {
        status: 401,
        data: {
          access_token: 'secret-response-token',
          url: 'https://api.example.com/callback?code=secret-response-code',
        },
      },
    });

    const output = logs.join('\n');
    expect(output).to.include('Token URL request failed');
    expect(output).to.include('/iot/path');
    expect(output).to.include('[redacted]');
    expect(output).not.to.include('secret-token');
    expect(output).not.to.include('secret-bearer-token');
    expect(output).not.to.include('secret-refresh-token');
    expect(output).not.to.include('secret-client-id');
    expect(output).not.to.include('secret-code');
    expect(output).not.to.include('secret-password');
    expect(output).not.to.include('secret-response-token');
    expect(output).not.to.include('secret-response-code');
    expect(output).not.to.include('?access_token=');
    expect(output).not.to.include('?code=');
  });

  it('redacts Basic authorization headers and form-encoded token data', () => {
    const adapter = createAdapter();
    const logs = collectErrorLogs(adapter);

    adapter.logAxiosError('Basic auth request failed', {
      message: 'Basic dXNlcjpzZWNyZXQ= failed',
      config: {
        method: 'post',
        url: 'https://iam.example.com/idp/v3/token?client_id=query-client-secret',
        headers: {
          authorization: 'Basic dXNlcjpzZWNyZXQ=',
        },
        data: 'grant_type=refresh_token&client_id=form-client-secret&refresh_token=form-refresh-secret&code=form-code-secret&password=form-password-secret',
      },
      response: {
        status: 400,
        data: {
          error: 'invalid_request',
          nested: {
            password: 'response-password-secret',
          },
        },
      },
    });

    const output = logs.join('\n');
    expect(output).to.include('Basic auth request failed');
    expect(output).to.include('[redacted]');
    expect(output).not.to.include('dXNlcjpzZWNyZXQ=');
    expect(output).not.to.include('query-client-secret');
    expect(output).not.to.include('form-client-secret');
    expect(output).not.to.include('form-refresh-secret');
    expect(output).not.to.include('form-code-secret');
    expect(output).not.to.include('form-password-secret');
    expect(output).not.to.include('response-password-secret');
    expect(output).not.to.include('?client_id=');
  });
});


describe('Viessmannapi command payload validation', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  function setupCommandTest(commonConfig) {
    const adapter = createAdapter();
    const calls = [];
    const warns = [];

    adapter.session = { access_token: 'access-token' };
    adapter.log.warn = (msg) => warns.push(String(msg));
    adapter.getStateAsync = async () => ({ val: 'https://example.com/command' });
    adapter.getObjectAsync = async () => ({ common: commonConfig });
    adapter.updateDevices = async () => {};
    adapter.requestClient.defaults.adapter = async (config) => {
      calls.push(config);
      return { config, data: { ok: true }, headers: {}, status: 200, statusText: 'OK' };
    };

    return { adapter, calls, warns };
  }

  it('sends a valid single-parameter command', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'temperature',
      type: 'number',
      min: 10,
      max: 30,
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', { ack: false, val: '21' });

    expect(warns).to.have.length(0);
    expect(calls).to.have.length(1);
    expect(calls[0].method).to.equal('post');
    expect(calls[0].url).to.equal('https://example.com/command');
    expect(calls[0].headers.Authorization).to.equal('Bearer access-token');
    expect(calls[0].headers['Content-Type']).to.equal('application/json');
    expect(calls[0].data).to.equal(JSON.stringify({ temperature: 21 }));
  });

  it('sends a valid multi-parameter JSON command', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'slope', type: 'number', min: 0.2, max: 3.5 },
        { param: 'shift', type: 'number', min: -13, max: 40 },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{"slope": 1.5, "shift": 5}',
    });

    expect(warns).to.have.length(0);
    expect(calls).to.have.length(1);
    expect(calls[0].data).to.equal(JSON.stringify({ slope: 1.5, shift: 5 }));
  });

  it('does not send a command without a URI state', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'temperature',
      type: 'number',
    });
    const infos = [];

    adapter.log.info = (msg) => infos.push(String(msg));
    adapter.getStateAsync = async () => ({ val: '' });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', { ack: false, val: '21' });

    expect(warns).to.have.length(0);
    expect(calls).to.have.length(0);
    expect(infos).to.deep.equal(['No URI found']);
  });

  it('rejects invalid JSON for multi-parameter commands', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'slope', type: 'number' },
        { param: 'shift', type: 'number' },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{not valid json}',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('Command rejected');
    expect(warns[0]).to.include('Invalid JSON');
  });

  it('rejects enum violations for single-parameter commands', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'mode',
      type: 'mixed',
      states: { eco: 'eco', comfort: 'comfort' },
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: 'turbo',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('turbo');
    expect(warns[0]).to.include('eco');
    expect(warns[0]).to.include('comfort');
  });

  it('rejects enum violations for multi-parameter commands', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'mode', type: 'mixed', states: { eco: 'eco', comfort: 'comfort' } },
        { param: 'temperature', type: 'number', min: 10, max: 30 },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{"mode": "turbo", "temperature": 21}',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('turbo');
    expect(warns[0]).to.include('eco');
  });

  it('rejects values below numeric minimum', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'temperature',
      type: 'number',
      min: 10,
      max: 30,
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '5',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('below minimum');
    expect(warns[0]).to.include('10');
  });

  it('rejects values above numeric maximum', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'temperature',
      type: 'number',
      min: 10,
      max: 30,
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '35',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('exceeds maximum');
    expect(warns[0]).to.include('30');
  });

  it('rejects multi-parameter commands with missing required parameters', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'slope', type: 'number', min: 0.2, max: 3.5 },
        { param: 'shift', type: 'number', min: -13, max: 40 },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{"slope": 1.5}',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('Missing required parameter');
    expect(warns[0]).to.include('shift');
  });

  it('rejects multi-parameter commands with min/max violations', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'slope', type: 'number', min: 0.2, max: 3.5 },
        { param: 'shift', type: 'number', min: -13, max: 40 },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{"slope": 5.0, "shift": -20}',
    });

    expect(calls).to.have.length(0);
    expect(warns).to.have.length(1);
    expect(warns[0]).to.include('exceeds maximum');
    expect(warns[0]).to.include('below minimum');
  });

  it('keeps boolean single-parameter command values as booleans', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: 'active',
      type: 'mixed',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', { ack: false, val: true });

    expect(warns).to.have.length(0);
    expect(calls).to.have.length(1);
    expect(calls[0].data).to.equal(JSON.stringify({ active: true }));
  });

  it('keeps boolean values in multi-parameter commands', async () => {
    const { adapter, calls, warns } = setupCommandTest({
      param: [
        { param: 'active', type: 'mixed' },
        { param: 'temperature', type: 'number' },
      ],
      type: 'object',
    });

    await adapter.onStateChange('viessmannapi.0.device.feature.setValue', {
      ack: false,
      val: '{"active": false, "temperature": 21}',
    });

    expect(warns).to.have.length(0);
    expect(calls).to.have.length(1);
    expect(calls[0].data).to.equal(JSON.stringify({ active: false, temperature: 21 }));
  });

  it('clears the previous feature refresh timer on consecutive commands', async () => {
    const timers = useFakeTimers();
    try {
      const { adapter } = setupCommandTest({
        param: 'temperature',
        type: 'number',
      });

      await adapter.onStateChange('viessmannapi.0.device.feature.setValue', { ack: false, val: '21' });
      await adapter.onStateChange('viessmannapi.0.device.feature.setValue', { ack: false, val: '22' });

      expect(timers.timeouts).to.have.length(2);
      expect(timers.timeouts[0].active).to.equal(false);
      expect(timers.timeouts[1].active).to.equal(true);
      expect(adapter.refreshTimeout).to.equal(timers.timeouts[1]);
    } finally {
      timers.restore();
    }
  });
});

describe('Viessmannapi config sanitization', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  it('falls back to defaults for non-numeric config values', () => {
    const adapter = createAdapter();

    adapter.config = { interval: NaN, eventInterval: 'abc', gatewayIndex: undefined };
    adapter.sanitizeConfig();

    expect(adapter.config.interval).to.equal(5);
    expect(adapter.config.eventInterval).to.equal(300);
    expect(adapter.config.gatewayIndex).to.equal(1);
  });

  it('clamps out-of-range values and floors the gateway index', () => {
    const adapter = createAdapter();

    adapter.config = { interval: 0.1, eventInterval: 99999999, gatewayIndex: 2.7 };
    adapter.sanitizeConfig();

    expect(adapter.config.interval).to.equal(0.5);
    expect(adapter.config.eventInterval).to.equal(44640);
    expect(adapter.config.gatewayIndex).to.equal(2);
  });

  it('accepts valid numeric strings from older configs', () => {
    const adapter = createAdapter();

    adapter.config = { interval: '5', eventInterval: '300', gatewayIndex: '1' };
    adapter.sanitizeConfig();

    expect(adapter.config.interval).to.equal(5);
    expect(adapter.config.eventInterval).to.equal(300);
    expect(adapter.config.gatewayIndex).to.equal(1);
  });
});

describe('Viessmannapi device discovery', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  function setupDiscoveryTest(installations, config = {}) {
    const adapter = createAdapter();
    const warns = [];
    const createdObjects = [];

    adapter.config = { gatewayIndex: 1, ...config };
    adapter.session = { access_token: 'access-token' };
    adapter.log.warn = (msg) => warns.push(String(msg));
    adapter.extractKeys = async () => {};
    adapter.setObjectNotExistsAsync = async (id) => {
      createdObjects.push(id);
    };
    adapter.requestClient.defaults.adapter = async (cfg) => ({
      config: cfg,
      data: { data: installations },
      headers: {},
      status: 200,
      statusText: 'OK',
    });

    return { adapter, warns, createdObjects };
  }

  it('clamps an out-of-range gateway index for single-gateway installations', async () => {
    const { adapter, warns, createdObjects } = setupDiscoveryTest(
      [
        {
          id: 1,
          description: 'Home',
          gateways: [{ aggregatedStatus: 'Online', devices: [{ id: 'device-1', modelId: 'model' }] }],
        },
      ],
      { gatewayIndex: 3 },
    );

    await adapter.getDeviceIds();

    expect(warns.join('\n')).to.include('is not valid');
    expect(adapter.gatewayIndexObject['1']).to.equal(1);
    expect(createdObjects).to.include('1.device-1');
  });

  it('continues discovery for remaining installations when one has no online gateway', async () => {
    const { adapter, createdObjects } = setupDiscoveryTest([
      {
        id: 1,
        description: 'A',
        gateways: [{ aggregatedStatus: 'Offline', devices: [{ id: 'device-1', modelId: 'model' }] }],
      },
      {
        id: 2,
        description: 'B',
        gateways: [{ aggregatedStatus: 'Online', devices: [{ id: 'device-2', modelId: 'model' }] }],
      },
    ]);

    await adapter.getDeviceIds();

    expect(createdObjects).not.to.include('1.device-1');
    expect(createdObjects).to.include('2.device-2');
    expect(adapter.gatewayIndexObject['2']).to.equal(1);
  });
});

describe('extractKeys', () => {
  it('extracts nested objects after the returned promise resolves', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('nested');

    await extractKeys(adapter, root, {
      outer: {
        inner: {
          temperature: 21,
          enabled: true,
        },
      },
    });

    expect(adapter.objects.get(root)).to.include({ type: 'channel' });
    expect(adapter.objects.get(`${root}.outer.inner.temperature`).common).to.include({ type: 'number', role: 'value' });
    expect(adapter.objects.get(`${root}.outer.inner.enabled`).common).to.include({ type: 'boolean', role: 'indicator' });
    expect(adapter.states.get(`${root}.outer.inner.temperature`)).to.deep.equal({ val: 21, ack: true });
    expect(adapter.states.get(`${root}.outer.inner.enabled`)).to.deep.equal({ val: true, ack: true });
  });

  it('extracts arrays sequentially with indexed for-of processing', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('arrays');

    await extractKeys(adapter, root, {
      items: [
        {
          id: 'item.1',
          value: 7,
          details: {
            label: 'first',
          },
        },
        {
          name: 'Named.Item',
          active: false,
        },
      ],
    });

    expect(adapter.states.get(`${root}.item1.value`)).to.deep.equal({ val: 7, ack: true });
    expect(adapter.states.get(`${root}.item1.details.label`)).to.deep.equal({ val: 'first', ack: true });
    expect(adapter.states.get(`${root}.items.Named.Item`)).to.deep.equal({ val: false, ack: true });
  });

  it('creates writable command metadata from executable command params', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('command');

    await extractKeys(adapter, root, {
      feature: 'heating.curve.setCurve',
      isExecutable: true,
      params: {
        slope: {
          type: 'number',
          constraints: {
            min: 0.2,
            max: 3.5,
          },
        },
        mode: {
          type: 'string',
          constraints: {
            enum: ['eco', 'comfort'],
          },
        },
      },
    });

    const setValueObject = adapter.objects.get(`${root}.setValue`);
    expect(setValueObject).to.exist;
    expect(setValueObject.common).to.include({ write: true, read: true, type: 'object' });
    expect(setValueObject.common.param).to.deep.equal([
      {
        param: 'slope',
        type: 'number',
        min: 0.2,
        max: 3.5,
      },
      {
        param: 'mode',
        type: 'mixed',
        states: {
          eco: 'eco',
          comfort: 'comfort',
        },
      },
    ]);
    expect(adapter.states.get(`${root}.isExecutable`)).to.deep.equal({ val: true, ack: true });
  });

  it('parses JSON-string values and extracts nested content', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('json');

    await extractKeys(adapter, root, {
      payload: JSON.stringify({
        nested: {
          value: 42,
        },
        list: [
          {
            name: 'alpha',
            value: 1,
          },
        ],
      }),
    });

    expect(adapter.states.get(`${root}.payload.nested.value`)).to.deep.equal({ val: 42, ack: true });
    expect(adapter.states.get(`${root}.payload.list.alpha`)).to.deep.equal({ val: 1, ack: true });
  });

  it('extracts event arrays with forced index paths', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('events');

    await extractKeys(adapter, root, [
      {
        start_date_time: '2026-05-15T12:00:00Z',
        eventType: 'gateway.online',
        body: {
          severity: 'info',
        },
      },
      {
        start_date_time: '2026-05-15T12:05:00Z',
        eventType: 'gateway.offline',
      },
    ], null, true);

    expect(adapter.states.get(`${root}.01.eventType`)).to.deep.equal({ val: 'gateway.online', ack: true });
    expect(adapter.states.get(`${root}.01.body.severity`)).to.deep.equal({ val: 'info', ack: true });
    expect(adapter.states.get(`${root}.02.eventType`)).to.deep.equal({ val: 'gateway.offline', ack: true });
  });

  it('keeps the created-object cache per adapter instance', async () => {
    const first = createExtractKeysAdapterMock();
    const second = createExtractKeysAdapterMock();
    const root = testRoot('cache');

    await extractKeys(first, root, { temperature: 21 });
    await extractKeys(second, root, { temperature: 21 });

    expect(first.objects.has(`${root}.temperature`)).to.equal(true);
    expect(second.objects.has(`${root}.temperature`)).to.equal(true);
  });

  it('keeps numeric and boolean strings as strings instead of parsing them as JSON', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('numericString');

    await extractKeys(adapter, root, { serial: '123456', flag: 'true' });

    expect(adapter.objects.get(`${root}.serial`).common.type).to.equal('string');
    expect(adapter.states.get(`${root}.serial`)).to.deep.equal({ val: '123456', ack: true });
    expect(adapter.objects.get(`${root}.flag`).common.type).to.equal('string');
    expect(adapter.states.get(`${root}.flag`)).to.deep.equal({ val: 'true', ack: true });
  });

  it('creates states for top-level primitive arrays without empty path segments', async () => {
    const adapter = createExtractKeysAdapterMock();
    const root = testRoot('primitives');

    await extractKeys(adapter, root, ['alpha', 'beta']);

    expect(adapter.states.get(`${root}.alpha`)).to.deep.equal({ val: 'alpha', ack: true });
    expect(adapter.states.get(`${root}.beta`)).to.deep.equal({ val: 'beta', ack: true });
    const invalidIds = Array.from(adapter.objects.keys()).filter((id) => id.includes('..'));
    expect(invalidIds).to.deep.equal([]);
  });
});
