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

function transientServerError(config) {
  const error = new Error('Request failed with status code 500');
  error.config = config;
  error.response = {
    status: 500,
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

function testRoot(name) {
  testCounter += 1;
  return `test.${testCounter}.${name}`;
}

describe('Viessmannapi retry handling', () => {
  afterEach(() => {
    delete require.cache[require.resolve('./main')];
  });

  it('attaches the retry interceptor and keeps retries disabled by default', () => {
    const adapter = createAdapter();

    expect(adapter.retryInterceptorId).to.be.a('number');
    expect(adapter.requestClient.defaults.raxConfig).to.include({
      instance: adapter.requestClient,
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
      noResponseRetries: 2,
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
});
