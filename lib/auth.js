'use strict';

const crypto = require('crypto');
const qs = require('qs');
const { stringifyForLog } = require('./safeLog');

const TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS = 100;
const MIN_TOKEN_REFRESH_DELAY_MS = 30 * 1000;
const TOKEN_REFRESH_RETRY_DELAY_MS = 30 * 1000;
const RELOGIN_DELAY_MS = 60 * 1000;
const RELOGIN_MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * Creates an OAuth PKCE verifier/challenge pair.
 *
 * @returns {[string, string]} Tuple of `[codeVerifier, codeChallenge]`.
 */
function getCodeChallenge() {
  const result = crypto.randomBytes(32).toString('hex');
  let hash = crypto.createHash('sha256').update(result).digest('base64');
  hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return [result, hash];
}

/**
 * Computes the token refresh delay from the current session expiry.
 *
 * @param {Record<string, any>} adapter
 * @returns {number} Delay in milliseconds.
 */
function getTokenRefreshDelayMs(adapter) {
  const expiresIn = Number(adapter.session && adapter.session.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS) {
    adapter.log.warn(
      'Invalid or very small token expiry received (' +
        stringifyForLog(adapter.session && adapter.session.expires_in) +
        '). Refresh Token in ' +
        MIN_TOKEN_REFRESH_DELAY_MS / 1000 +
        ' seconds',
    );
    return MIN_TOKEN_REFRESH_DELAY_MS;
  }

  const refreshDelay = (expiresIn - TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS) * 1000;
  return Math.max(refreshDelay, MIN_TOKEN_REFRESH_DELAY_MS);
}

/**
 * Clears all currently scheduled authentication-related timers.
 *
 * @param {{refreshTokenTimeout?: NodeJS.Timeout|null, refreshTokenInterval?: NodeJS.Timeout|null, reLoginTimeout?: NodeJS.Timeout|null}} adapter
 */
function clearAuthTimers(adapter) {
  if (adapter.refreshTokenTimeout) {
    clearTimeout(adapter.refreshTokenTimeout);
    adapter.refreshTokenTimeout = null;
  }
  if (adapter.refreshTokenInterval) {
    clearInterval(adapter.refreshTokenInterval);
    adapter.refreshTokenInterval = null;
  }
  if (adapter.reLoginTimeout) {
    clearTimeout(adapter.reLoginTimeout);
    adapter.reLoginTimeout = null;
  }
}

/**
 * Schedules the next access-token refresh.
 *
 * @param {Record<string, any>} adapter
 * @param {number} [delayMs]
 */
function scheduleTokenRefresh(adapter, delayMs) {
  clearAuthTimers(adapter);
  const refreshDelay = Number.isFinite(delayMs)
    ? Math.max(delayMs, MIN_TOKEN_REFRESH_DELAY_MS)
    : getTokenRefreshDelayMs(adapter);

  adapter.refreshTokenTimeout = setTimeout(() => {
    adapter.refreshTokenTimeout = null;
    adapter.refreshToken();
  }, refreshDelay);
}

/**
 * Schedules a full re-login attempt after a refresh or login failure.
 * The delay backs off exponentially with consecutive failures
 * (60s, 2min, 4min, ... capped at 30min). `adapter.reloginAttempts`
 * is reset by the adapter once a login succeeds.
 *
 * @param {Record<string, any>} adapter
 */
function scheduleRelogin(adapter) {
  clearAuthTimers(adapter);
  const attempts = Number.isFinite(adapter.reloginAttempts) ? adapter.reloginAttempts : 0;
  const delayMs = Math.min(RELOGIN_DELAY_MS * Math.pow(2, attempts), RELOGIN_MAX_DELAY_MS);
  adapter.reloginAttempts = attempts + 1;
  adapter.log.info('Scheduling relogin in ' + Math.round(delayMs / 1000) + ' seconds');
  adapter.reLoginTimeout = setTimeout(async () => {
    adapter.reLoginTimeout = null;
    await adapter.connect();
  }, delayMs);
}

/**
 * Exchanges the refresh token for a new access token and updates adapter state.
 *
 * @param {Record<string, any>} adapter
 * @returns {Promise<void>}
 */
async function refreshToken(adapter) {
  await adapter
    .requestClient({
      method: 'post',
      url: 'https://iam.viessmann-climatesolutions.com/idp/v3/token',
      headers: {
        'User-Agent': adapter.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        grant_type: 'refresh_token',
        client_id: adapter.config.client_id,
        refresh_token: adapter.session.refresh_token,
      }),
    })
    .then((res) => {
      adapter.log.debug(stringifyForLog(res.data));
      adapter.session = res.data;
      adapter.setState('info.connection', true, true);
      adapter.scheduleTokenRefresh();
      return res.data;
    })
    .catch((error) => {
      adapter.setState('info.connection', false, true);
      adapter.logAxiosError('Refresh token request failed', error);
      adapter.scheduleRelogin();
    });
}

module.exports = {
  TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS,
  MIN_TOKEN_REFRESH_DELAY_MS,
  TOKEN_REFRESH_RETRY_DELAY_MS,
  RELOGIN_DELAY_MS,
  RELOGIN_MAX_DELAY_MS,
  getCodeChallenge,
  getTokenRefreshDelayMs,
  clearAuthTimers,
  scheduleTokenRefresh,
  scheduleRelogin,
  refreshToken,
};
