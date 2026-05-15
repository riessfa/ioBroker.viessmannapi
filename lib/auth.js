'use strict';

const crypto = require('crypto');
const { stringifyForLog } = require('./safeLog');

const TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS = 100;
const MIN_TOKEN_REFRESH_DELAY_MS = 30 * 1000;
const TOKEN_REFRESH_RETRY_DELAY_MS = 30 * 1000;
const RELOGIN_DELAY_MS = 60 * 1000;

function getCodeChallenge() {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  let hash = crypto.createHash('sha256').update(result).digest('base64');
  hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return [result, hash];
}

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

function scheduleRelogin(adapter) {
  clearAuthTimers(adapter);
  adapter.reLoginTimeout = setTimeout(async () => {
    adapter.reLoginTimeout = null;
    await adapter.login();
  }, RELOGIN_DELAY_MS);
}

async function refreshToken(adapter) {
  await adapter
    .requestClient({
      method: 'post',
      url: 'https://iam.viessmann-climatesolutions.com/idp/v3/token',
      headers: {
        'User-Agent': adapter.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data:
        'grant_type=refresh_token&client_id=' +
        adapter.config.client_id +
        '&refresh_token=' +
        adapter.session.refresh_token,
    })
    .then((res) => {
      adapter.log.debug(JSON.stringify(res.data));
      adapter.session = res.data;
      adapter.setState('info.connection', true, true);
      adapter.scheduleTokenRefresh();
      return res.data;
    })
    .catch((error) => {
      adapter.setState('info.connection', false, true);
      adapter.logAxiosError('Refresh token request failed', error);
      adapter.logResponseData(error);
      adapter.log.error('Start relogin in 1min');
      adapter.scheduleRelogin();
    });
}

module.exports = {
  TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS,
  MIN_TOKEN_REFRESH_DELAY_MS,
  TOKEN_REFRESH_RETRY_DELAY_MS,
  RELOGIN_DELAY_MS,
  getCodeChallenge,
  getTokenRefreshDelayMs,
  clearAuthTimers,
  scheduleTokenRefresh,
  scheduleRelogin,
  refreshToken,
};
