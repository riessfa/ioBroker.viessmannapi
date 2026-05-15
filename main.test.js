'use strict';

const { expect } = require('chai');
const { extractKeys } = require('./lib/extractKeys');

let testCounter = 0;

function createAdapterMock() {
  const objects = new Map();
  const states = new Map();
  const stateWrites = [];

  return {
    objects,
    states,
    stateWrites,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
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

describe('extractKeys', () => {
  it('extracts nested objects after the returned promise resolves', async () => {
    const adapter = createAdapterMock();
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
    const adapter = createAdapterMock();
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
    const adapter = createAdapterMock();
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
    const adapter = createAdapterMock();
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
    const adapter = createAdapterMock();
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
