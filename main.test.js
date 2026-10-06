'use strict';

/*
 * Unit tests for the Viessmann adapter. main.js is loaded with a mocked
 * @iobroker/adapter-core. HTTP is mocked through a custom axios adapter on the
 * adapter's own request client, timers through the adapter-managed
 * setTimeout/setInterval methods of the mock (no global timer patching).
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const Module = require('module');
const { expect } = require('chai');
const { AxiosError } = require('axios');

const { extractKeys } = require('./lib/extractKeys');
const { parseList, compileFeatureFilter } = require('./lib/filters');
const safeLog = require('./lib/safeLog');
const apiClient = require('./lib/apiClient');
const auth = require('./lib/auth');

const NS = 'viessmannapi.0';
const API = 'https://api.viessmann-climatesolutions.com';
const IAM = 'https://iam.viessmann-climatesolutions.com/idp/v3';

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function createLog() {
    const logs = { debug: [], info: [], warn: [], error: [] };
    const log = { level: 'info', logs };
    for (const level of Object.keys(logs)) {
        log[level] = message => logs[level].push(String(message));
    }
    return log;
}

class MockAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.namespace = NS;
        this.config = {};
        this.log = createLog();
        this.objects = new Map();
        this.states = new Map();
        this.stateWrites = [];
        this.extendCalls = [];
        this.subscriptions = [];
        this.deletedObjects = [];
        this.objectViewRows = [];
        this.timers = [];
    }

    // adapter-managed timers: recorded, never run automatically
    setTimeout(callback, ms) {
        const timer = { type: 'timeout', callback, ms, cleared: false, fired: false };
        this.timers.push(timer);
        return timer;
    }
    clearTimeout(timer) {
        if (timer) {
            timer.cleared = true;
        }
    }
    setInterval(callback, ms) {
        const timer = { type: 'interval', callback, ms, cleared: false, fired: false };
        this.timers.push(timer);
        return timer;
    }
    clearInterval(timer) {
        if (timer) {
            timer.cleared = true;
        }
    }

    setState(id, val, ack) {
        this.stateWrites.push({ id, val, ack });
        this.states.set(id, { val, ack });
    }
    async setStateAsync(id, val, ack) {
        this.setState(id, val, ack);
    }
    async getStateAsync(id) {
        return this.states.get(id) || null;
    }
    async getObjectAsync(id) {
        return this.objects.get(id) || null;
    }
    async setObjectNotExistsAsync(id, obj) {
        if (!this.objects.has(id)) {
            this.objects.set(id, obj);
        }
    }
    async extendObjectAsync(id, obj) {
        this.extendCalls.push({ id, obj });
        const existing = this.objects.get(id);
        this.objects.set(id, existing ? { ...existing, ...obj, common: { ...existing.common, ...obj.common } } : obj);
    }
    async subscribeStatesAsync(pattern) {
        this.subscriptions.push(pattern);
    }
    async getObjectViewAsync(design, search, params) {
        this.objectViewCall = { design, search, params };
        return { rows: this.objectViewRows };
    }
    async delObjectAsync(id, options) {
        this.deletedObjects.push({ id, options });
    }
}

function loadAdapterFactory() {
    const originalLoad = Module._load;
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

const adapterFactory = loadAdapterFactory();

function createAdapter(config = {}) {
    const adapter = adapterFactory({});
    adapter.config = {
        username: 'user@example.com',
        password: 'secret',
        client_id: 'client',
        interval: 5,
        eventInterval: 300,
        gatewayIndex: 1,
        ...config,
    };
    return adapter;
}

function activeTimeouts(adapter) {
    return adapter.timers.filter(t => t.type === 'timeout' && !t.cleared && !t.fired);
}
function activeIntervals(adapter) {
    return adapter.timers.filter(t => t.type === 'interval' && !t.cleared);
}
async function fire(timer) {
    timer.fired = timer.type === 'timeout';
    return timer.callback();
}

// ---------------------------------------------------------------------------
// HTTP mock (custom axios adapter)
// ---------------------------------------------------------------------------

/**
 * Installs a custom axios adapter on the adapter's request client. `handler`
 * gets the request config and returns `{ status, data, headers }` or throws.
 * Responses failing `validateStatus` are rejected like axios' own adapters do.
 */
function mockHttp(adapter, handler) {
    const calls = [];
    adapter.requestClient.defaults.adapter = async config => {
        calls.push(config);
        const reply = (await handler(config, calls.length - 1)) || {};
        const response = {
            data: reply.data,
            status: reply.status || 200,
            statusText: '',
            headers: reply.headers || {},
            config,
            request: {},
        };
        if (config.validateStatus && !config.validateStatus(response.status)) {
            throw new AxiosError(
                `Request failed with status code ${response.status}`,
                response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
                config,
                {},
                response,
            );
        }
        return response;
    };
    return calls;
}

/** Routes by URL substring; values are replies or functions returning replies. */
function router(table) {
    return (config, index) => {
        for (const [pattern, reply] of table) {
            if (config.url.includes(pattern)) {
                return typeof reply === 'function' ? reply(config, index) : reply;
            }
        }
        throw new Error(`Unexpected request ${config.method} ${config.url}`);
    };
}

function networkError(config) {
    return new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED', config, {});
}

function device(id, extra = {}) {
    return {
        id,
        gatewaySerial: 'GW1',
        modelId: `model-${id}`,
        roles: ['type:boiler'],
        deviceType: 'heating',
        ...extra,
    };
}

function installation(id, devices, gatewayExtra = {}) {
    return {
        id,
        description: `Home ${id}`,
        gateways: [{ serial: 'GW1', aggregatedStatus: 'WorksProperly', devices, ...gatewayExtra }],
    };
}

function feature(name, deviceId = '0') {
    return {
        feature: name,
        isEnabled: true,
        properties: { value: { type: 'number', value: 1 } },
        uri: `${API}/iot/v2/features/installations/111/gateways/GW1/devices/${deviceId}/features/${name}`,
    };
}

/** Prepares an adapter as if discovery already ran, with extractKeys recorded. */
function discoveredAdapter(installations, config = {}) {
    const adapter = createAdapter(config);
    adapter.sanitizeConfig();
    adapter.session = { access_token: 'token' };
    adapter.installationArray = installations;
    for (const inst of installations) {
        adapter.gatewayIndexObject[String(inst.id)] = 1;
    }
    adapter.deviceDiscoveryDone = true;
    adapter.stored = [];
    adapter.extractKeys = async (_a, path, data, ...rest) => {
        adapter.stored.push({ path, data, rest });
    };
    return adapter;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

describe('auth: PKCE', () => {
    it('getCodeChallenge returns a hex verifier and its base64url S256 challenge', () => {
        const [verifier, challenge] = auth.getCodeChallenge();
        expect(verifier).to.match(/^[0-9a-f]{64}$/);
        expect(challenge).to.equal(crypto.createHash('sha256').update(verifier).digest('base64url'));
        expect(challenge).to.match(/^[A-Za-z0-9_-]{43}$/);
    });

    it('generates a different verifier on each call', () => {
        expect(auth.getCodeChallenge()[0]).to.not.equal(auth.getCodeChallenge()[0]);
    });

    it('getCodeFromLocation extracts the code or returns undefined', () => {
        expect(auth.getCodeFromLocation('http://localhost:4200/?code=abc&state=1')).to.equal('abc');
        expect(auth.getCodeFromLocation('http://localhost:4200/?error=x')).to.equal(undefined);
        expect(auth.getCodeFromLocation('http://localhost:4200/')).to.equal(undefined);
        expect(auth.getCodeFromLocation(undefined)).to.equal(undefined);
    });
});

describe('auth: login', () => {
    function loginAdapter(tokenReply, authorizeReply) {
        const adapter = createAdapter();
        adapter.getCodeChallenge = () => ['my-verifier', 'my-challenge'];
        const calls = mockHttp(
            adapter,
            router([
                [
                    '/authorize',
                    authorizeReply || {
                        status: 302,
                        headers: { location: 'http://localhost:4200/?code=auth-code&state=x' },
                    },
                ],
                [
                    '/token',
                    tokenReply || {
                        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
                    },
                ],
            ]),
        );
        return { adapter, calls };
    }

    it('reads the code from the 302 location header and exchanges it for a token', async () => {
        const { adapter, calls } = loginAdapter();

        expect(await adapter.login()).to.equal(true);

        expect(calls).to.have.length(2);
        const [authorize, token] = calls;
        expect(authorize.method).to.equal('get');
        expect(authorize.url).to.equal(`${IAM}/authorize`);
        expect(authorize.maxRedirects).to.equal(0);
        expect(authorize.validateStatus(302)).to.equal(true);
        expect(authorize.validateStatus(401)).to.equal(false);
        expect(authorize.params).to.include({
            client_id: 'client',
            response_type: 'code',
            code_challenge_method: 'S256',
            code_challenge: 'my-challenge',
            redirect_uri: 'http://localhost:4200/',
        });
        expect(authorize.headers.Authorization).to.equal(
            `Basic ${Buffer.from('user@example.com:secret').toString('base64')}`,
        );

        expect(token.method).to.equal('post');
        expect(token.url).to.equal(`${IAM}/token`);
        expect(String(token.headers['Content-Type'])).to.include('application/x-www-form-urlencoded');
        const body = new URLSearchParams(token.data);
        expect(body.get('grant_type')).to.equal('authorization_code');
        expect(body.get('code')).to.equal('auth-code');
        expect(body.get('code_verifier')).to.equal('my-verifier');
        expect(body.get('redirect_uri')).to.equal('http://localhost:4200/');
        expect(body.get('client_id')).to.equal('client');

        expect(adapter.session).to.deep.equal({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
        expect(adapter.states.get('info.connection')).to.deep.equal({ val: true, ack: true });
        const timers = activeTimeouts(adapter);
        expect(timers).to.have.length(1);
        expect(timers[0].ms).to.equal((3600 - 100) * 1000);
        expect(adapter.refreshTokenTimeout).to.equal(timers[0]);
    });

    it('fails without a token request when no code is returned', async () => {
        const { adapter, calls } = loginAdapter(undefined, { status: 200, data: '<html>login</html>' });

        expect(await adapter.login()).to.equal(false);

        expect(calls).to.have.length(1);
        expect(adapter.log.logs.error.join()).to.include('no authorization code');
        expect(adapter.states.get('info.connection')).to.deep.equal({ val: false, ack: true });
        expect(activeTimeouts(adapter)).to.have.length(0);
    });

    it('fails cleanly when the authorize endpoint answers 401', async () => {
        const { adapter, calls } = loginAdapter(undefined, { status: 401, data: { error: 'unauthorized' } });

        expect(await adapter.login()).to.equal(false);

        expect(calls).to.have.length(1);
        expect(adapter.log.logs.error.join()).to.include('Authorization request failed');
        expect(adapter.log.logs.error.join()).to.not.include('secret');
        expect(adapter.states.get('info.connection').val).to.equal(false);
    });

    it('handles authorize failures without a response body', async () => {
        const { adapter } = loginAdapter(undefined, { status: 500 });
        expect(await adapter.login()).to.equal(false);
    });

    it('fails cleanly when the token request fails and keeps the session empty', async () => {
        const { adapter } = loginAdapter({ status: 400, data: { error: 'invalid_grant' } });

        expect(await adapter.login()).to.equal(false);

        expect(adapter.session).to.deep.equal({});
        expect(adapter.log.logs.error.join()).to.include('Token request failed');
        expect(adapter.states.get('info.connection').val).to.equal(false);
        expect(activeTimeouts(adapter)).to.have.length(0);
    });

    it('fails when the token response carries no access token', async () => {
        const { adapter } = loginAdapter({ data: { refresh_token: 'rt' } });
        expect(await adapter.login()).to.equal(false);
        expect(adapter.states.get('info.connection').val).to.equal(false);
        expect(activeTimeouts(adapter)).to.have.length(0);
    });

    it('logs the IAM hint for an unregistered client', async () => {
        const { adapter } = loginAdapter(undefined, {
            status: 400,
            data: { error: 'invalid_client', error_description: 'Client not registered.' },
        });
        await adapter.login();
        expect(adapter.log.logs.error.join()).to.include('Cannot find clientId');
    });

    it('logs the IAM hint for an invalid redirect URI', async () => {
        const { adapter } = loginAdapter({ status: 400, data: { error: 'Invalid redirection URI.' } });
        await adapter.login();
        expect(adapter.log.logs.error.join()).to.include('Please add / at the end of the redirect URI');
    });
});

describe('auth: refreshToken', () => {
    function refreshAdapter(reply) {
        const adapter = createAdapter();
        adapter.session = { access_token: 'old', refresh_token: 'rt', expires_in: 3600, id_token: 'keep' };
        adapter.connected = true;
        const calls = mockHttp(adapter, router([['/token', reply]]));
        return { adapter, calls };
    }

    it('merges the response into the session and keeps the refresh token', async () => {
        const { adapter, calls } = refreshAdapter({ data: { access_token: 'new', expires_in: 1800 } });

        await adapter.refreshToken();

        const body = new URLSearchParams(calls[0].data);
        expect(body.get('grant_type')).to.equal('refresh_token');
        expect(body.get('refresh_token')).to.equal('rt');
        expect(body.get('client_id')).to.equal('client');
        expect(adapter.session).to.deep.equal({
            access_token: 'new',
            refresh_token: 'rt',
            expires_in: 1800,
            id_token: 'keep',
        });
        const timers = activeTimeouts(adapter);
        expect(timers).to.have.length(1);
        expect(timers[0].ms).to.equal((1800 - 100) * 1000);
    });

    it('takes over a new refresh token when the response contains one', async () => {
        const { adapter } = refreshAdapter({ data: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } });
        await adapter.refreshToken();
        expect(adapter.session.refresh_token).to.equal('rt2');
    });

    it('sets info.connection true after a successful refresh', async () => {
        const { adapter } = refreshAdapter({ data: { access_token: 'new', expires_in: 3600 } });
        adapter.connected = false;
        await adapter.refreshToken();
        expect(adapter.states.get('info.connection')).to.deep.equal({ val: true, ack: true });
    });

    for (const [label, reply] of [
        ['a 503 response', { status: 503 }],
        ['a 500 response', { status: 500, data: { message: 'boom' } }],
        [
            'a network error',
            config => {
                throw networkError(config);
            },
        ],
    ]) {
        it(`retries the refresh in 30s and keeps the session after ${label}`, async () => {
            const { adapter } = refreshAdapter(reply);

            await adapter.refreshToken();

            expect(adapter.session.refresh_token).to.equal('rt');
            expect(adapter.session.access_token).to.equal('old');
            expect(adapter.reLoginTimeout).to.equal(null);
            const timers = activeTimeouts(adapter);
            expect(timers).to.have.length(1);
            expect(timers[0].ms).to.equal(30 * 1000);
            expect(adapter.refreshTokenTimeout).to.equal(timers[0]);
            expect(adapter.log.logs.info.join()).to.include('Retrying in 30 seconds');
            expect(adapter.stateWrites).to.have.length(0);
        });
    }

    it('clears the session and schedules a relogin when the refresh token is rejected (400)', async () => {
        const { adapter } = refreshAdapter({ status: 400, data: { error: 'invalid_grant' } });

        await adapter.refreshToken();

        expect(adapter.session).to.deep.equal({});
        expect(adapter.states.get('info.connection')).to.deep.equal({ val: false, ack: true });
        expect(adapter.refreshTokenTimeout).to.equal(null);
        const timers = activeTimeouts(adapter);
        expect(timers).to.have.length(1);
        expect(timers[0].ms).to.equal(60 * 1000);
        expect(adapter.reLoginTimeout).to.equal(timers[0]);
        expect(adapter.reloginAttempts).to.equal(1);
    });

    it('schedules a relogin without a request when no refresh token exists', async () => {
        const { adapter, calls } = refreshAdapter({ data: {} });
        adapter.session = { access_token: 'x' };

        await adapter.refreshToken();

        expect(calls).to.have.length(0);
        expect(adapter.session).to.deep.equal({});
        expect(adapter.reLoginTimeout).to.not.equal(null);
    });

    it('firing the scheduled refresh timer calls refreshToken', async () => {
        const adapter = createAdapter();
        adapter.session = { expires_in: 3600 };
        let refreshed = 0;
        adapter.refreshToken = async () => {
            refreshed++;
        };
        adapter.scheduleTokenRefresh();
        await fire(adapter.refreshTokenTimeout);
        expect(refreshed).to.equal(1);
        expect(adapter.refreshTokenTimeout).to.equal(null);
    });
});

describe('auth: timers', () => {
    it('uses the 30s minimum refresh delay for missing or tiny expiry values', () => {
        for (const expires of [undefined, 'abc', 100, 50]) {
            const adapter = createAdapter();
            adapter.session = { expires_in: expires };
            adapter.scheduleTokenRefresh();
            expect(activeTimeouts(adapter)[0].ms).to.equal(30 * 1000);
            expect(adapter.log.logs.warn.join()).to.include('Invalid or very small token expiry');
        }
    });

    it('enforces the minimum delay for explicit delays', () => {
        const adapter = createAdapter();
        adapter.scheduleTokenRefresh(1000);
        expect(activeTimeouts(adapter)[0].ms).to.equal(30 * 1000);
    });

    it('replaces a previous refresh timer instead of stacking timers', () => {
        const adapter = createAdapter();
        adapter.scheduleTokenRefresh(30000);
        adapter.scheduleTokenRefresh(30000);
        adapter.scheduleTokenRefresh(30000);
        expect(activeTimeouts(adapter)).to.have.length(1);
    });

    it('is a no-op while a relogin is pending', () => {
        const adapter = createAdapter();
        adapter.scheduleRelogin();
        const relogin = adapter.reLoginTimeout;

        adapter.scheduleTokenRefresh(30000);

        expect(adapter.refreshTokenTimeout).to.equal(null);
        expect(activeTimeouts(adapter)).to.deep.equal([relogin]);
    });

    it('backs off relogin delays exponentially and caps them at 30 minutes', () => {
        const adapter = createAdapter();
        const delays = [];
        for (let i = 0; i < 8; i++) {
            adapter.scheduleRelogin();
            delays.push(adapter.reLoginTimeout.ms / 1000);
        }
        expect(delays).to.deep.equal([60, 120, 240, 480, 960, 1800, 1800, 1800]);
        expect(activeTimeouts(adapter)).to.have.length(1);
    });

    it('a relogin clears a pending refresh timer', () => {
        const adapter = createAdapter();
        adapter.scheduleTokenRefresh(30000);
        const refresh = adapter.refreshTokenTimeout;
        adapter.scheduleRelogin();
        expect(refresh.cleared).to.equal(true);
        expect(adapter.refreshTokenTimeout).to.equal(null);
    });

    it('firing the relogin timer reconnects and resets the backoff after success', async () => {
        const adapter = createAdapter();
        adapter.deviceDiscoveryDone = true;
        adapter.login = async () => {
            adapter.session = { access_token: 'at' };
            return true;
        };
        adapter.scheduleRelogin();
        adapter.scheduleRelogin();
        expect(adapter.reloginAttempts).to.equal(2);

        await fire(adapter.reLoginTimeout);

        expect(adapter.reLoginTimeout).to.equal(null);
        expect(adapter.reloginAttempts).to.equal(0);
        expect(activeIntervals(adapter)).to.have.length(2);
    });

    it('does not schedule a relogin after unload', () => {
        const adapter = createAdapter();
        adapter.unloaded = true;
        adapter.scheduleRelogin();
        expect(adapter.timers).to.have.length(0);
    });
});

// ---------------------------------------------------------------------------
// connect / onReady
// ---------------------------------------------------------------------------

describe('connect()', () => {
    function successfulApi(adapter, installations) {
        return mockHttp(
            adapter,
            router([
                ['/equipment/installations', { data: { data: installations } }],
                ['/features', config => ({ data: { data: [feature('a'), feature('b')] }, config })],
                ['/events', { data: { data: [] } }],
            ]),
        );
    }

    function loginOk(adapter) {
        adapter.loginCalls = 0;
        adapter.login = async () => {
            adapter.loginCalls++;
            adapter.session = { access_token: 'at' };
            return true;
        };
    }

    it('schedules a relogin when the login fails', async () => {
        const adapter = createAdapter();
        adapter.login = async () => false;

        await adapter.connect();

        expect(adapter.log.logs.error.join()).to.include('Login failed');
        expect(adapter.reLoginTimeout).to.not.equal(null);
        expect(adapter.reLoginTimeout.ms).to.equal(60000);
        expect(activeIntervals(adapter)).to.have.length(0);
    });

    it('runs discovery, the initial fetch and starts polling once on success', async () => {
        const adapter = createAdapter();
        adapter.sanitizeConfig();
        loginOk(adapter);
        const calls = successfulApi(adapter, [installation(111, [device('0')])]);

        await adapter.connect();

        expect(adapter.deviceDiscoveryDone).to.equal(true);
        expect(calls.map(c => c.url)).to.deep.equal([
            `${API}/iot/v2/equipment/installations`,
            `${API}/iot/v2/features/installations/111/gateways/GW1/devices/0/features`,
            `${API}/iot/v2/events-history/installations/111/events`,
        ]);
        expect(calls[0].params).to.deep.equal({ includeGateways: true });
        expect(calls[0].headers.Authorization).to.equal('Bearer at');
        expect(activeIntervals(adapter).map(t => t.ms)).to.deep.equal([5 * 60000, 300 * 60000]);
        expect(adapter.reloginAttempts).to.equal(0);
        expect(adapter.updateRunning).to.equal(false);

        // a later reconnect neither rediscovers nor duplicates the intervals
        await adapter.connect();
        expect(calls).to.have.length(3);
        expect(activeIntervals(adapter)).to.have.length(2);
        expect(adapter.timers.filter(t => t.type === 'interval')).to.have.length(2);
    });

    it('leaves deviceDiscoveryDone false when the installations request fails and retries in pollDevices', async () => {
        const adapter = createAdapter();
        adapter.sanitizeConfig();
        loginOk(adapter);
        let fail = true;
        const calls = mockHttp(
            adapter,
            router([
                ['/equipment/installations', () => (fail ? { status: 500 } : { data: { data: [] } })],
                ['/events', { data: {} }],
            ]),
        );

        await adapter.connect();

        expect(adapter.deviceDiscoveryDone).to.equal(false);
        expect(adapter.log.logs.warn.join()).to.include('Device discovery failed');
        expect(activeIntervals(adapter)).to.have.length(2);
        expect(adapter.reLoginTimeout).to.equal(null);

        fail = false;
        await fire(adapter.updateInterval);
        expect(adapter.deviceDiscoveryDone).to.equal(true);
        expect(calls.filter(c => c.url.includes('/equipment/installations'))).to.have.length(2);
    });

    it('pollDevices does not rediscover while rate limited or logged out', async () => {
        const adapter = createAdapter();
        adapter.sanitizeConfig();
        const calls = mockHttp(adapter, () => ({ data: { data: [] } }));
        adapter.session = { access_token: 'at' };
        adapter.rateLimitedUntil = Date.now() + 60000;
        await adapter.pollDevices();
        adapter.rateLimitedUntil = 0;
        adapter.session = {};
        await adapter.pollDevices();
        expect(calls).to.have.length(0);
        expect(adapter.deviceDiscoveryDone).to.equal(false);
    });

    it('pollDevices updates devices once discovery is done', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')])]);
        let updates = 0;
        adapter.updateDevices = async () => {
            updates++;
        };
        await adapter.pollDevices();
        expect(updates).to.equal(1);
    });

    it('does not reject when something inside connect throws and schedules a relogin', async () => {
        const adapter = createAdapter();
        adapter.login = async () => {
            throw new Error('kaputt');
        };

        await adapter.connect();

        expect(adapter.log.logs.error.join()).to.include('Connect failed: kaputt');
        expect(adapter.reLoginTimeout).to.not.equal(null);
    });

    it('does nothing after unload', async () => {
        const adapter = createAdapter();
        let called = false;
        adapter.login = async () => {
            called = true;
            return true;
        };
        adapter.unloaded = true;
        await adapter.connect();
        expect(called).to.equal(false);
        expect(adapter.timers).to.have.length(0);
    });
});

describe('onReady', () => {
    it('logs an error and does not connect without credentials', async () => {
        for (const missing of ['username', 'password', 'client_id']) {
            const adapter = createAdapter({ [missing]: '' });
            let connected = false;
            adapter.connect = async () => {
                connected = true;
            };

            await adapter.onReady();

            expect(adapter.log.logs.error.join()).to.include('Please enter username, password and client ID');
            expect(connected).to.equal(false);
            expect(adapter.subscriptions).to.deep.equal([]);
            expect(adapter.states.get('info.connection')).to.deep.equal({ val: false, ack: true });
        }
    });

    it('treats whitespace-only username/client_id as missing', async () => {
        const adapter = createAdapter({ username: '  ', client_id: ' ' });
        adapter.connect = async () => {
            throw new Error('must not connect');
        };
        await adapter.onReady();
        expect(adapter.log.logs.error).to.have.length(1);
    });

    it('subscribes only to setValue states, removes legacy logbooks and connects', async () => {
        const adapter = createAdapter();
        let connected = 0;
        adapter.connect = async () => {
            connected++;
        };
        adapter.objectViewRows = [
            { id: `${NS}.111.0.features.device.messages.logbook` },
            { id: `${NS}.111.0.features.heating` },
        ];

        await adapter.onReady();

        expect(adapter.subscriptions).to.deep.equal(['*.setValue']);
        expect(adapter.objectViewCall.design).to.equal('system');
        expect(adapter.objectViewCall.search).to.equal('channel');
        expect(adapter.objectViewCall.params.startkey).to.equal(`${NS}.`);
        expect(adapter.objectViewCall.params.endkey.startsWith(`${NS}.`)).to.equal(true);
        expect(adapter.deletedObjects).to.deep.equal([
            { id: `${NS}.111.0.features.device.messages.logbook`, options: { recursive: true } },
        ]);
        expect(connected).to.equal(1);
    });

    it('still connects when the logbook cleanup fails', async () => {
        const adapter = createAdapter();
        let connected = 0;
        adapter.connect = async () => {
            connected++;
        };
        adapter.getObjectViewAsync = async () => {
            throw new Error('db down');
        };
        await adapter.onReady();
        expect(adapter.log.logs.warn.join()).to.include('Could not clean up logbook objects: db down');
        expect(connected).to.equal(1);
    });
});

// ---------------------------------------------------------------------------
// sanitizeConfig
// ---------------------------------------------------------------------------

describe('sanitizeConfig', () => {
    it('falls back to defaults for invalid and empty values', () => {
        const adapter = createAdapter({ interval: 'abc', eventInterval: '', gatewayIndex: null });
        adapter.sanitizeConfig();
        expect(adapter.config.interval).to.equal(5);
        expect(adapter.config.eventInterval).to.equal(300);
        expect(adapter.config.gatewayIndex).to.equal(1);
        expect(adapter.log.logs.warn).to.have.length(3);
    });

    it('clamps out-of-range values and floors the gateway index', () => {
        const adapter = createAdapter({ interval: 0.1, eventInterval: 100000, gatewayIndex: '2.7' });
        adapter.sanitizeConfig();
        expect(adapter.config.interval).to.equal(0.5);
        expect(adapter.config.eventInterval).to.equal(44640);
        expect(adapter.config.gatewayIndex).to.equal(2);

        const low = createAdapter({ gatewayIndex: 0 });
        low.sanitizeConfig();
        expect(low.config.gatewayIndex).to.equal(1);
    });

    it('accepts numeric strings from older configs', () => {
        const adapter = createAdapter({ interval: '10', eventInterval: '60', gatewayIndex: '3' });
        adapter.sanitizeConfig();
        expect(adapter.config).to.include({ interval: 10, eventInterval: 60, gatewayIndex: 3 });
    });

    it('trims username and client_id', () => {
        const adapter = createAdapter({ username: ' a@b.c ', client_id: ' id ' });
        adapter.sanitizeConfig();
        expect(adapter.config.username).to.equal('a@b.c');
        expect(adapter.config.client_id).to.equal('id');
    });

    it('parses the device list and feature filter', () => {
        const adapter = createAdapter({ devicelist: ' 0, 1 ,,', featureFilter: 'heating.*, device.name' });
        adapter.sanitizeConfig();
        expect(Array.from(adapter.deviceAllowList)).to.deep.equal(['0', '1']);
        expect(adapter.featureFilter('heating.boiler')).to.equal(true);
        expect(adapter.featureFilter('device.name')).to.equal(true);
        expect(adapter.featureFilter('device.serial')).to.equal(false);

        const empty = createAdapter({ devicelist: '', featureFilter: '' });
        empty.sanitizeConfig();
        expect(empty.deviceAllowList).to.equal(null);
        expect(empty.featureFilter).to.equal(null);
    });
});

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

describe('polling', () => {
    it('runPollingTask skips overlapping runs', async () => {
        const adapter = createAdapter();
        let release;
        let runs = 0;
        const first = adapter.runPollingTask('updateRunning', () => {
            runs++;
            return new Promise(resolve => {
                release = resolve;
            });
        });
        await adapter.runPollingTask('updateRunning', async () => {
            runs++;
        });
        expect(runs).to.equal(1);
        expect(adapter.log.logs.debug.join()).to.include('still running');
        release();
        await first;
        expect(adapter.updateRunning).to.equal(false);
        await adapter.runPollingTask('updateRunning', async () => {
            runs++;
        });
        expect(runs).to.equal(2);
    });

    it('runPollingTask logs errors and resets the flag', async () => {
        const adapter = createAdapter();
        await adapter.runPollingTask('eventsRunning', async () => {
            throw new Error('nope');
        });
        expect(adapter.log.logs.error.join()).to.include('events polling failed: nope');
        expect(adapter.eventsRunning).to.equal(false);
    });

    it('startPolling uses the configured minutes and only starts once', async () => {
        const adapter = createAdapter({ interval: 2, eventInterval: 60 });
        let polls = 0;
        let events = 0;
        adapter.pollDevices = async () => {
            polls++;
        };
        adapter.getEvents = async () => {
            events++;
        };

        adapter.startPolling();
        adapter.startPolling();

        expect(adapter.timers.map(t => [t.type, t.ms])).to.deep.equal([
            ['interval', 2 * 60 * 1000],
            ['interval', 60 * 60 * 1000],
        ]);
        await fire(adapter.updateInterval);
        await fire(adapter.eventInterval);
        expect([polls, events]).to.deep.equal([1, 1]);
    });

    it('clearPollingTimers clears both intervals', () => {
        const adapter = createAdapter();
        adapter.startPolling();
        const timers = [adapter.updateInterval, adapter.eventInterval];
        adapter.clearPollingTimers();
        expect(timers.every(t => t.cleared)).to.equal(true);
        expect(adapter.updateInterval).to.equal(null);
        expect(adapter.eventInterval).to.equal(null);
        adapter.clearPollingTimers();
    });
});

// ---------------------------------------------------------------------------
// rate limits and polling errors
// ---------------------------------------------------------------------------

describe('rate limit and polling error handling', () => {
    it('a 429 with limitReset pauses requests until the reset and warns once', () => {
        const adapter = createAdapter();
        adapter.session = { access_token: 'at' };
        const reset = Date.now() + 3600 * 1000;

        adapter.handleRateLimit({ extendedPayload: { limitReset: reset, name: 'Daily limit' } });
        adapter.handleRateLimit({ extendedPayload: { limitReset: reset + 1000 } });

        expect(adapter.rateLimitedUntil).to.equal(reset + 1000);
        expect(adapter.log.logs.warn).to.have.length(1);
        expect(adapter.log.logs.warn[0]).to.include('rate limit reached (Daily limit)');
        expect(adapter.log.logs.warn[0]).to.include(new Date(reset).toISOString());
        expect(adapter.canRequest()).to.equal(false);

        adapter.rateLimitedUntil = Date.now() - 1;
        expect(adapter.canRequest()).to.equal(true);
    });

    it('falls back to 10 minutes when no (or a past) reset time is given', () => {
        for (const data of [undefined, {}, { extendedPayload: { limitReset: Date.now() - 1000 } }]) {
            const adapter = createAdapter();
            const before = Date.now();
            adapter.handleRateLimit(data);
            expect(adapter.rateLimitedUntil).to.be.within(before + 600000, Date.now() + 600000);
        }
    });

    it('canRequest is false without token or after unload', () => {
        const adapter = createAdapter();
        expect(adapter.canRequest()).to.equal(false);
        adapter.session = { access_token: 'at' };
        expect(adapter.canRequest()).to.equal(true);
        adapter.unloaded = true;
        expect(adapter.canRequest()).to.equal(false);
    });

    it('updateDevices stops issuing requests after a 429', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0'), device('1'), device('2')])]);
        const calls = mockHttp(adapter, () => ({
            status: 429,
            data: { extendedPayload: { limitReset: Date.now() + 60000 } },
        }));

        await adapter.updateDevices();

        expect(calls).to.have.length(1);
        expect(adapter.log.logs.error).to.have.length(0);
        expect(adapter.log.logs.warn).to.have.length(1);
    });

    it('a 401 schedules a token refresh in 30 seconds', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')])]);
        mockHttp(adapter, () => ({ status: 401, data: { error: 'expired' } }));

        await adapter.updateDevices();
        await adapter.updateDevices();

        expect(adapter.refreshTokenTimeout.ms).to.equal(30000);
        expect(activeTimeouts(adapter)).to.have.length(1);
        expect(adapter.log.logs.info.join()).to.include('received 401');
        expect(adapter.log.logs.error).to.have.length(0);
    });

    for (const [status, text] of [
        [500, 'Error 500'],
        [503, 'Error 503'],
        [502, 'check the connection of your gateway'],
        [504, 'not available'],
    ]) {
        it(`logs ${status} at info level without an error dump`, async () => {
            const adapter = discoveredAdapter([installation(111, [device('0')])]);
            mockHttp(adapter, () => ({ status, data: { message: 'x' } }));
            await adapter.updateDevices();
            expect(adapter.log.logs.error).to.have.length(0);
            expect(adapter.log.logs.info.join()).to.include(text);
        });
    }

    it('logs unexpected errors with redacted details', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')])]);
        mockHttp(adapter, () => ({ status: 400, data: { message: 'bad' } }));
        await adapter.updateDevices();
        const errors = adapter.log.logs.error.join('\n');
        expect(errors).to.include('Feature update request failed');
        expect(errors).to.include('/devices/0/features');
        expect(errors).to.not.include('Bearer token');
    });

    it('ignores canceled requests silently', () => {
        const adapter = createAdapter();
        const handled = adapter.handleKnownPollingError(
            new AxiosError('canceled', 'ERR_CANCELED'),
            'features feature update',
        );
        expect(handled).to.equal(true);
        expect(adapter.log.logs.info.concat(adapter.log.logs.warn, adapter.log.logs.error)).to.deep.equal([]);
    });

    it('cancels in-flight requests after unload without logging', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')])]);
        const calls = mockHttp(adapter, () => ({ data: {} }));
        adapter.abortController.abort();
        const body = await adapter.fetchFeatures(`${API}/x`);
        expect(body).to.equal(undefined);
        expect(calls).to.have.length(0);
        expect(adapter.log.logs.error).to.deep.equal([]);
    });

    it('network errors are logged as errors', () => {
        const adapter = createAdapter();
        expect(adapter.handleKnownPollingError(networkError({}), 'x')).to.equal(false);
    });

    it('getEvents handles errors per installation and stores events', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')]), installation(222, [device('0')])]);
        mockHttp(
            adapter,
            router([
                ['/111/events', { status: 500 }],
                ['/222/events', { data: { data: [{ eventType: 'a' }] } }],
            ]),
        );
        await adapter.getEvents();
        expect(adapter.stored.map(s => s.path)).to.deep.equal(['222.events']);
        expect(adapter.stored[0].data).to.deep.equal({ eventType: 'a' });
    });
});

// ---------------------------------------------------------------------------
// updateDevices
// ---------------------------------------------------------------------------

describe('updateDevices', () => {
    const roleDevices = () => [
        device('0'),
        device('gateway', { roles: ['type:gateway;VitoconnectOpto1'], deviceType: 'vitoconnect' }),
        device('gw2', { roles: ['type:gateway'] }),
        device('RoomControl-1', { roles: ['type:virtual;smartRoomControl'] }),
    ];

    function featureApi(adapter) {
        return mockHttp(adapter, config => ({ data: { data: [feature('a'), feature('b')] }, config }));
    }
    const polledIds = calls => calls.map(c => c.url.match(/devices\/([^/]+)\/features/)[1]);

    it('requests the v2 feature URL per device and stores features under the device', async () => {
        const adapter = discoveredAdapter([installation(111, [device('0')])]);
        const calls = featureApi(adapter);

        await adapter.updateDevices();

        expect(calls[0].method).to.equal('get');
        expect(calls[0].url).to.equal(`${API}/iot/v2/features/installations/111/gateways/GW1/devices/0/features`);
        expect(calls[0].headers.Authorization).to.equal('Bearer token');
        expect(adapter.stored).to.have.length(1);
        expect(adapter.stored[0].path).to.equal('111.0.features');
        expect(adapter.stored[0].data.map(f => f.feature)).to.deep.equal(['a', 'b']);
        expect(adapter.stored[0].rest[0]).to.equal('feature');
    });

    it('skips gateway and virtual devices during polling', async () => {
        const adapter = discoveredAdapter([installation(111, roleDevices())]);
        const calls = featureApi(adapter);
        await adapter.updateDevices();
        expect(polledIds(calls)).to.deep.equal(['0']);
    });

    it('polls virtual devices when allowVirtual is set', async () => {
        const adapter = discoveredAdapter([installation(111, roleDevices())], { allowVirtual: true });
        const calls = featureApi(adapter);
        await adapter.updateDevices();
        expect(polledIds(calls)).to.deep.equal(['0', 'RoomControl-1']);
    });

    it('polls all devices with ignoreFilter (initial fetch)', async () => {
        const adapter = discoveredAdapter([installation(111, roleDevices())]);
        const calls = featureApi(adapter);
        await adapter.updateDevices(true);
        expect(polledIds(calls)).to.deep.equal(['0', 'gateway', 'gw2', 'RoomControl-1']);
    });

    it('applies the device allowlist even with ignoreFilter', async () => {
        const adapter = discoveredAdapter([installation(111, roleDevices())], { devicelist: 'gateway' });
        const calls = featureApi(adapter);
        await adapter.updateDevices(true);
        expect(polledIds(calls)).to.deep.equal(['gateway']);
        await adapter.updateDevices();
        expect(polledIds(calls)).to.deep.equal(['gateway']);
    });

    it('warns about installations without a gateway and continues with the others', async () => {
        const broken = { id: 222, gateways: [] };
        const adapter = discoveredAdapter([broken, installation(111, [device('0')])]);
        const calls = featureApi(adapter);
        await adapter.updateDevices();
        expect(adapter.log.logs.warn.join()).to.include('No gateway found for installation 222');
        expect(calls).to.have.length(1);
    });

    it('loadViaGateway makes one request per gateway and splits features by device uri', async () => {
        const inst = installation(111, [device('0'), device('1'), device('2')]);
        inst.gateways[0].devices.push(device('9', { gatewaySerial: 'GW2' }));
        const adapter = discoveredAdapter([inst], { loadViaGateway: true });
        const calls = mockHttp(adapter, config => {
            const gw = config.url.includes('/gateways/GW2/') ? 'GW2' : 'GW1';
            const items =
                gw === 'GW1'
                    ? [feature('x', '0'), feature('y', '0'), feature('z', '1'), { feature: 'nouri' }, null]
                    : [feature('w', '9'), feature('v', '9')];
            return { data: { data: items } };
        });

        await adapter.updateDevices();

        expect(calls.map(c => c.url)).to.deep.equal([
            `${API}/iot/v2/features/installations/111/gateways/GW1/features?includeDevicesFeatures=true`,
            `${API}/iot/v2/features/installations/111/gateways/GW2/features?includeDevicesFeatures=true`,
        ]);
        const byPath = Object.fromEntries(adapter.stored.map(s => [s.path, s.data]));
        expect(Object.keys(byPath)).to.deep.equal(['111.0.features', '111.1.features', '111.9.features']);
        expect(byPath['111.0.features'].map(f => f.feature)).to.deep.equal(['x', 'y']);
        // exactly one feature is unwrapped to the feature object
        expect(byPath['111.1.features'].feature).to.equal('z');
        expect(byPath['111.9.features'].map(f => f.feature)).to.deep.equal(['w', 'v']);
        expect(adapter.log.logs.debug.join()).to.include('No features for device 2');
    });

    it('loadViaGateway does not match device ids that are prefixes of others', async () => {
        const adapter = discoveredAdapter([installation(111, [device('1'), device('10')])], { loadViaGateway: true });
        mockHttp(adapter, () => ({ data: { data: [feature('a', '10'), feature('b', '10')] } }));
        await adapter.updateDevices();
        expect(adapter.stored.map(s => s.path)).to.deep.equal(['111.10.features']);
    });

    it('loadViaGateway stops after a 429 and tolerates bodies without data arrays', async () => {
        const inst = installation(111, [device('0'), device('9', { gatewaySerial: 'GW2' })]);
        const adapter = discoveredAdapter([inst], { loadViaGateway: true });
        const calls = mockHttp(adapter, () => ({ status: 429, data: {} }));
        await adapter.updateDevices();
        expect(calls).to.have.length(1);

        const other = discoveredAdapter([installation(111, [device('0')])], { loadViaGateway: true });
        mockHttp(other, () => ({ data: { something: 'else' } }));
        await other.updateDevices();
        expect(other.stored).to.deep.equal([]);
    });
});

describe('prepareFeatures', () => {
    it('unwraps a single feature', () => {
        const adapter = createAdapter();
        expect(adapter.prepareFeatures({ data: [feature('only')] }).feature).to.equal('only');
    });

    it('returns non-array bodies as they are', () => {
        const adapter = createAdapter();
        expect(adapter.prepareFeatures({ data: { a: 1 } })).to.deep.equal({ a: 1 });
        expect(adapter.prepareFeatures({ a: 1, b: 2 })).to.deep.equal({ a: 1, b: 2 });
    });

    it('removes logbook features', () => {
        const adapter = createAdapter();
        const result = adapter.prepareFeatures({
            data: [feature('device.messages.logbook'), feature('device.messages.logbook.x'), feature('a'), null],
        });
        expect(result.map(f => f && f.feature)).to.deep.equal(['a', null]);
    });

    it('applies exact and wildcard feature filters', () => {
        const adapter = createAdapter({ featureFilter: 'heating.*, device.name' });
        adapter.sanitizeConfig();
        const result = adapter.prepareFeatures({
            data: [
                'heating',
                'heating.boiler',
                'heatingX',
                'device.name',
                'device.serial',
                'device.messages.logbook',
            ].map(name => feature(name)),
        });
        expect(result.map(f => f.feature)).to.deep.equal(['heating', 'heating.boiler', 'device.name']);
    });

    it('applies the filter and logbook removal to single-feature responses', () => {
        const adapter = createAdapter({ featureFilter: 'heating.*' });
        adapter.sanitizeConfig();
        expect(adapter.prepareFeatures({ data: [feature('device.name')] })).to.deep.equal([]);
        expect(adapter.prepareFeatures({ data: [feature('heating.boiler')] }).feature).to.equal('heating.boiler');
        const plain = createAdapter();
        expect(plain.prepareFeatures({ data: [feature('device.messages.logbook')] })).to.deep.equal([]);
    });

    it('keeps a list when the filter reduces it to one feature', () => {
        const adapter = createAdapter({ featureFilter: 'heating.*' });
        adapter.sanitizeConfig();
        const result = adapter.prepareFeatures({ data: [feature('heating.boiler'), feature('device.name')] });
        expect(result).to.be.an('array').with.length(1);
    });
});

// ---------------------------------------------------------------------------
// logRateLimitEstimate
// ---------------------------------------------------------------------------

describe('logRateLimitEstimate', () => {
    const devices = n => Array.from({ length: n }, (_, i) => device(String(i)));

    it('does not warn within the daily limit', () => {
        const adapter = discoveredAdapter([installation(111, devices(5))]);
        adapter.logRateLimitEstimate();
        expect(adapter.log.logs.warn).to.deep.equal([]);
        expect(adapter.log.logs.info.join()).to.include('Polling 5 devices');
    });

    it('warns above 1450 calls per day', () => {
        const adapter = discoveredAdapter([installation(111, devices(6))]);
        adapter.logRateLimitEstimate();
        expect(adapter.log.logs.warn.join()).to.include('exceed the Viessmann API limits');
    });

    it('warns above 120 calls per 10 minutes', () => {
        const adapter = discoveredAdapter([installation(111, devices(13))], { interval: 1, eventInterval: 44640 });
        adapter.logRateLimitEstimate();
        expect(adapter.log.logs.info.join()).to.include('131 per 10 minutes');
        expect(adapter.log.logs.warn).to.have.length(1);
    });

    it('ignores skipped gateway devices', () => {
        const list = devices(5).concat(device('gw', { roles: ['type:gateway;x'] }));
        const adapter = discoveredAdapter([installation(111, list)]);
        adapter.logRateLimitEstimate();
        expect(adapter.log.logs.warn).to.deep.equal([]);
    });

    it('counts gateways instead of devices with loadViaGateway', () => {
        const adapter = discoveredAdapter([installation(111, devices(10))], { loadViaGateway: true });
        adapter.logRateLimitEstimate();
        expect(adapter.log.logs.warn).to.deep.equal([]);
        expect(adapter.log.logs.info.join()).to.include('293 per day');
    });
});

// ---------------------------------------------------------------------------
// getDeviceIds
// ---------------------------------------------------------------------------

describe('getDeviceIds', () => {
    function discoveryAdapter(installations, config = {}) {
        const adapter = createAdapter(config);
        adapter.sanitizeConfig();
        adapter.session = { access_token: 'at' };
        const calls = mockHttp(adapter, () => ({ data: { data: installations } }));
        return { adapter, calls };
    }

    it('creates installation, device and general objects', async () => {
        const { adapter, calls } = discoveryAdapter([installation(111, [device('0')])]);

        expect(await adapter.getDeviceIds()).to.equal(true);

        expect(calls[0].url).to.equal(`${API}/iot/v2/equipment/installations`);
        expect(adapter.objects.get('111')).to.deep.include({ type: 'device' });
        expect(adapter.objects.get('111').common.name).to.equal('Home 111');
        expect(adapter.objects.get('111.0')).to.deep.include({ type: 'device' });
        expect(adapter.objects.get('111.0').common.name).to.equal('model-0');
        expect(adapter.objects.get('111.0.general')).to.deep.include({ type: 'channel' });
        expect(adapter.states.get('111.0.general.modelId')).to.deep.equal({ val: 'model-0', ack: true });
        expect(adapter.states.get('111.description')).to.deep.equal({ val: 'Home 111', ack: true });
        expect(adapter.gatewayIndexObject).to.deep.equal({ 111: 1 });
    });

    it('returns true for an account without installations', async () => {
        const { adapter } = discoveryAdapter([]);
        expect(await adapter.getDeviceIds()).to.equal(true);
        expect(adapter.log.logs.info.join()).to.include('No installation found');
    });

    it('returns false on request errors', async () => {
        const adapter = createAdapter();
        adapter.session = { access_token: 'at' };
        mockHttp(adapter, config => {
            throw networkError(config);
        });
        expect(await adapter.getDeviceIds()).to.equal(false);
        expect(adapter.log.logs.error.join()).to.include('Installations request failed');
    });

    it('filters out offline gateways', async () => {
        const inst = {
            id: 111,
            gateways: [
                { serial: 'OFF', aggregatedStatus: 'Offline', devices: [device('off')] },
                { serial: 'ON', aggregatedStatus: 'WorksProperly', devices: [device('on')] },
            ],
        };
        const { adapter } = discoveryAdapter([inst]);
        await adapter.getDeviceIds();
        expect(adapter.getSelectedGateway(inst).serial).to.equal('ON');
        expect(adapter.objects.has('111.on')).to.equal(true);
        expect(adapter.objects.has('111.off')).to.equal(false);
    });

    it('falls back to all gateways when all are offline', async () => {
        const inst = installation(111, [device('0')], { aggregatedStatus: 'Offline' });
        const { adapter } = discoveryAdapter([inst]);
        await adapter.getDeviceIds();
        expect(adapter.log.logs.warn.join()).to.include('are offline');
        expect(adapter.getSelectedGateway(inst).serial).to.equal('GW1');
    });

    it('falls back to gateway index 1 for an invalid index', async () => {
        const inst = installation(111, [device('0')]);
        const { adapter } = discoveryAdapter([inst], { gatewayIndex: 3 });
        await adapter.getDeviceIds();
        expect(adapter.log.logs.warn.join()).to.include('Gateway Index 3');
        expect(adapter.gatewayIndexObject['111']).to.equal(1);
        expect(adapter.objects.has('111.0')).to.equal(true);
    });

    it('selects the configured gateway index', async () => {
        const inst = installation(111, [device('0')]);
        inst.gateways.push({ serial: 'GW2', devices: [device('5', { gatewaySerial: 'GW2' })] });
        const { adapter } = discoveryAdapter([inst], { gatewayIndex: 2 });
        await adapter.getDeviceIds();
        expect(adapter.getSelectedGateway(inst).serial).to.equal('GW2');
        expect(adapter.objects.has('111.5')).to.equal(true);
        expect(adapter.objects.has('111.0')).to.equal(false);
    });

    it('does not throw when the gateways array is missing and continues with other installations', async () => {
        const { adapter } = discoveryAdapter([{ id: 222, description: 'empty' }, installation(111, [device('0')])]);
        expect(await adapter.getDeviceIds()).to.equal(true);
        expect(adapter.log.logs.warn.join()).to.include('No gateway found for installation 222');
        expect(adapter.objects.has('111.0')).to.equal(true);
    });
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('commands (onStateChange)', () => {
    const PARENT = '111.0.features.heating.curve.commands.setCurve';
    const ID = `${NS}.${PARENT}.setValue`;
    const URI = `${API}/iot/v2/features/installations/111/gateways/GW1/devices/0/features/heating.curve/commands/setCurve`;

    function commandAdapter(common, reply = { data: { data: { success: true } } }) {
        const adapter = createAdapter();
        adapter.session = { access_token: 'token' };
        adapter.states.set(`${PARENT}.uri`, { val: URI, ack: true });
        if (common) {
            adapter.objects.set(`${PARENT}.setValue`, { type: 'state', common });
        }
        const calls = mockHttp(adapter, typeof reply === 'function' ? reply : () => reply);
        return { adapter, calls };
    }
    const sent = calls => JSON.parse(calls[0].data);
    const numberCommon = (extra = {}) => ({
        type: 'number',
        role: 'level',
        param: 'slope',
        min: 0.2,
        max: 3.5,
        ...extra,
    });
    const multiCommon = () => ({
        type: 'string',
        role: 'json',
        param: [
            { param: 'slope', type: 'number', min: 0.2, max: 3.5 },
            { param: 'shift', type: 'number', min: -13, max: 40 },
            { param: 'mode', type: 'mixed', states: { eco: 'eco', comfort: 'comfort' }, required: false },
        ],
    });

    async function expectRejected(common, val, reason) {
        const { adapter, calls } = commandAdapter(common);
        await adapter.onStateChange(ID, { val, ack: false });
        expect(calls).to.have.length(0);
        expect(adapter.log.logs.warn.join()).to.include('Command rejected');
        if (reason) {
            expect(adapter.log.logs.warn.join()).to.include(reason);
        }
    }
    async function expectSent(common, val, data) {
        const { adapter, calls } = commandAdapter(common);
        await adapter.onStateChange(ID, { val, ack: false });
        expect(adapter.log.logs.warn).to.deep.equal([]);
        expect(calls).to.have.length(1);
        expect(sent(calls)).to.deep.equal(data);
        return adapter;
    }

    it('ignores acknowledged and null states', async () => {
        const { adapter, calls } = commandAdapter(numberCommon());
        await adapter.onStateChange(ID, { val: 1, ack: true });
        await adapter.onStateChange(ID, null);
        await adapter.onStateChange(ID, undefined);
        expect(calls).to.have.length(0);
        expect(adapter.timers).to.have.length(0);
    });

    it('ignores non-setValue ids', async () => {
        const { adapter, calls } = commandAdapter(numberCommon());
        await adapter.onStateChange(`${NS}.${PARENT}.uri`, { val: 'x', ack: false });
        expect(calls).to.have.length(0);
        expect(adapter.log.logs.info.join()).to.include('please use setValue');
    });

    it('does not send without a uri state', async () => {
        const { adapter, calls } = commandAdapter(numberCommon());
        adapter.states.delete(`${PARENT}.uri`);
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(calls).to.have.length(0);
        expect(adapter.log.logs.info.join()).to.include('No URI found');
        expect(adapter.timers).to.have.length(0);
    });

    it('does not send when not logged in', async () => {
        const { adapter, calls } = commandAdapter(numberCommon());
        adapter.session = {};
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(calls).to.have.length(0);
        expect(adapter.log.logs.warn.join()).to.include('not logged in');
    });

    it('POSTs a valid single number parameter, acks the state and schedules a refresh', async () => {
        const { adapter, calls } = commandAdapter(numberCommon());
        let updates = 0;
        adapter.updateDevices = async () => {
            updates++;
        };

        await adapter.onStateChange(ID, { val: 1.4, ack: false });

        expect(calls).to.have.length(1);
        expect(calls[0].method).to.equal('post');
        expect(calls[0].url).to.equal(URI);
        expect(String(calls[0].headers['Content-Type'])).to.include('application/json');
        expect(calls[0].headers.Authorization).to.equal('Bearer token');
        expect(sent(calls)).to.deep.equal({ slope: 1.4 });
        expect(adapter.states.get(ID)).to.deep.equal({ val: 1.4, ack: true });

        const timers = activeTimeouts(adapter);
        expect(timers).to.have.length(1);
        expect(timers[0].ms).to.equal(10 * 1000);
        await fire(timers[0]);
        expect(updates).to.equal(1);
        expect(adapter.refreshTimeout).to.equal(null);
    });

    it('replaces the pending refresh timer on consecutive commands', async () => {
        const { adapter } = commandAdapter(numberCommon());
        await adapter.onStateChange(ID, { val: 1, ack: false });
        const first = adapter.refreshTimeout;
        await adapter.onStateChange(ID, { val: 2, ack: false });
        expect(first.cleared).to.equal(true);
        expect(activeTimeouts(adapter)).to.have.length(1);
    });

    it('coerces numeric strings for number parameters', async () => {
        await expectSent(numberCommon(), '1.4', { slope: 1.4 });
    });

    it('rejects values outside min/max', async () => {
        await expectRejected(numberCommon(), 0.1, 'below minimum 0.2');
        await expectRejected(numberCommon(), 4, 'exceeds maximum 3.5');
        await expectRejected(numberCommon(), 'abc', 'expected a number');
    });

    it('honours a minimum of 0', async () => {
        await expectRejected(numberCommon({ min: 0 }), -1, 'below minimum 0');
        await expectSent(numberCommon({ min: 0 }), 0, { slope: 0 });
    });

    it('coerces "true"/"false" for boolean parameters', async () => {
        const common = { type: 'boolean', role: 'switch', param: 'active' };
        await expectSent(common, 'true', { active: true });
        await expectSent(common, 'false', { active: false });
        await expectSent(common, true, { active: true });
        await expectRejected(common, 'yes', 'expected a boolean');
        await expectRejected(common, 1, 'expected a boolean');
    });

    it('validates enum states', async () => {
        const common = { type: 'mixed', role: 'state', param: 'mode', states: { eco: 'eco', comfort: 'comfort' } };
        await expectSent(common, 'eco', { mode: 'eco' });
        await expectRejected(common, 'turbo', 'Valid values: eco, comfort');
    });

    it('sends an empty body for commands without parameters', async () => {
        await expectSent({ type: 'mixed', role: 'state', param: '' }, true, {});
        await expectSent(undefined, true, {});
    });

    it('accepts multi-parameter JSON and skips omitted optional parameters', async () => {
        await expectSent(multiCommon(), '{"slope":1.4,"shift":"3"}', { slope: 1.4, shift: 3 });
        await expectSent(multiCommon(), '{"slope":1.4,"shift":3,"mode":"eco"}', { slope: 1.4, shift: 3, mode: 'eco' });
    });

    it('accepts an object value for multi-parameter commands', async () => {
        await expectSent(multiCommon(), { slope: 1, shift: 0 }, { slope: 1, shift: 0 });
    });

    it('rejects invalid multi-parameter payloads', async () => {
        await expectRejected(multiCommon(), '{"slope":1.4}', 'Missing required parameter "shift"');
        await expectRejected(multiCommon(), '{nope', 'Expected format');
        await expectRejected(multiCommon(), '[1,2]', 'must be a JSON object');
        await expectRejected(multiCommon(), '{"slope":9,"shift":0}', 'Parameter "slope"');
        await expectRejected(multiCommon(), '{"slope":1,"shift":0,"mode":"turbo"}', 'Parameter "mode"');
    });

    it('works with the setValue object created by extractKeys (incl. required:false)', async () => {
        const { adapter, calls } = commandAdapter(null);
        await extractKeys(adapter, PARENT, {
            uri: URI,
            isExecutable: true,
            params: {
                slope: { type: 'number', required: true, constraints: { min: 0.2, max: 3.5, stepping: 0.1 } },
                shift: { type: 'number', required: false, constraints: { min: -13, max: 40 } },
            },
        });

        await adapter.onStateChange(ID, { val: '{"slope":0.5}', ack: false });

        expect(adapter.log.logs.warn).to.deep.equal([]);
        expect(sent(calls)).to.deep.equal({ slope: 0.5 });
    });

    it('logs a hint for 404 commands', async () => {
        const { adapter } = commandAdapter(numberCommon(), {
            status: 404,
            data: { extendedPayload: { code: 404 }, message: 'not found' },
        });
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(adapter.log.logs.error.join()).to.include('Command does not exist');
        expect(adapter.states.has(ID)).to.equal(false);
    });

    it('schedules a token refresh on 401', async () => {
        const { adapter, calls } = commandAdapter(numberCommon(), { status: 401, data: {} });
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(calls).to.have.length(1);
        expect(adapter.refreshTokenTimeout.ms).to.equal(30000);
        expect(adapter.states.has(ID)).to.equal(false);
        expect(adapter.log.logs.error.join()).to.include('URL path: /iot/v2/features');
    });

    it('sets the rate limit on 429', async () => {
        const reset = Date.now() + 120000;
        const { adapter, calls } = commandAdapter(numberCommon(), {
            status: 429,
            data: { extendedPayload: { limitReset: reset } },
        });
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(calls).to.have.length(1);
        expect(adapter.rateLimitedUntil).to.equal(reset);
    });

    it('sends commands through requestClient.request (retry logic is covered in lib/apiClient)', async () => {
        // the 5s production retry delay is not injectable here, so only the non-retried path is exercised
        const { adapter } = commandAdapter(numberCommon());
        const statuses = [200];
        let attempts = 0;
        adapter.requestClient.request = async () => {
            attempts++;
            const status = statuses.shift();
            return { status, data: {} };
        };
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(attempts).to.equal(1);
        expect(adapter.states.get(ID)).to.deep.equal({ val: 1, ack: true });
    });

    it('stays silent on canceled requests', async () => {
        const { adapter } = commandAdapter(numberCommon(), () => {
            throw new AxiosError('canceled', 'ERR_CANCELED');
        });
        await adapter.onStateChange(ID, { val: 1, ack: false });
        expect(adapter.log.logs.error).to.deep.equal([]);
        expect(adapter.timers).to.have.length(0);
    });
});

// ---------------------------------------------------------------------------
// onUnload / logging
// ---------------------------------------------------------------------------

describe('onUnload', () => {
    it('aborts requests, clears all timers and calls the callback', () => {
        const adapter = createAdapter();
        adapter.startPolling();
        adapter.scheduleTokenRefresh(30000);
        adapter.refreshTimeout = adapter.setTimeout(() => {}, 10000);
        const timers = adapter.timers.slice();
        let called = 0;

        adapter.onUnload(() => called++);

        expect(called).to.equal(1);
        expect(adapter.unloaded).to.equal(true);
        expect(adapter.abortController.signal.aborted).to.equal(true);
        expect(timers.every(t => t.cleared)).to.equal(true);
        expect(adapter.refreshTimeout).to.equal(null);
        expect(adapter.refreshTokenTimeout).to.equal(null);
        expect(adapter.updateInterval).to.equal(null);
        expect(adapter.states.get('info.connection')).to.deep.equal({ val: false, ack: true });
    });

    it('also clears a pending relogin', () => {
        const adapter = createAdapter();
        adapter.scheduleRelogin();
        const relogin = adapter.reLoginTimeout;
        adapter.onUnload(() => {});
        expect(relogin.cleared).to.equal(true);
    });

    it('calls the callback even if cleanup throws', () => {
        const adapter = createAdapter();
        adapter.setState = () => {
            throw new Error('db gone');
        };
        let called = 0;
        adapter.onUnload(() => called++);
        expect(called).to.equal(1);
        expect(adapter.log.logs.error.join()).to.include('db gone');
    });

    it('does not call a throwing callback twice', () => {
        const adapter = createAdapter();
        let called = 0;
        expect(() =>
            adapter.onUnload(() => {
                called++;
                throw new Error('callback failed');
            }),
        ).to.throw('callback failed');
        expect(called).to.equal(1);
    });
});

describe('logAxiosError redaction', () => {
    it('redacts bearer authorization headers and token-bearing URLs', () => {
        const adapter = createAdapter();
        adapter.logAxiosError('Token URL request failed', {
            message:
                'Request failed for https://api.example.com/iot/path?access_token=secret-token&client_id=client-secret',
            config: {
                method: 'get',
                url: 'https://api.example.com/iot/path?access_token=secret-token&client_id=client-secret',
                headers: { Authorization: 'Bearer secret-bearer-token' },
                params: { refresh_token: 'secret-refresh-token', client_id: 'secret-client-id' },
            },
            response: {
                status: 401,
                data: {
                    access_token: 'secret-response-token',
                    url: 'https://api.example.com/callback?code=secret-response-code',
                },
            },
        });

        const output = adapter.log.logs.error.join('\n');
        expect(output).to.include('Token URL request failed');
        expect(output).to.include('/iot/path');
        expect(output).to.include('[redacted]');
        for (const secret of [
            'secret-token',
            'secret-bearer-token',
            'secret-refresh-token',
            'secret-client-id',
            'client-secret',
            'secret-response-token',
            'secret-response-code',
            '?access_token=',
            '?code=',
        ]) {
            expect(output).not.to.include(secret);
        }
    });

    it('redacts Basic authorization headers and form-encoded token data', () => {
        const adapter = createAdapter();
        adapter.logAxiosError('Basic auth request failed', {
            message: 'Basic dXNlcjpzZWNyZXQ= failed',
            config: {
                method: 'post',
                url: 'https://iam.example.com/idp/v3/token?client_id=query-client-secret',
                headers: { authorization: 'Basic dXNlcjpzZWNyZXQ=' },
                data: 'grant_type=refresh_token&client_id=form-client-secret&refresh_token=form-refresh-secret&code=form-code-secret&password=form-password-secret',
            },
            response: {
                status: 400,
                data: { error: 'invalid_request', nested: { password: 'response-password-secret' } },
            },
        });

        const output = adapter.log.logs.error.join('\n');
        expect(output).to.include('Basic auth request failed');
        for (const secret of [
            'dXNlcjpzZWNyZXQ=',
            'query-client-secret',
            'form-client-secret',
            'form-refresh-secret',
            'form-code-secret',
            'form-password-secret',
            'response-password-secret',
            '?client_id=',
        ]) {
            expect(output).not.to.include(secret);
        }
    });

    it('does not throw for missing or non-axios errors', () => {
        const adapter = createAdapter();
        adapter.logAxiosError('x', undefined);
        adapter.logAxiosError('y', new Error('plain'));
        expect(adapter.log.logs.error).to.have.length(2);
    });

    it('logDebugLazy only builds messages at debug level', () => {
        const adapter = createAdapter();
        let built = 0;
        const build = () => {
            built++;
            return 'msg';
        };
        adapter.logDebugLazy(build);
        expect(built).to.equal(0);
        adapter.log.level = 'debug';
        adapter.logDebugLazy(build);
        expect(built).to.equal(1);
        expect(adapter.log.logs.debug).to.deep.equal(['msg']);
    });

    it('setConnected only writes info.connection on changes', async () => {
        const adapter = createAdapter();
        await adapter.setConnected(true);
        await adapter.setConnected(true);
        await adapter.setConnected(false);
        expect(adapter.stateWrites.map(w => w.val)).to.deep.equal([true, false]);
    });
});

// ---------------------------------------------------------------------------
// lib/apiClient
// ---------------------------------------------------------------------------

describe('lib/apiClient', () => {
    function client(replies) {
        const configs = [];
        return {
            configs,
            async request(config) {
                configs.push(config);
                const reply = replies[configs.length - 1];
                if (reply instanceof Error) {
                    throw reply;
                }
                return reply;
            },
        };
    }
    const httpError = status => Object.assign(new Error(`status ${status}`), { response: { status } });

    it('createApiClient sets the timeout and abort signal', () => {
        const controller = new AbortController();
        const instance = apiClient.createApiClient(controller.signal);
        expect(instance.defaults.timeout).to.equal(30000);
        expect(instance.defaults.signal).to.equal(controller.signal);
    });

    it('retries 5xx responses with the configured delay until success', async () => {
        const c = client([httpError(500), httpError(503), { data: 'ok' }]);
        const waits = [];
        const retries = [];
        const res = await apiClient.requestWithRetry(
            c,
            { url: 'x' },
            {
                retries: 5,
                delayMs: 5000,
                wait: async ms => waits.push(ms),
                onRetry: (attempt, error) => retries.push([attempt, error.response.status]),
            },
        );
        expect(res).to.deep.equal({ data: 'ok' });
        expect(c.configs).to.have.length(3);
        expect(waits).to.deep.equal([5000, 5000]);
        expect(retries).to.deep.equal([
            [1, 500],
            [2, 503],
        ]);
    });

    it('gives up after the configured retries', async () => {
        const c = client(Array.from({ length: 10 }, () => httpError(502)));
        const waits = [];
        let error;
        try {
            await apiClient.requestWithRetry(c, {}, { retries: 5, delayMs: 1, wait: async ms => waits.push(ms) });
        } catch (e) {
            error = e;
        }
        expect(error.response.status).to.equal(502);
        expect(c.configs).to.have.length(6);
        expect(waits).to.have.length(5);
    });

    it('does not retry 4xx or network errors', async () => {
        for (const failure of [httpError(400), httpError(429), new Error('ECONNRESET')]) {
            const c = client([failure, { data: 'never' }]);
            let error;
            try {
                await apiClient.requestWithRetry(c, {}, { retries: 5, delayMs: 1, wait: async () => {} });
            } catch (e) {
                error = e;
            }
            expect(error).to.equal(failure);
            expect(c.configs).to.have.length(1);
        }
    });
});

// ---------------------------------------------------------------------------
// lib/filters
// ---------------------------------------------------------------------------

describe('lib/filters', () => {
    it('parseList splits, trims and drops empty entries', () => {
        expect(parseList(' a, b ,,c d ')).to.deep.equal(['a', 'b', 'cd']);
        expect(parseList('')).to.deep.equal([]);
        expect(parseList(undefined)).to.deep.equal([]);
        expect(parseList(42)).to.deep.equal([]);
    });

    it('returns null without patterns', () => {
        expect(compileFeatureFilter('')).to.equal(null);
        expect(compileFeatureFilter(' , ')).to.equal(null);
        expect(compileFeatureFilter(undefined)).to.equal(null);
    });

    it('matches exact feature names', () => {
        const filter = compileFeatureFilter('heating.boiler.sensors.temperature.main');
        expect(filter('heating.boiler.sensors.temperature.main')).to.equal(true);
        expect(filter('heating.boiler.sensors.temperature.main.x')).to.equal(false);
        expect(filter('heating.boiler')).to.equal(false);
    });

    it('matches "heating.*" as the base feature and its children', () => {
        const filter = compileFeatureFilter('heating.*');
        expect(filter('heating')).to.equal(true);
        expect(filter('heating.boiler')).to.equal(true);
        expect(filter('heating.boiler.sensors')).to.equal(true);
        expect(filter('heatingX')).to.equal(false);
        expect(filter('device')).to.equal(false);
    });

    it('treats "heating*" like "heating.*"', () => {
        const filter = compileFeatureFilter('heating*');
        expect(filter('heating')).to.equal(true);
        expect(filter('heating.circuits.0')).to.equal(true);
        expect(filter('heatingX')).to.equal(false);
    });

    it('returns null for a bare "*" (match everything)', () => {
        expect(compileFeatureFilter('*')).to.equal(null);
        expect(compileFeatureFilter('heating.boiler, *')).to.equal(null);
    });

    it('combines exact and prefix patterns', () => {
        const filter = compileFeatureFilter('device.name, heating.dhw.*');
        expect(filter('device.name')).to.equal(true);
        expect(filter('heating.dhw.temperature')).to.equal(true);
        expect(filter('heating.circuits')).to.equal(false);
    });
});

// ---------------------------------------------------------------------------
// lib/safeLog
// ---------------------------------------------------------------------------

describe('lib/safeLog', () => {
    it('sanitizeUrlForLog strips query strings', () => {
        expect(safeLog.sanitizeUrlForLog('https://a.example/p/q?code=1')).to.equal('https://a.example/p/q');
        expect(safeLog.sanitizeUrlForLog('https://a.example/p/q?code=1', true)).to.equal('/p/q');
        expect(safeLog.sanitizeUrlForLog('http://localhost:4200/?code=abc', true)).to.equal('/');
        expect(safeLog.sanitizeUrlForLog('/relative?code=1')).to.equal('/relative');
        expect(safeLog.sanitizeUrlForLog(undefined)).to.equal(undefined);
    });

    it('sanitizeStringForLog redacts tokens, credentials and query strings', () => {
        const out = safeLog.sanitizeStringForLog(
            'Bearer abc.def Basic dXNl access_token=AT&refresh_token=RT password=PW code=CD https://x.example/a?client_id=CI',
        );
        for (const secret of ['abc.def', 'dXNl', 'AT', 'RT', 'PW', 'CD', 'CI']) {
            expect(out).to.not.match(new RegExp(`\\b${secret.replace('.', '\\.')}\\b`));
        }
        expect(out).to.include('Bearer [redacted]');
        expect(out).to.include('https://x.example/a');
    });

    it('sanitizeForLog redacts sensitive keys recursively (case-insensitive)', () => {
        const out = safeLog.sanitizeForLog({
            Authorization: 'Bearer x',
            nested: { Access_Token: 'a', list: [{ password: 'p' }, 'Bearer y'] },
            url: 'https://h.example/path?code=c',
            status: 401,
            empty: null,
        });
        expect(out).to.deep.equal({
            Authorization: '[redacted]',
            nested: { Access_Token: '[redacted]', list: [{ password: '[redacted]' }, 'Bearer [redacted]'] },
            url: '/path',
            status: 401,
            empty: null,
        });
    });

    it('stringifyForLog handles strings, objects and circular structures', () => {
        expect(safeLog.stringifyForLog('code=abc')).to.equal('code=[redacted]');
        expect(safeLog.stringifyForLog({ refresh_token: 'x', a: 1 })).to.equal('{"refresh_token":"[redacted]","a":1}');
        expect(safeLog.stringifyForLog(undefined)).to.equal(undefined);
        const circular = {};
        circular.self = circular;
        expect(safeLog.stringifyForLog(circular)).to.equal('[redacted]');
    });
});

// ---------------------------------------------------------------------------
// lib/extractKeys
// ---------------------------------------------------------------------------

describe('lib/extractKeys', () => {
    let counter = 0;
    const root = name => `test.${name}${++counter}`;
    const createMock = () => new MockAdapter({});

    it('extracts nested objects', async () => {
        const adapter = createMock();
        const r = root('nested');
        await extractKeys(adapter, r, { outer: { inner: { temperature: 21, enabled: true } } });

        expect(adapter.objects.get(r)).to.include({ type: 'channel' });
        expect(adapter.objects.get(`${r}.outer.inner.temperature`).common).to.include({
            type: 'number',
            role: 'value',
        });
        expect(adapter.objects.get(`${r}.outer.inner.enabled`).common).to.include({
            type: 'boolean',
            role: 'indicator',
        });
        expect(adapter.states.get(`${r}.outer.inner.temperature`)).to.deep.equal({ val: 21, ack: true });
        expect(adapter.states.get(`${r}.outer.inner.enabled`)).to.deep.equal({ val: true, ack: true });
    });

    it('uses roles for writable states', async () => {
        const adapter = createMock();
        const r = root('write');
        await extractKeys(adapter, r, { n: 1, b: false, s: 'x' }, null, false, true);
        expect(adapter.objects.get(`${r}.n`).common).to.include({ role: 'level', write: true });
        expect(adapter.objects.get(`${r}.b`).common).to.include({ role: 'switch' });
        expect(adapter.objects.get(`${r}.s`).common).to.include({ role: 'text' });
    });

    it('extracts arrays using id/name keys', async () => {
        const adapter = createMock();
        const r = root('arrays');
        await extractKeys(adapter, r, {
            items: [
                { id: 'item.1', value: 7, details: { label: 'first' } },
                { name: 'Named.Item', active: false },
            ],
        });
        expect(adapter.states.get(`${r}.item1.value`)).to.deep.equal({ val: 7, ack: true });
        expect(adapter.states.get(`${r}.item1.details.label`)).to.deep.equal({ val: 'first', ack: true });
        expect(adapter.states.get(`${r}.items.Named.Item`)).to.deep.equal({ val: false, ack: true });
    });

    it('uses the preferred array name (feature) for feature lists', async () => {
        const adapter = createMock();
        const r = root('features');
        await extractKeys(adapter, r, [feature('heating.boiler'), feature('device.name')], 'feature');
        expect(adapter.states.get(`${r}.heating.boiler.isEnabled`)).to.deep.equal({ val: true, ack: true });
        expect(adapter.states.get(`${r}.device.name.properties.value.value`)).to.deep.equal({ val: 1, ack: true });
    });

    it('parses JSON-string values and extracts nested content', async () => {
        const adapter = createMock();
        const r = root('json');
        await extractKeys(adapter, r, {
            payload: JSON.stringify({ nested: { value: 42 }, list: [{ name: 'alpha', value: 1 }] }),
        });
        expect(adapter.states.get(`${r}.payload.nested.value`)).to.deep.equal({ val: 42, ack: true });
        expect(adapter.states.get(`${r}.payload.list.alpha`)).to.deep.equal({ val: 1, ack: true });
    });

    it('keeps numeric and boolean strings as strings', async () => {
        const adapter = createMock();
        const r = root('numericString');
        await extractKeys(adapter, r, { serial: '123456', flag: 'true', broken: '{nojson' });
        expect(adapter.objects.get(`${r}.serial`).common.type).to.equal('string');
        expect(adapter.states.get(`${r}.serial`)).to.deep.equal({ val: '123456', ack: true });
        expect(adapter.states.get(`${r}.flag`)).to.deep.equal({ val: 'true', ack: true });
        expect(adapter.states.get(`${r}.broken`)).to.deep.equal({ val: '{nojson', ack: true });
    });

    it('extracts event arrays with forced index paths', async () => {
        const adapter = createMock();
        const r = root('events');
        await extractKeys(
            adapter,
            r,
            [
                { start_date_time: '2026-05-15T12:00:00Z', eventType: 'gateway.online', body: { severity: 'info' } },
                { start_date_time: '2026-05-15T12:05:00Z', eventType: 'gateway.offline' },
            ],
            null,
            true,
        );
        expect(adapter.states.get(`${r}.01.eventType`)).to.deep.equal({ val: 'gateway.online', ack: true });
        expect(adapter.states.get(`${r}.01.body.severity`)).to.deep.equal({ val: 'info', ack: true });
        expect(adapter.states.get(`${r}.02.eventType`)).to.deep.equal({ val: 'gateway.offline', ack: true });
    });

    it('keeps the created-object cache per adapter instance', async () => {
        const first = createMock();
        const second = createMock();
        const r = root('cache');
        await extractKeys(first, r, { temperature: 21 });
        await extractKeys(second, r, { temperature: 21 });
        expect(first.objects.has(`${r}.temperature`)).to.equal(true);
        expect(second.objects.has(`${r}.temperature`)).to.equal(true);
    });

    it('creates objects only once per adapter run but always updates states', async () => {
        const adapter = createMock();
        const r = root('once');
        let creates = 0;
        const original = adapter.setObjectNotExistsAsync.bind(adapter);
        adapter.setObjectNotExistsAsync = async (id, obj) => {
            creates++;
            return original(id, obj);
        };
        await extractKeys(adapter, r, { t: 1 });
        const afterFirst = creates;
        await extractKeys(adapter, r, { t: 2 });
        expect(creates).to.equal(afterFirst);
        expect(adapter.states.get(`${r}.t`).val).to.equal(2);
    });

    it('creates states for top-level primitive arrays without empty path segments', async () => {
        const adapter = createMock();
        const r = root('primitives');
        await extractKeys(adapter, r, ['alpha', 'beta']);
        expect(adapter.states.get(`${r}.alpha`)).to.deep.equal({ val: 'alpha', ack: true });
        expect(adapter.states.get(`${r}.beta`)).to.deep.equal({ val: 'beta', ack: true });
        expect(Array.from(adapter.objects.keys()).filter(id => id.includes('..'))).to.deep.equal([]);
    });

    it('names a top-level primitive after the last path segment', async () => {
        const adapter = createMock();
        const r = root('primitive');
        await extractKeys(adapter, `${r}.some.leaf`, 42);
        expect(adapter.objects.get(`${r}.some.leaf`).common).to.include({ name: 'leaf', type: 'number' });
        expect(adapter.states.get(`${r}.some.leaf`)).to.deep.equal({ val: 42, ack: true });
    });

    it('ignores null and undefined elements', async () => {
        const adapter = createMock();
        await extractKeys(adapter, 'x', null);
        await extractKeys(adapter, 'x', undefined);
        expect(adapter.objects.size).to.equal(0);
    });

    it('maps values of keys containing dots correctly', async () => {
        const adapter = createMock();
        const r = root('dots');
        await extractKeys(adapter, r, { 'a.b': 5, 'c.d.e': 'text', 'f.g': false });
        expect(adapter.states.get(`${r}.a_b`)).to.deep.equal({ val: 5, ack: true });
        expect(adapter.states.get(`${r}.c_d_e`)).to.deep.equal({ val: 'text', ack: true });
        expect(adapter.states.get(`${r}.f_g`)).to.deep.equal({ val: false, ack: true });
        expect(adapter.objects.get(`${r}.a_b`).common.type).to.equal('number');
        expect(adapter.stateWrites.filter(w => w.val === undefined)).to.deep.equal([]);
    });

    it('sanitizes forbidden characters with the default pattern', async () => {
        const adapter = createMock();
        const r = root('forbidden');
        await extractKeys(adapter, `${r}.we*ird`, { 'k;e?y': 1, 'x[1]': 2 });
        expect(adapter.states.get(`${r}.we_ird.k_e_y`)).to.deep.equal({ val: 1, ack: true });
        expect(adapter.states.get(`${r}.we_ird.x_1_`)).to.deep.equal({ val: 2, ack: true });
        const ids = Array.from(adapter.objects.keys());
        expect(ids.filter(id => /[*;?[\]]/.test(id))).to.deep.equal([]);
    });

    it('uses adapter.FORBIDDEN_CHARS when available', async () => {
        const adapter = createMock();
        adapter.FORBIDDEN_CHARS = /[^a-z0-9._]/g;
        await extractKeys(adapter, 'root', { 'Key-1': 1 });
        expect(adapter.states.get('root._ey_1')).to.deep.equal({ val: 1, ack: true });
    });

    it('stores .entries.value as JSON string state via extendObjectAsync', async () => {
        const adapter = createMock();
        const r = root('entries');
        const schedule = { mon: [{ start: '06:00', end: '22:00', mode: 'normal' }] };
        // an object of a previous version with the invalid type "json"
        adapter.objects.set(`${r}.properties.entries.value`, {
            type: 'state',
            common: { name: 'value', type: 'json', role: 'state' },
        });

        await extractKeys(adapter, r, { properties: { entries: { type: 'Schedule', value: schedule } } });

        const id = `${r}.properties.entries.value`;
        expect(adapter.states.get(id)).to.deep.equal({ val: JSON.stringify(schedule), ack: true });
        expect(adapter.objects.get(id).common).to.include({ type: 'string', role: 'json' });
        expect(adapter.extendCalls.map(c => c.id)).to.deep.equal([id]);
        expect(adapter.objects.has(`${id}.mon`)).to.equal(false);
        expect(adapter.states.get(`${r}.properties.entries.type`)).to.deep.equal({ val: 'Schedule', ack: true });

        await extractKeys(adapter, r, { properties: { entries: { type: 'Schedule', value: {} } } });
        expect(adapter.extendCalls).to.have.length(1);
        expect(adapter.states.get(id).val).to.equal('{}');
    });

    describe('setValue objects', () => {
        async function setValueCommon(params) {
            const adapter = createMock();
            const r = root('cmd');
            await extractKeys(adapter, r, { uri: 'https://x', isExecutable: true, params });
            const call = adapter.extendCalls.find(c => c.id === `${r}.setValue`);
            expect(call, 'setValue created via extendObjectAsync').to.exist;
            expect(adapter.states.get(`${r}.isExecutable`)).to.deep.equal({ val: true, ack: true });
            return call.obj.common;
        }

        it('creates a number command with min 0, max and step from stepping', async () => {
            const common = await setValueCommon({
                temperature: { type: 'number', required: true, constraints: { min: 0, max: 60, stepping: 0.5 } },
            });
            expect(common).to.include({
                type: 'number',
                role: 'level',
                param: 'temperature',
                min: 0,
                max: 60,
                step: 0.5,
                write: true,
                read: true,
            });
        });

        it('ignores non-positive stepping', async () => {
            const common = await setValueCommon({ t: { type: 'number', constraints: { stepping: 0 } } });
            expect(common).to.not.have.property('step');
        });

        it('creates a boolean command as switch', async () => {
            const common = await setValueCommon({ active: { type: 'boolean' } });
            expect(common).to.include({ type: 'boolean', role: 'switch', param: 'active' });
        });

        it('creates an enum command with states', async () => {
            const common = await setValueCommon({
                mode: { type: 'string', constraints: { enum: ['eco', 'comfort'] } },
            });
            expect(common).to.include({ type: 'mixed', param: 'mode' });
            expect(common.states).to.deep.equal({ eco: 'eco', comfort: 'comfort' });
        });

        it('creates a multi-parameter command as JSON string and carries required:false', async () => {
            const common = await setValueCommon({
                slope: { type: 'number', required: true, constraints: { min: 0.2, max: 3.5, stepping: 0.1 } },
                shift: { type: 'number', required: false, constraints: { min: -13, max: 40 } },
                mode: { type: 'string', constraints: { enum: ['eco', 'comfort'] } },
            });
            expect(common).to.include({ type: 'string', role: 'json' });
            expect(common.param).to.deep.equal([
                { param: 'slope', type: 'number', min: 0.2, max: 3.5, step: 0.1 },
                { param: 'shift', type: 'number', required: false, min: -13, max: 40 },
                { param: 'mode', type: 'mixed', states: { eco: 'eco', comfort: 'comfort' } },
            ]);
        });

        it('creates a parameterless command', async () => {
            const common = await setValueCommon({});
            expect(common).to.include({ type: 'mixed', role: 'state', param: '' });
        });

        it('extends an existing setValue object so changed constraints are picked up', async () => {
            const adapter = createMock();
            adapter.objects.set('c.setValue', { type: 'state', common: { type: 'object', param: 'old', min: 5 } });
            await extractKeys(adapter, 'c', {
                isExecutable: true,
                params: { v: { type: 'number', constraints: { min: 0 } } },
            });
            expect(adapter.objects.get('c.setValue').common).to.include({ type: 'number', param: 'v', min: 0 });
        });

        it('logs instead of throwing when extendObjectAsync fails', async () => {
            const adapter = createMock();
            adapter.extendObjectAsync = async () => {
                throw new Error('db error');
            };
            await extractKeys(adapter, 'c', { isExecutable: true, params: {} });
            expect(adapter.log.logs.error.join()).to.include('db error');
        });
    });
});
