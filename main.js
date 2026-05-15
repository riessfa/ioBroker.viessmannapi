'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 *
 * Domain Migration Update (July 2025):
 * Updated all Viessmann API endpoints from viessmann.com to viessmann-climatesolutions.com
 * as per official Viessmann notification for modernization of their services.
 *
 * API v2 Migration Update (December 2025):
 * Updated /iot/v1/equipment/installations endpoint to /iot/v2/equipment/installations
 * The v1 endpoint was deprecated and removed on 2025-12-15 (HTTP 410 Gone)
 *
 * Feature Name Changes (April 2025):
 * The adapter dynamically processes all features from the API without hardcoded feature names.
 * Therefore, all feature naming changes (e.g., hotWaterStorage -> dhwCylinder, heating.buffer -> heating.bufferCylinder,
 * heating.fuelcell -> fuelCell, heating.scop -> heating.spf, ventilation.operating.programs -> ventilation.quickmodes/levels)
 * are automatically reflected as the API returns the updated feature names.
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const rax = require('retry-axios');
const crypto = require('crypto');
const qs = require('qs');
const { extractKeys } = require('./lib/extractKeys');
const { sanitizeUrlForLog, stringifyForLog } = require('./lib/safeLog');
const { createApiClient } = require('./lib/apiClient');

const TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS = 100;
const MIN_TOKEN_REFRESH_DELAY_MS = 30 * 1000;
const TOKEN_REFRESH_RETRY_DELAY_MS = 30 * 1000;
const RELOGIN_DELAY_MS = 60 * 1000;

class Viessmannapi extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
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
    this.userAgent = 'ioBroker 2.0.4';
    const { client, retryInterceptorId } = createApiClient();
    this.requestClient = client;
    this.retryInterceptorId = retryInterceptorId;
    this.updateInterval = null;
    this.eventInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.refreshTokenInterval = null;
    this.extractKeys = extractKeys;
    this.idArray = [];
    this.session = {};
    this.rangeMapSupport = {};
    this.gatewayIndexObject = {};
  }

  logAxiosError(context, error) {
    const details = {
      message: error && error.message,
      method: error && error.config && error.config.method,
      url: error && error.config && error.config.url,
      currentUrl: error && error.request && error.request._currentUrl,
      status: error && error.response && error.response.status,
      headers: error && error.config && error.config.headers,
      params: error && error.config && error.config.params,
      data: error && error.config && error.config.data,
      response: error && error.response && error.response.data,
    };

    this.log.error(context + ': ' + stringifyForLog(details));
  }

  logResponseData(error) {
    if (error && error.response) {
      this.log.error(stringifyForLog(error.response.data));
    }
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    if (this.config.eventInterval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.eventInterval = 0.5;
    }

    this.subscribeStates('*');

    const adapterObjects = await this.getAdapterObjectsAsync();
    const deleted = {};
    for (const id of Object.keys(adapterObjects)) {
      if (id.includes('.device.messages.logbook')) {
        const basePath = id.split('.device.messages.logbook')[0] + '.device.messages.logbook';
        if (!deleted[basePath]) {
          this.log.info('Deleting logbook objects: ' + basePath);
          await this.delObjectAsync(basePath, { recursive: true });
          deleted[basePath] = true;
        }
      }
    }

    await this.login();
    if (this.session.access_token) {
      await this.getDeviceIds();
      await this.updateDevices(true);
      await this.getEvents();
      this.clearPollingTimers();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);

      this.eventInterval = setInterval(async () => {
        await this.getEvents();
      }, this.config.eventInterval * 60 * 1000);

      this.scheduleTokenRefresh();
    }
  }
  async login() {
    const [code_verifier, codeChallenge] = this.getCodeChallenge();

    const headers = {
      Accept: '*/*',
      'User-Agent': this.userAgent,
      Authorization: 'Basic ' + Buffer.from(this.config.username + ':' + this.config.password).toString('base64'),
    };
    let data = {
      client_id: this.config.client_id,
      response_type: 'code',
      scope: 'IoT User offline_access',
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      redirect_uri: 'http://localhost:4200/',
    };

    const code = await this.requestClient({
      method: 'get',
      url: 'https://iam.viessmann-climatesolutions.com/idp/v3/authorize',
      headers: headers,
      params: data,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        if (error.request && error.request._currentUrl) {
          this.log.debug('Authorization redirect path: ' + sanitizeUrlForLog(error.request._currentUrl, true));
          const parsedParams = qs.parse(error.request._currentUrl.split('?')[1]);
          if (parsedParams.code) {
            return parsedParams.code;
          }
        }
        this.logAxiosError('Authorization request failed', error);
        if (error.response) {
          if (error.response.data && error.response.data.error_description === 'Client not registered.') {
            this.log.error(
              'Cannot find clientId in the viessmann Account. Please wait 15min if the clientId is new and try again',
            );
          }

          this.log.error(stringifyForLog(error.response.data));
          if (error.response.data.error && error.response.data.error === 'Invalid redirection URI.') {
            this.log.error(
              'Please add / at the end of the redirect URI in viessman app settings: http://localhost:4200/',
            );
          }
        }
      });
    data = {
      grant_type: 'authorization_code',
      code: code,
      client_id: this.config.client_id,
      code_verifier: code_verifier,
      redirect_uri: 'http://localhost:4200/',
    };
    delete headers.Authorization;
    await this.requestClient({
      method: 'post',
      url: 'https://iam.viessmann-climatesolutions.com/idp/v3/token',
      headers: headers,
      data: qs.stringify(data),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        this.scheduleTokenRefresh();
        return res.data;
      })
      .catch((error) => {
        this.setState('info.connection', false, true);
        this.logAxiosError('Token request failed', error);
        if (error.response && error.response.status === 429) {
          this.log.info('Rate limit reached. Will be reseted next day 02:00');
        }
        this.logResponseData(error);
      });
  }
  async getDeviceIds() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': this.userAgent,
      Authorization: 'Bearer ' + this.session.access_token,
    };

    await this.requestClient({
      method: 'get',
      url: 'https://api.viessmann-climatesolutions.com/iot/v2/equipment/installations?includeGateways=true',
      headers: headers,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.data && res.data.data.length > 0) {
          this.installationArray = res.data.data;
          this.log.info(this.installationArray.length + ' installations found.');
          for (const installation of this.installationArray) {
            const installationId = installation.id.toString();
            this.log.info('Installation ' + installation.description + ' created');
            await this.setObjectNotExistsAsync(installationId, {
              type: 'device',
              common: {
                name: installation.description,
              },
              native: {},
            });
            await this.extractKeys(this, installationId, installation, null, true);
          }
        } else {
          this.log.info('No installation found. Please connect your device with your Viessmann account');
        }
      })
      .catch((error) => {
        this.logAxiosError('Installations request failed', error);
        if (error.response && error.response.status === 429) {
          this.log.info('Rate limit reached. Will be reseted next day 02:00');
        }
        this.logResponseData(error);
      });
    for (const installation of this.installationArray) {
      const installationId = installation.id.toString();

      let currentGatewayIndex = this.config.gatewayIndex;
      if (installation.gateways.length > 1) {
        this.log.info(
          'Found ' + installation.gateways.length + ' gateways for installation for installation ' + installation.id,
        );
        this.log.debug(JSON.stringify(installation.gateways));
        this.log.info('Filter out offline gateways.');
        installation.gateways = installation.gateways.filter((gateway) => {
          return gateway.aggregatedStatus !== 'Offline';
        });
        //check if gatewayIndex is valid
        if (currentGatewayIndex > installation.gateways.length) {
          this.log.warn(
            'Gateway Index ' +
              currentGatewayIndex +
              ' is not valid. Please check the number of gateways for installation ' +
              installation.id +
              ' index is set to 1',
          );
          currentGatewayIndex = 1;
        }
        this.log.warn(
          'Found ' +
            installation.gateways.length +
            ' online gateways select ' +
            currentGatewayIndex +
            ' gateway. for installation ' +
            installation.id,
        );
      }
      this.gatewayIndexObject[installationId] = currentGatewayIndex;
      const gateway = installation.gateways[currentGatewayIndex - 1];
      if (!gateway || gateway == null) {
        this.log.warn('No gateway found for installation ' + installation.id + 'and index ' + currentGatewayIndex);
        this.log.info(JSON.stringify(installation.gateways));
        return;
      }
      for (const device of gateway.devices) {
        await this.setObjectNotExistsAsync(installationId + '.' + device.id, {
          type: 'device',
          common: {
            name: device.modelId,
          },
          native: {},
        });

        await this.setObjectNotExistsAsync(installationId + '.' + device.id + '.general', {
          type: 'channel',
          common: {
            name: 'General Device Information',
          },
          native: {},
        });

        await this.extractKeys(this, installationId + '.' + device.id + '.general', device);
      }
    }
  }
  async updateDevices(ignoreFilter) {
    const statusArray = [
      {
        path: 'features',
        // *** MODIFIED LINE BELOW ***
        // Changed from /iot/v1/equipment/installations/... to /iot/v2/features/installations/... as per Viessmann API update effective 2025-04-30
        url: 'https://api.viessmann-climatesolutions.com/iot/v2/features/installations/$installation/gateways/$gatewaySerial/devices/$id/features',
        desc: 'Features and States of the device',
      },
    ];

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      Authorization: 'Bearer ' + this.session.access_token,
    };

    for (const installation of this.installationArray) {
      const currentGatewayIndex = this.gatewayIndexObject[installation.id.toString()];
      if (!installation['gateways'][currentGatewayIndex - 1]) {
        this.log.warn('No gateway found for installation ' + installation.id);
        return;
      }

      for (const device of installation['gateways'][currentGatewayIndex - 1]['devices']) {
        if (this.config.devicelist) {
          const deviceArray = this.config.devicelist.replace(/\s/g, '').split(',');
          if (!deviceArray.includes(device.id.toString())) {
            this.log.debug('ignore for update: ' + device.id);
            continue;
          }
        }
        for (const element of statusArray) {
          let url = element.url.replace('$id', device.id);
          url = url.replace('$installation', installation.id);
          url = url.replace('$gatewaySerial', device.gatewaySerial);
          if (
            !ignoreFilter &&
            device.roles.some((role) => {
              if (role.includes('type:gateway;') || role === 'type:gateway') {
                return true;
              }
              if (role.includes('type:virtual') && !this.config.allowVirtual) {
                return true;
              }
            })
          ) {
            this.log.debug('ignore ' + device.deviceType);
            continue;
          }
          this.log.debug('Start Update for ' + device.id);
          await this.requestClient({
            method: 'get',
            url: url,
            headers: headers,
          })
            .then(async (res) => {
              this.log.debug(url + ' ' + device.id + ' ' + JSON.stringify(res.data));
              if (!res.data) {
                return;
              }
              let data = res.data;
              const keys = Object.keys(res.data);
              if (keys.length === 1) {
                data = res.data[keys[0]];
              }
              if (data.length === 1) {
                data = data[0];
              }
              // Filter features by path pattern if featureFilter is configured
              if (this.config.featureFilter && Array.isArray(data)) {
                const patterns = this.config.featureFilter.replace(/\s/g, '').split(',').filter(p => p);
                if (patterns.length > 0) {
                  const originalCount = data.length;
                  data = data.filter(item => {
                    const featurePath = item.feature || '';
                    return patterns.some(pattern => {
                      if (pattern.endsWith('*')) {
                        // Wildcard: heating.* matches heating, heating.boiler, heating.burner, etc.
                        let prefix = pattern.slice(0, -1);
                        // Remove trailing dot to get base path
                        if (prefix.endsWith('.')) {
                          prefix = prefix.slice(0, -1);
                        }
                        // Match base path exactly OR as prefix with dot separator
                        return featurePath === prefix || featurePath.startsWith(prefix + '.');
                      }
                      // Exact match
                      return featurePath === pattern;
                    });
                  });
                  this.log.debug(`Feature filter: ${originalCount} -> ${data.length} features`);
                }
              }
              if (Array.isArray(data)) {
                data = data.filter(item => !item.feature || !item.feature.startsWith('device.messages.logbook'));
              }
              const extractPath = installation.id + '.' + device.id + '.' + element.path;
              const forceIndex = null;

              await this.extractKeys(this, extractPath, data, 'feature', forceIndex, false, element.desc);
            })
            .catch((error) => {
              if (error.response && error.response.status === 401) {
                error.response && this.log.debug(stringifyForLog(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 30 seconds');
                this.scheduleTokenRefresh(TOKEN_REFRESH_RETRY_DELAY_MS);

                return;
              }
              if (error.response && error.response.status === 429) {
                this.log.info('Rate limit reached. Will be reseted next day 02:00');
              }
              if (error.response && error.response.status >= 500) {
                this.log.info(
                  'Error ' +
                    error.response.status +
                    '. ViessmanAPI not available because of unstable server. Please contact Viessmann and ask them to improve their server',
                );
                return;
              }
              if (error.response && error.response.status === 502) {
                this.log.info(stringifyForLog(error.response.data));
                this.log.info('Please check the connection of your gateway');
              }
              if (error.response && error.response.status === 504) {
                this.log.info('Viessmann API is not available please try again later');
              }
              this.log.error('Feature update URL path: ' + sanitizeUrlForLog(url, true));
              this.logAxiosError('Feature update request failed', error);
              this.logResponseData(error);
            });
        }
      }
    }
  }
  async getEvents() {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      Authorization: 'Bearer ' + this.session.access_token,
    };
    for (const installation of this.installationArray) {
      const installationId = installation.id.toString();
      const currentGatewayIndex = this.gatewayIndexObject[installationId];
      if (!installation['gateways'][currentGatewayIndex - 1]) {
        this.log.warn('No gateway found for installation ' + installation.id + 'and index ' + currentGatewayIndex);
        return;
      }
      // Note: The events endpoint /iot/v2/events-history/... was already V2 in the original code. No change needed here.
      // const gatewaySerial = installation['gateways'][currentGatewayIndex - 1].serial.toString();
      await this.requestClient({
        method: 'get',
        url:
          'https://api.viessmann-climatesolutions.com/iot/v2/events-history/installations/' +
          installationId +
          '/events',
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (!res.data) {
            return;
          }
          let data = res.data;
          const keys = Object.keys(res.data);
          if (keys.length === 1) {
            data = res.data[keys[0]];
          }
          if (data.length === 1) {
            data = data[0];
          }

          await this.extractKeys(this, installationId + '.events', data, null, true);
        })
        .catch((error) => {
          if (error.response && error.response.status === 401) {
            error.response && this.log.debug(stringifyForLog(error.response.data));

            this.log.info('Get Events receive 401 error. Refresh Token in 30 seconds');
            this.scheduleTokenRefresh(TOKEN_REFRESH_RETRY_DELAY_MS);

            return;
          }
          if (error.response && error.response.status === 429) {
            this.log.info('Rate limit reached. Will be reseted next day 02:00');
          }
          if (error.response && error.response.status === 502) {
            this.log.info(stringifyForLog(error.response.data));
            this.log.info('Please check the connection of your gateway');
          }
          if (error.response && error.response.status === 504) {
            this.log.info('Viessmann API is not available please try again later');
          }
          this.logAxiosError('Receiving events failed', error);
          error.response && this.log.debug(stringifyForLog(error.response.data));
        });
    }
  }

  getTokenRefreshDelayMs() {
    const expiresIn = Number(this.session && this.session.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS) {
      this.log.warn(
        'Invalid or very small token expiry received (' +
          stringifyForLog(this.session && this.session.expires_in) +
          '). Refresh Token in ' +
          MIN_TOKEN_REFRESH_DELAY_MS / 1000 +
          ' seconds',
      );
      return MIN_TOKEN_REFRESH_DELAY_MS;
    }

    const refreshDelay = (expiresIn - TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS) * 1000;
    return Math.max(refreshDelay, MIN_TOKEN_REFRESH_DELAY_MS);
  }

  scheduleTokenRefresh(delayMs) {
    this.clearAuthTimers();
    const refreshDelay = Number.isFinite(delayMs)
      ? Math.max(delayMs, MIN_TOKEN_REFRESH_DELAY_MS)
      : this.getTokenRefreshDelayMs();

    this.refreshTokenTimeout = setTimeout(() => {
      this.refreshTokenTimeout = null;
      this.refreshToken();
    }, refreshDelay);
  }

  clearAuthTimers() {
    if (this.refreshTokenTimeout) {
      clearTimeout(this.refreshTokenTimeout);
      this.refreshTokenTimeout = null;
    }
    if (this.refreshTokenInterval) {
      clearInterval(this.refreshTokenInterval);
      this.refreshTokenInterval = null;
    }
    if (this.reLoginTimeout) {
      clearTimeout(this.reLoginTimeout);
      this.reLoginTimeout = null;
    }
  }

  scheduleRelogin() {
    this.clearAuthTimers();
    this.reLoginTimeout = setTimeout(async () => {
      this.reLoginTimeout = null;
      await this.login();
    }, RELOGIN_DELAY_MS);
  }

  clearPollingTimers() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.eventInterval) {
      clearInterval(this.eventInterval);
      this.eventInterval = null;
    }
  }

  async refreshToken() {
    await this.requestClient({
      method: 'post',
      url: 'https://iam.viessmann-climatesolutions.com/idp/v3/token',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data:
        'grant_type=refresh_token&client_id=' + this.config.client_id + '&refresh_token=' + this.session.refresh_token,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        this.scheduleTokenRefresh();
        return res.data;
      })
      .catch((error) => {
        this.setState('info.connection', false, true);
        this.logAxiosError('Refresh token request failed', error);
        this.logResponseData(error);
        this.log.error('Start relogin in 1min');
        this.scheduleRelogin();
      });
  }
  getCodeChallenge() {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    let hash = crypto.createHash('sha256').update(result).digest('base64');
    hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return [result, hash];
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      clearTimeout(this.refreshTimeout);
      this.clearAuthTimers();
      this.clearPollingTimers();
      if (this.retryInterceptorId !== undefined) {
        rax.detach(this.retryInterceptorId, this.requestClient);
        this.retryInterceptorId = undefined;
      }
      callback();
    } catch (e) {
      this.log.error('Error: ' + e);
      callback();
    }
  }

  validateCommandPayload(common, stateVal) {
    if (!common) {
      return { valid: true, data: {} };
    }

    const param = common.param;
    if (!param) {
      return { valid: true, data: {} };
    }

    if (!Array.isArray(param)) {
      let value = stateVal;
      if (value !== '' && value !== null && !isNaN(value)) {
        value = Number(value);
      }

      if (common.states) {
        const allowed = Object.keys(common.states);
        if (!allowed.includes(String(value))) {
          return {
            valid: false,
            reason: 'Value "' + value + '" is not allowed for "' + param + '". Valid values: ' + allowed.join(', '),
          };
        }
      }

      if (typeof value === 'number') {
        if (common.min != null && value < common.min) {
          return {
            valid: false,
            reason: 'Value ' + value + ' for "' + param + '" is below minimum ' + common.min,
          };
        }
        if (common.max != null && value > common.max) {
          return {
            valid: false,
            reason: 'Value ' + value + ' for "' + param + '" exceeds maximum ' + common.max,
          };
        }
      }

      return { valid: true, data: { [param]: value } };
    }

    let parsed;
    try {
      parsed = JSON.parse(stateVal);
    } catch (e) {
      const example = {};
      for (const p of param) {
        example[p.param] = '<' + p.type + '>';
      }
      return {
        valid: false,
        reason: 'Invalid JSON: ' + e.message + '. Expected format: ' + JSON.stringify(example),
      };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { valid: false, reason: 'Value must be a JSON object' };
    }

    const data = {};
    const errors = [];

    for (const entry of param) {
      if (typeof parsed[entry.param] === 'undefined') {
        errors.push('Missing required parameter "' + entry.param + '"');
        continue;
      }

      let value = parsed[entry.param];
      if (value !== '' && value !== null && !isNaN(value)) {
        value = Number(value);
      }

      if (entry.states) {
        const allowed = Object.keys(entry.states);
        if (!allowed.includes(String(value))) {
          errors.push(
            'Parameter "' + entry.param + '": value "' + value + '" is not allowed. Valid values: ' + allowed.join(', '),
          );
          continue;
        }
      }

      if (entry.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push('Parameter "' + entry.param + '": expected a number');
          continue;
        }
        if (entry.min != null && value < entry.min) {
          errors.push('Parameter "' + entry.param + '": value ' + value + ' is below minimum ' + entry.min);
          continue;
        }
        if (entry.max != null && value > entry.max) {
          errors.push('Parameter "' + entry.param + '": value ' + value + ' exceeds maximum ' + entry.max);
          continue;
        }
      }

      data[entry.param] = value;
    }

    if (errors.length > 0) {
      return { valid: false, reason: errors.join('; ') };
    }

    return { valid: true, data };
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.indexOf('.setValue') === -1) {
          this.log.info('please use setValue Object to set values');
          return;
        }
        // const deviceId = id.split('.')[2];
        const parentPath = id.split('.').slice(1, -1).slice(1).join('.');

        const uriState = await this.getStateAsync(parentPath + '.uri');
        const idState = await this.getObjectAsync(parentPath + '.setValue');

        if (!uriState || !uriState.val) {
          this.log.info('No URI found');
          return;
        }

        const result = this.validateCommandPayload(idState && idState.common, state.val);
        if (!result.valid) {
          this.log.warn('Command rejected: ' + result.reason);
          return;
        }

        const data = result.data;
        this.log.debug('Data to send: ' + JSON.stringify(data));

        const headers = {
          'Content-Type': 'application/json',
          Accept: '*/*',
          'User-Agent': this.userAgent,
          Authorization: 'Bearer ' + this.session.access_token,
        };
        await this.requestClient({
          method: 'post',
          url: uriState.val,
          headers: headers,
          data: data,
          raxConfig: {
            retry: 5,
            noResponseRetries: 2,
            retryDelay: 5000,
            backoffType: 'static',
            statusCodesToRetry: [[500, 599]],
            onRetryAttempt: (error) => {
              const cfg = rax.getConfig(error);
              if (error.response) {
                this.log.error(stringifyForLog(error.response.data));
              }
              cfg && this.log.info(`Retry attempt #${cfg.currentRetryAttempt}`);
            },
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.logAxiosError('Command request failed', error);
            this.logResponseData(error);
            if (
              error.response &&
              error.response.data &&
              error.response.data.extendedPayload &&
              error.response.data.extendedPayload.code === 404
            ) {
              this.log.error('Command not exist please. Please delete objects manually and restart the adapter');
              return;
            }
            this.log.error('URL path: ' + sanitizeUrlForLog(uriState.val, true));
            this.log.error('Data: ' + stringifyForLog(data));
          });
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices();
        }, 10 * 1000);
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Viessmannapi(options);
} else {
  // otherwise start the instance directly
  new Viessmannapi();
}
