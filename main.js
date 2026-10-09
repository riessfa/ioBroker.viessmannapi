'use strict';

/*
 * ioBroker adapter for the Viessmann Developer Cloud API (maintained fork).
 *
 * API notes:
 * - All hosts use the viessmann-climatesolutions.com domain (migration July 2025).
 * - Installations are read from /iot/v2/equipment/installations (v1 was removed on 2025-12-15).
 * - Features are read from /iot/v2/features/... (v1 feature endpoints were switched off 2025-04-30).
 * - Feature names are not hardcoded, renamed features (e.g. hotWaterStorage -> dhwCylinder)
 *   show up automatically as the API returns them.
 */

const utils = require('@iobroker/adapter-core');
const { extractKeys } = require('./lib/extractKeys');
const { sanitizeUrlForLog, stringifyForLog } = require('./lib/safeLog');
const { API_BASE_URL, createApiClient, requestWithRetry } = require('./lib/apiClient');
const authHelpers = require('./lib/auth');
const { compileFeatureFilter, parseList } = require('./lib/filters');
const packageJson = require('./package.json');

const { TOKEN_REFRESH_RETRY_DELAY_MS } = authHelpers;

const DEFAULT_UPDATE_INTERVAL_MINUTES = 5;
const DEFAULT_EVENT_INTERVAL_MINUTES = 300;
const MIN_INTERVAL_MINUTES = 0.5;
// Keep the interval in milliseconds below the 32-bit setInterval limit (31 days)
const MAX_INTERVAL_MINUTES = 44640;
const COMMAND_REFRESH_DELAY_MS = 10 * 1000;
const COMMAND_RETRIES = 5;
const COMMAND_RETRY_DELAY_MS = 5 * 1000;
// Fallback pause when a 429 response carries no reset time
const RATE_LIMIT_FALLBACK_MS = 10 * 60 * 1000;
// Limits of the free "Basic" developer plan
const DAILY_CALL_LIMIT = 1450;
const TEN_MINUTE_CALL_LIMIT = 120;

class Viessmannapi extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'viessmannapi',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.installationArray = [];
        this.userAgent = `ioBroker.viessmannapi/${packageJson.version}`;
        this.abortController = new AbortController();
        this.requestClient = createApiClient(this.abortController.signal);
        this.updateInterval = null;
        this.eventInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.refreshTimeout = null;
        this.reloginAttempts = 0;
        this.deviceDiscoveryDone = false;
        this.updateRunning = false;
        this.eventsRunning = false;
        this.rateLimitedUntil = 0;
        this.connected = undefined;
        this.unloaded = false;
        this.extractKeys = extractKeys;
        this.session = {};
        this.gatewayIndexObject = {};
        /** @type {Set<string> | null} */
        this.deviceAllowList = null;
        /** @type {((feature: string) => boolean) | null} */
        this.featureFilter = null;
    }

    logAxiosError(context, error) {
        const details = {
            message: error && error.message,
            method: error && error.config && error.config.method,
            url: error && error.config && error.config.url,
            status: error && error.response && error.response.status,
            headers: error && error.config && error.config.headers,
            params: error && error.config && error.config.params,
            data: error && error.config && error.config.data,
            response: error && error.response && error.response.data,
        };

        this.log.error(`${context}: ${stringifyForLog(details)}`);
    }

    /**
     * Logs a debug message, building it only when debug logging is active.
     * Feature responses are large, stringifying them on every poll is wasteful.
     *
     * @param {() => string} build
     */
    logDebugLazy(build) {
        if (this.log.level === 'debug' || this.log.level === 'silly') {
            this.log.debug(build());
        }
    }

    /**
     * Updates info.connection only when the value changes.
     *
     * @param {boolean} connected
     */
    async setConnected(connected) {
        if (this.connected === connected) {
            return;
        }
        this.connected = connected;
        await this.setStateAsync('info.connection', connected, true);
    }

    /**
     * Coerces a config value to a finite number within bounds, falling back to a default.
     *
     * @param {any} value
     * @param {number} defaultValue
     * @param {number} min
     * @param {number} max
     * @param {string} name
     * @returns {number}
     */
    sanitizeNumberConfig(value, defaultValue, min, max, name) {
        const numeric = value === '' || value === null || value === undefined ? NaN : Number(value);
        if (!Number.isFinite(numeric)) {
            this.log.warn(`Invalid value for ${name} (${value}). Using default ${defaultValue}`);
            return defaultValue;
        }
        if (numeric < min) {
            this.log.info(`Set ${name} to minimum ${min}`);
            return min;
        }
        if (numeric > max) {
            this.log.info(`Set ${name} to maximum ${max}`);
            return max;
        }
        return numeric;
    }

    sanitizeConfig() {
        this.config.interval = this.sanitizeNumberConfig(
            this.config.interval,
            DEFAULT_UPDATE_INTERVAL_MINUTES,
            MIN_INTERVAL_MINUTES,
            MAX_INTERVAL_MINUTES,
            'interval',
        );
        this.config.eventInterval = this.sanitizeNumberConfig(
            this.config.eventInterval,
            DEFAULT_EVENT_INTERVAL_MINUTES,
            MIN_INTERVAL_MINUTES,
            MAX_INTERVAL_MINUTES,
            'eventInterval',
        );
        this.config.gatewayIndex = Math.floor(
            this.sanitizeNumberConfig(this.config.gatewayIndex, 1, 1, Number.MAX_SAFE_INTEGER, 'gatewayIndex'),
        );
        this.config.username = String(this.config.username || '').trim();
        this.config.client_id = String(this.config.client_id || '').trim();
        const devices = parseList(this.config.devicelist);
        this.deviceAllowList = devices.length ? new Set(devices) : null;
        this.featureFilter = compileFeatureFilter(this.config.featureFilter);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setConnected(false);
        this.sanitizeConfig();

        if (!this.config.username || !this.config.password || !this.config.client_id) {
            this.log.error('Please enter username, password and client ID in the instance settings');
            return;
        }

        await this.subscribeStatesAsync('*.setValue');
        await this.deleteLegacyLogbookObjects();
        await this.connect();
    }

    /**
     * Removes the logbook objects created by versions < 2.4.5.
     */
    async deleteLegacyLogbookObjects() {
        try {
            const objects = await this.getObjectViewAsync('system', 'channel', {
                startkey: `${this.namespace}.`,
                endkey: `${this.namespace}.香`,
            });
            for (const row of objects.rows) {
                if (row.id.endsWith('.device.messages.logbook')) {
                    this.log.info(`Deleting logbook objects: ${row.id}`);
                    await this.delObjectAsync(row.id, { recursive: true });
                }
            }
        } catch (e) {
            this.log.warn(`Could not clean up logbook objects: ${e && e.message ? e.message : e}`);
        }
    }

    /**
     * Logs in and, on success, runs device discovery (once), an initial fetch,
     * and starts polling. On failure a relogin retry is scheduled with backoff,
     * so a failed (initial or later) login never leaves the adapter dead.
     *
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.unloaded) {
            return;
        }
        try {
            const loggedIn = await this.login();
            if (!loggedIn || !this.session.access_token) {
                this.log.error('Login failed. Scheduling retry');
                this.scheduleRelogin();
                return;
            }
            this.reloginAttempts = 0;
            if (!this.deviceDiscoveryDone) {
                await this.runPollingTask('updateRunning', () => this.discoverAndFetch());
            }
            this.startPolling();
        } catch (e) {
            this.log.error(`Connect failed: ${e && e.message ? e.message : e}`);
            this.scheduleRelogin();
        }
    }

    /**
     * Discovers installations, gateways and devices and, on success,
     * fetches features and events once.
     */
    async discoverAndFetch() {
        if (!this.canRequest()) {
            return;
        }
        this.deviceDiscoveryDone = await this.getDeviceIds();
        if (!this.deviceDiscoveryDone) {
            this.log.warn('Device discovery failed. It will be retried with the next update');
            return;
        }
        this.logRateLimitEstimate();
        await this.updateDevices(true);
        await this.getEvents();
    }

    /**
     * Starts the feature and event polling intervals if they are not running yet.
     */
    startPolling() {
        if (this.updateInterval || this.eventInterval) {
            return;
        }
        this.updateInterval = this.setInterval(
            () => this.runPollingTask('updateRunning', () => this.pollDevices()),
            this.config.interval * 60 * 1000,
        );
        this.eventInterval = this.setInterval(
            () => this.runPollingTask('eventsRunning', () => this.getEvents()),
            this.config.eventInterval * 60 * 1000,
        );
    }

    /**
     * Runs a polling task unless the previous run is still active.
     * Errors are logged so that a failing poll never becomes an unhandled rejection.
     *
     * @param {'updateRunning' | 'eventsRunning'} flag
     * @param {() => Promise<void>} task
     */
    async runPollingTask(flag, task) {
        if (this[flag]) {
            this.log.debug(`Previous ${flag.replace('Running', '')} poll still running. Skipping`);
            return;
        }
        this[flag] = true;
        try {
            await task();
        } catch (e) {
            this.log.error(`${flag.replace('Running', '')} polling failed: ${e && e.message ? e.message : e}`);
        } finally {
            this[flag] = false;
        }
    }

    /**
     * Interval task for features: retries a failed discovery, otherwise updates devices.
     */
    async pollDevices() {
        if (!this.deviceDiscoveryDone) {
            await this.discoverAndFetch();
            return;
        }
        await this.updateDevices();
    }

    /**
     * Returns true when API requests may be sent: a token exists and no rate limit is active.
     *
     * @returns {boolean}
     */
    canRequest() {
        if (this.unloaded || !this.session.access_token) {
            return false;
        }
        if (this.rateLimitedUntil > Date.now()) {
            this.log.debug(`Rate limited until ${new Date(this.rateLimitedUntil).toISOString()}. Skipping request`);
            return false;
        }
        return true;
    }

    /**
     * @param {string} [contentType]
     * @returns {Record<string, string>}
     */
    getApiHeaders(contentType) {
        const headers = {
            Accept: 'application/json',
            'User-Agent': this.userAgent,
            Authorization: `Bearer ${this.session.access_token}`,
        };
        if (contentType) {
            headers['Content-Type'] = contentType;
        }
        return headers;
    }

    async login() {
        return authHelpers.login(this);
    }

    /**
     * Returns the gateway selected for an installation or undefined.
     *
     * @param {Record<string, any>} installation
     * @returns {Record<string, any> | undefined}
     */
    getSelectedGateway(installation) {
        const index = this.gatewayIndexObject[installation.id.toString()];
        return index ? installation.gateways[index - 1] : undefined;
    }

    /**
     * Reads all installations with their gateways and devices and creates the base objects.
     *
     * @returns {Promise<boolean>} true when the installations could be read.
     */
    async getDeviceIds() {
        let installations;
        try {
            const res = await this.requestClient.request({
                method: 'get',
                url: `${API_BASE_URL}/iot/v2/equipment/installations`,
                params: { includeGateways: true },
                headers: this.getApiHeaders(),
            });
            this.logDebugLazy(() => stringifyForLog(res.data));
            installations = (res.data && res.data.data) || [];
        } catch (error) {
            if (!this.handleKnownPollingError(error, 'Installations request')) {
                this.logAxiosError('Installations request failed', error);
            }
            return false;
        }

        this.installationArray = installations;
        if (installations.length === 0) {
            this.log.info('No installation found. Please connect your device with your Viessmann account');
            return true;
        }
        this.log.info(`${installations.length} installations found.`);

        for (const installation of installations) {
            const installationId = installation.id.toString();
            this.log.info(`Installation ${installation.description} created`);
            await this.setObjectNotExistsAsync(installationId, {
                type: 'device',
                common: {
                    name: installation.description || installationId,
                },
                native: {},
            });
            await this.extractKeys(this, installationId, installation, null, true);

            const allGateways = Array.isArray(installation.gateways) ? installation.gateways : [];
            if (allGateways.length > 1) {
                this.log.info(`Found ${allGateways.length} gateways for installation ${installation.id}`);
                this.logDebugLazy(() => JSON.stringify(allGateways));
                this.log.info('Filter out offline gateways.');
            }
            const onlineGateways = allGateways.filter(gateway => gateway.aggregatedStatus !== 'Offline');
            if (onlineGateways.length === 0 && allGateways.length > 0) {
                this.log.warn(`All gateways of installation ${installation.id} are offline. Using them anyway`);
            }
            installation.gateways = onlineGateways.length > 0 ? onlineGateways : allGateways;

            let currentGatewayIndex = this.config.gatewayIndex;
            if (currentGatewayIndex > installation.gateways.length) {
                this.log.warn(
                    `Gateway Index ${currentGatewayIndex} is not valid for installation ${installation.id}. Using index 1`,
                );
                currentGatewayIndex = 1;
            }
            if (installation.gateways.length > 1) {
                const count = installation.gateways.length;
                this.log.info(
                    `Found ${count} online gateways. Selecting gateway ${currentGatewayIndex} for installation ${installation.id}`,
                );
            }
            this.gatewayIndexObject[installationId] = currentGatewayIndex;
            const gateway = installation.gateways[currentGatewayIndex - 1];
            if (!gateway) {
                this.log.warn(`No gateway found for installation ${installation.id} and index ${currentGatewayIndex}`);
                continue;
            }
            for (const device of gateway.devices || []) {
                await this.setObjectNotExistsAsync(`${installationId}.${device.id}`, {
                    type: 'device',
                    common: {
                        name: device.modelId || String(device.id),
                    },
                    native: {},
                });

                await this.setObjectNotExistsAsync(`${installationId}.${device.id}.general`, {
                    type: 'channel',
                    common: {
                        name: 'General Device Information',
                    },
                    native: {},
                });

                await this.extractKeys(this, `${installationId}.${device.id}.general`, device);
            }
        }
        return true;
    }

    /**
     * Returns true when a device must not be polled.
     *
     * @param {Record<string, any>} device
     * @param {boolean} [ignoreFilter]
     * @returns {boolean}
     */
    isDeviceSkipped(device, ignoreFilter) {
        if (this.deviceAllowList && !this.deviceAllowList.has(String(device.id))) {
            this.log.debug(`ignore for update: ${device.id}`);
            return true;
        }
        if (ignoreFilter) {
            return false;
        }
        const roles = Array.isArray(device.roles) ? device.roles : [];
        const skip = roles.some(
            role =>
                role === 'type:gateway' ||
                role.includes('type:gateway;') ||
                (role.includes('type:virtual') && !this.config.allowVirtual),
        );
        if (skip) {
            this.log.debug(`ignore ${device.deviceType}`);
        }
        return skip;
    }

    /**
     * Returns the devices that are polled for features.
     *
     * @param {boolean} [ignoreFilter]
     * @returns {{ installation: Record<string, any>, device: Record<string, any> }[]}
     */
    getPolledDevices(ignoreFilter) {
        const result = [];
        for (const installation of this.installationArray) {
            const gateway = this.getSelectedGateway(installation);
            if (!gateway) {
                continue;
            }
            for (const device of gateway.devices || []) {
                if (!this.isDeviceSkipped(device, ignoreFilter)) {
                    result.push({ installation, device });
                }
            }
        }
        return result;
    }

    /**
     * Warns when the configured intervals exceed the API limits of the free plan.
     */
    logRateLimitEstimate() {
        const polled = this.getPolledDevices();
        const devices = polled.length;
        const featureCalls = this.config.loadViaGateway
            ? new Set(polled.map(({ installation, device }) => `${installation.id}/${device.gatewaySerial}`)).size
            : devices;
        const installations = this.installationArray.length;
        const perDay = Math.ceil(
            featureCalls * (1440 / this.config.interval) + installations * (1440 / this.config.eventInterval),
        );
        const perTenMinutes = Math.ceil(
            featureCalls * (10 / this.config.interval) + installations * (10 / this.config.eventInterval),
        );
        this.log.info(
            `Polling ${devices} devices. Estimated API calls: ${perDay} per day, ${perTenMinutes} per 10 minutes`,
        );
        if (perDay > DAILY_CALL_LIMIT || perTenMinutes > TEN_MINUTE_CALL_LIMIT) {
            this.log.warn(
                `The configured intervals exceed the Viessmann API limits of the free plan ` +
                    `(${DAILY_CALL_LIMIT} calls per day, ${TEN_MINUTE_CALL_LIMIT} per 10 minutes). ` +
                    'Increase the interval, enable loadViaGateway or use the device list / feature filter',
            );
        }
    }

    /**
     * Fetches the features of all polled devices.
     *
     * @param {boolean} [ignoreFilter] Also poll gateway and virtual devices (initial fetch).
     */
    async updateDevices(ignoreFilter) {
        for (const installation of this.installationArray) {
            if (!this.getSelectedGateway(installation)) {
                this.log.warn(`No gateway found for installation ${installation.id}`);
            }
        }
        const polled = this.getPolledDevices(ignoreFilter);
        if (this.config.loadViaGateway) {
            await this.updateDevicesViaGateway(polled);
            return;
        }
        for (const { installation, device } of polled) {
            if (!this.canRequest()) {
                return;
            }
            const gatewayPath = `${API_BASE_URL}/iot/v2/features/installations/${installation.id}/gateways/${device.gatewaySerial}`;
            const url = `${gatewayPath}/devices/${device.id}/features`;
            this.log.debug(`Start Update for ${device.id}`);
            const body = await this.fetchFeatures(url);
            if (body) {
                await this.storeFeatures(installation, device, body);
            }
        }
    }

    /**
     * Fetches the features of all devices of a gateway with one request
     * (`includeDevicesFeatures=true`) and splits them per device.
     *
     * @param {{ installation: Record<string, any>, device: Record<string, any> }[]} polled
     */
    async updateDevicesViaGateway(polled) {
        const groups = new Map();
        for (const { installation, device } of polled) {
            const key = `${installation.id}/${device.gatewaySerial}`;
            if (!groups.has(key)) {
                groups.set(key, { installation, gatewaySerial: device.gatewaySerial, devices: [] });
            }
            groups.get(key).devices.push(device);
        }
        for (const { installation, gatewaySerial, devices } of groups.values()) {
            if (!this.canRequest()) {
                return;
            }
            const gatewayPath = `${API_BASE_URL}/iot/v2/features/installations/${installation.id}/gateways/${gatewaySerial}`;
            const url = `${gatewayPath}/features?includeDevicesFeatures=true`;
            this.log.debug(`Start gateway update for ${gatewaySerial}`);
            const body = await this.fetchFeatures(url);
            if (!body || !Array.isArray(body.data)) {
                continue;
            }
            for (const device of devices) {
                const segment = `/devices/${device.id}/`;
                const features = body.data.filter(
                    item => item && typeof item.uri === 'string' && item.uri.includes(segment),
                );
                if (features.length === 0) {
                    this.log.debug(`No features for device ${device.id} in gateway response`);
                    continue;
                }
                await this.storeFeatures(installation, device, { data: features });
            }
        }
    }

    /**
     * GETs a features URL and returns the response body, or undefined on failure.
     *
     * @param {string} url
     * @returns {Promise<any>}
     */
    async fetchFeatures(url) {
        try {
            const res = await this.requestClient.request({ method: 'get', url, headers: this.getApiHeaders() });
            this.logDebugLazy(() => `${url} ${JSON.stringify(res.data)}`);
            return res.data || undefined;
        } catch (error) {
            if (!this.handleKnownPollingError(error, 'features feature update')) {
                this.log.error(`Feature update URL path: ${sanitizeUrlForLog(url, true)}`);
                this.logAxiosError('Feature update request failed', error);
            }
            return undefined;
        }
    }

    /**
     * @param {Record<string, any>} installation
     * @param {Record<string, any>} device
     * @param {any} body
     */
    async storeFeatures(installation, device, body) {
        await this.extractKeys(
            this,
            `${installation.id}.${device.id}.features`,
            this.prepareFeatures(body),
            'feature',
            null,
            false,
            'Features and States of the device',
        );
    }

    /**
     * Unwraps the features response and applies the logbook and feature filters.
     * A response with exactly one feature is unwrapped to the feature itself to
     * keep the object tree of earlier versions.
     *
     * @param {any} body
     * @returns {any}
     */
    prepareFeatures(body) {
        let data = body;
        const keys = Object.keys(body);
        if (keys.length === 1) {
            data = body[keys[0]];
        }
        if (!Array.isArray(data)) {
            return data;
        }
        // Unwrapping depends on the raw response length, not the filtered one,
        // so the object tree does not change when a filter is (de)activated.
        const single = data.length === 1;
        data = data.filter(item => !item || !item.feature || !item.feature.startsWith('device.messages.logbook'));
        if (this.featureFilter) {
            const originalCount = data.length;
            data = data.filter(item => this.featureFilter && this.featureFilter((item && item.feature) || ''));
            this.log.debug(`Feature filter: ${originalCount} -> ${data.length} features`);
        }
        return single && data.length === 1 ? data[0] : data;
    }

    /**
     * Handles HTTP statuses that are expected during polling (401/429/502/504/5xx)
     * with an info-level message instead of a full error dump.
     *
     * @param {any} error Axios error
     * @param {string} context Short description of the failing request
     * @returns {boolean} true when the error was handled
     */
    handleKnownPollingError(error, context) {
        if (error && (error.code === 'ERR_CANCELED' || this.unloaded)) {
            return true;
        }
        const status = error && error.response && error.response.status;
        if (!status) {
            return false;
        }
        if (status === 401) {
            this.log.debug(stringifyForLog(error.response.data));
            this.log.info(`${context} received 401 error. Refresh Token in 30 seconds`);
            this.scheduleTokenRefresh(TOKEN_REFRESH_RETRY_DELAY_MS);
            return true;
        }
        if (status === 429) {
            this.handleRateLimit(error.response.data);
            return true;
        }
        if (status === 502) {
            this.log.info(stringifyForLog(error.response.data));
            this.log.info('Please check the connection of your gateway');
            return true;
        }
        if (status === 504) {
            this.log.info('Viessmann API is not available please try again later');
            return true;
        }
        if (status >= 500) {
            this.log.info(
                `Error ${status}. Viessmann API not available because of unstable server. Please try again later`,
            );
            return true;
        }
        return false;
    }

    /**
     * Pauses all API requests until the rate limit resets. Viessmann reports
     * the reset time (epoch ms) in `extendedPayload.limitReset`.
     *
     * @param {any} data 429 response body
     */
    handleRateLimit(data) {
        const payload = (data && data.extendedPayload) || {};
        let resetAt = Number(payload.limitReset);
        if (!Number.isFinite(resetAt) || resetAt <= Date.now()) {
            resetAt = Date.now() + RATE_LIMIT_FALLBACK_MS;
        }
        const alreadyLimited = this.rateLimitedUntil > Date.now();
        this.rateLimitedUntil = resetAt;
        if (!alreadyLimited) {
            const name = payload.name ? ` (${payload.name})` : '';
            const until = new Date(resetAt).toISOString();
            this.log.warn(
                `Viessmann API rate limit reached${name}. Pausing requests until ${until}. ` +
                    'Increase the interval, enable loadViaGateway or use the device list / feature filter',
            );
        }
    }

    async getEvents() {
        for (const installation of this.installationArray) {
            const installationId = installation.id.toString();
            if (!this.getSelectedGateway(installation)) {
                const index = this.gatewayIndexObject[installationId];
                this.log.warn(`No gateway found for installation ${installation.id} and index ${index}`);
                continue;
            }
            if (!this.canRequest()) {
                return;
            }
            let res;
            try {
                res = await this.requestClient.request({
                    method: 'get',
                    url: `${API_BASE_URL}/iot/v2/events-history/installations/${installationId}/events`,
                    headers: this.getApiHeaders(),
                });
            } catch (error) {
                if (!this.handleKnownPollingError(error, 'Get Events')) {
                    this.logAxiosError('Receiving events failed', error);
                }
                continue;
            }
            this.logDebugLazy(() => JSON.stringify(res.data));
            if (!res.data) {
                continue;
            }
            let data = res.data;
            const keys = Object.keys(res.data);
            if (keys.length === 1) {
                data = res.data[keys[0]];
            }
            if (data.length === 1) {
                data = data[0];
            }

            await this.extractKeys(this, `${installationId}.events`, data, null, true);
        }
    }

    getTokenRefreshDelayMs() {
        return authHelpers.getTokenRefreshDelayMs(this);
    }

    scheduleTokenRefresh(delayMs) {
        return authHelpers.scheduleTokenRefresh(this, delayMs);
    }

    clearAuthTimers() {
        return authHelpers.clearAuthTimers(this);
    }

    scheduleRelogin() {
        if (this.unloaded) {
            return;
        }
        return authHelpers.scheduleRelogin(this);
    }

    clearPollingTimers() {
        if (this.updateInterval) {
            this.clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.eventInterval) {
            this.clearInterval(this.eventInterval);
            this.eventInterval = null;
        }
    }

    async refreshToken() {
        return authHelpers.refreshToken(this);
    }

    getCodeChallenge() {
        return authHelpers.getCodeChallenge();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.unloaded = true;
            this.abortController.abort();
            if (this.refreshTimeout) {
                this.clearTimeout(this.refreshTimeout);
                this.refreshTimeout = null;
            }
            this.clearAuthTimers();
            this.clearPollingTimers();
            this.setState('info.connection', false, true);
        } catch (e) {
            this.log.error(`Error: ${e}`);
        } finally {
            callback();
        }
    }

    /**
     * Converts numeric strings to numbers; leaves all other values
     * (including booleans and numbers) untouched.
     *
     * @param {any} value
     * @returns {any}
     */
    coerceNumericString(value) {
        if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
            return Number(value);
        }
        return value;
    }

    /**
     * Converts "true"/"false" strings to booleans; leaves all other values untouched.
     *
     * @param {any} value
     * @returns {any}
     */
    coerceBooleanString(value) {
        if (value === 'true') {
            return true;
        }
        if (value === 'false') {
            return false;
        }
        return value;
    }

    /**
     * Validates a single command parameter value against its constraints.
     *
     * @param {Record<string, any>} spec `{ type, min, max, states }`
     * @param {any} rawValue
     * @returns {{ valid: boolean, value?: any, reason?: string }}
     */
    validateParamValue(spec, rawValue) {
        const value = spec.type === 'boolean' ? this.coerceBooleanString(rawValue) : this.coerceNumericString(rawValue);

        if (spec.states) {
            const allowed = Object.keys(spec.states);
            if (!allowed.includes(String(value))) {
                return {
                    valid: false,
                    reason: `value "${value}" is not allowed. Valid values: ${allowed.join(', ')}`,
                };
            }
        }
        if (spec.type === 'boolean' && typeof value !== 'boolean') {
            return { valid: false, reason: 'expected a boolean' };
        }
        if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            return { valid: false, reason: 'expected a number' };
        }
        if (typeof value === 'number') {
            if (spec.min != null && value < spec.min) {
                return { valid: false, reason: `value ${value} is below minimum ${spec.min}` };
            }
            if (spec.max != null && value > spec.max) {
                return { valid: false, reason: `value ${value} exceeds maximum ${spec.max}` };
            }
        }
        return { valid: true, value };
    }

    validateCommandPayload(common, stateVal) {
        const param = common && common.param;
        if (!param) {
            return { valid: true, data: {} };
        }

        if (!Array.isArray(param)) {
            const spec = { ...common, type: common.type };
            const result = this.validateParamValue(spec, stateVal);
            if (!result.valid) {
                return { valid: false, reason: `Parameter "${param}": ${result.reason}` };
            }
            return { valid: true, data: { [param]: result.value } };
        }

        let parsed;
        if (typeof stateVal === 'object' && stateVal !== null) {
            parsed = stateVal;
        } else {
            try {
                parsed = JSON.parse(stateVal);
            } catch (e) {
                const example = {};
                for (const p of param) {
                    example[p.param] = `<${p.type}>`;
                }
                return {
                    valid: false,
                    reason: `Invalid JSON: ${e.message}. Expected format: ${JSON.stringify(example)}`,
                };
            }
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { valid: false, reason: 'Value must be a JSON object' };
        }

        const data = {};
        const errors = [];

        for (const entry of param) {
            if (typeof parsed[entry.param] === 'undefined') {
                if (entry.required === false) {
                    continue;
                }
                errors.push(`Missing required parameter "${entry.param}"`);
                continue;
            }
            const result = this.validateParamValue(entry, parsed[entry.param]);
            if (!result.valid) {
                errors.push(`Parameter "${entry.param}": ${result.reason}`);
                continue;
            }
            data[entry.param] = result.value;
        }

        if (errors.length > 0) {
            return { valid: false, reason: errors.join('; ') };
        }

        return { valid: true, data };
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        if (!id.endsWith('.setValue')) {
            this.log.info('please use setValue Object to set values');
            return;
        }
        const parentPath = id.slice(this.namespace.length + 1, -'.setValue'.length);

        const uriState = await this.getStateAsync(`${parentPath}.uri`);
        const idObject = await this.getObjectAsync(`${parentPath}.setValue`);

        if (!uriState || typeof uriState.val !== 'string' || !uriState.val) {
            this.log.info('No URI found');
            return;
        }
        if (!this.session.access_token) {
            this.log.warn('Command rejected: not logged in');
            return;
        }

        const result = this.validateCommandPayload(idObject && idObject.common, state.val);
        if (!result.valid) {
            this.log.warn(`Command rejected: ${result.reason}`);
            return;
        }

        const data = result.data;
        this.log.debug(`Data to send: ${JSON.stringify(data)}`);

        try {
            const res = await requestWithRetry(
                this.requestClient,
                {
                    method: 'post',
                    url: uriState.val,
                    headers: this.getApiHeaders('application/json'),
                    data: data,
                },
                {
                    retries: COMMAND_RETRIES,
                    delayMs: COMMAND_RETRY_DELAY_MS,
                    onRetry: (attempt, error) => {
                        this.log.error(stringifyForLog(error.response && error.response.data));
                        this.log.info(`Retry attempt #${attempt}`);
                    },
                },
            );
            this.log.debug(JSON.stringify(res.data));
            await this.setStateAsync(id, state.val, true);
        } catch (error) {
            if (error && error.code === 'ERR_CANCELED') {
                return;
            }
            this.logAxiosError('Command request failed', error);
            const responseData = error && error.response && error.response.data;
            if (responseData && responseData.extendedPayload && responseData.extendedPayload.code === 404) {
                this.log.error('Command does not exist. Please delete the objects manually and restart the adapter');
                return;
            }
            const status = error && error.response && error.response.status;
            if (status === 401) {
                this.scheduleTokenRefresh(TOKEN_REFRESH_RETRY_DELAY_MS);
            } else if (status === 429) {
                this.handleRateLimit(responseData);
            }
            this.log.error(`URL path: ${sanitizeUrlForLog(uriState.val, true)}`);
            this.log.error(`Data: ${stringifyForLog(data)}`);
        }
        if (this.refreshTimeout) {
            this.clearTimeout(this.refreshTimeout);
        }
        this.refreshTimeout = this.setTimeout(() => {
            this.refreshTimeout = null;
            this.runPollingTask('updateRunning', () => this.updateDevices());
        }, COMMAND_REFRESH_DELAY_MS);
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new Viessmannapi(options);
} else {
    // otherwise start the instance directly
    new Viessmannapi();
}
