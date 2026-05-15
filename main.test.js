'use strict';

const EventEmitter = require('events');
const Module = require('module');
const { expect } = require('chai');

const noop = () => {};

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
