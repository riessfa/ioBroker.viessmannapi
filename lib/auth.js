'use strict';

const crypto = require('crypto');
const { IAM_BASE_URL, REDIRECT_URI } = require('./apiClient');
const { sanitizeUrlForLog, stringifyForLog } = require('./safeLog');

const TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS = 100;
const MIN_TOKEN_REFRESH_DELAY_MS = 30 * 1000;
const TOKEN_REFRESH_RETRY_DELAY_MS = 30 * 1000;
const RELOGIN_DELAY_MS = 60 * 1000;
const RELOGIN_MAX_DELAY_MS = 30 * 60 * 1000;
const OAUTH_SCOPE = 'IoT User offline_access';

/**
 * Creates an OAuth PKCE verifier/challenge pair (RFC 7636, S256).
 *
 * @returns {[string, string]} Tuple of `[codeVerifier, codeChallenge]`.
 */
function getCodeChallenge() {
    const verifier = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return [verifier, challenge];
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
            `Invalid or very small token expiry received (${stringifyForLog(
                adapter.session && adapter.session.expires_in,
            )}). Refresh Token in ${MIN_TOKEN_REFRESH_DELAY_MS / 1000} seconds`,
        );
        return MIN_TOKEN_REFRESH_DELAY_MS;
    }

    const refreshDelay = (expiresIn - TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS) * 1000;
    return Math.max(refreshDelay, MIN_TOKEN_REFRESH_DELAY_MS);
}

/**
 * Clears all currently scheduled authentication-related timers.
 *
 * @param {Record<string, any>} adapter
 */
function clearAuthTimers(adapter) {
    if (adapter.refreshTokenTimeout) {
        adapter.clearTimeout(adapter.refreshTokenTimeout);
        adapter.refreshTokenTimeout = null;
    }
    if (adapter.reLoginTimeout) {
        adapter.clearTimeout(adapter.reLoginTimeout);
        adapter.reLoginTimeout = null;
    }
}

/**
 * Schedules the next access-token refresh. A pending relogin is left alone:
 * once the refresh token is known to be invalid, only a full login helps.
 *
 * @param {Record<string, any>} adapter
 * @param {number} [delayMs]
 */
function scheduleTokenRefresh(adapter, delayMs) {
    if (adapter.reLoginTimeout) {
        return;
    }
    clearAuthTimers(adapter);
    const refreshDelay =
        typeof delayMs === 'number' && Number.isFinite(delayMs)
            ? Math.max(delayMs, MIN_TOKEN_REFRESH_DELAY_MS)
            : getTokenRefreshDelayMs(adapter);

    adapter.refreshTokenTimeout = adapter.setTimeout(() => {
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
    adapter.log.info(`Scheduling relogin in ${Math.round(delayMs / 1000)} seconds`);
    adapter.reLoginTimeout = adapter.setTimeout(async () => {
        adapter.reLoginTimeout = null;
        await adapter.connect();
    }, delayMs);
}

/**
 * Reads the authorization code from a redirect location.
 *
 * @param {any} location
 * @returns {string | undefined}
 */
function getCodeFromLocation(location) {
    if (typeof location !== 'string' || !location.includes('?')) {
        return undefined;
    }
    return new URLSearchParams(location.split('?')[1]).get('code') || undefined;
}

/**
 * Logs helpful hints for well-known IAM error responses.
 *
 * @param {Record<string, any>} adapter
 * @param {any} data
 */
function logIamHints(adapter, data) {
    if (!data) {
        return;
    }
    if (data.error_description === 'Client not registered.') {
        adapter.log.error(
            'Cannot find clientId in the viessmann Account. Please wait 15min if the clientId is new and try again',
        );
    }
    if (data.error === 'Invalid redirection URI.' || data.error_description === 'Invalid redirection URI.') {
        adapter.log.error(`Please add / at the end of the redirect URI in viessman app settings: ${REDIRECT_URI}`);
    }
}

/**
 * Runs the OAuth 2.0 authorization code flow with PKCE using the account
 * credentials (Basic auth on the authorize endpoint). On success the token
 * response is stored in `adapter.session` and the next refresh is scheduled.
 *
 * @param {Record<string, any>} adapter
 * @returns {Promise<boolean>} true when an access token was obtained.
 */
async function login(adapter) {
    const [codeVerifier, codeChallenge] = adapter.getCodeChallenge();
    const config = adapter.config;

    let code;
    try {
        const res = await adapter.requestClient.request({
            method: 'get',
            url: `${IAM_BASE_URL}/authorize`,
            headers: {
                Accept: '*/*',
                'User-Agent': adapter.userAgent,
                Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
            },
            params: {
                client_id: config.client_id,
                response_type: 'code',
                scope: OAUTH_SCOPE,
                code_challenge_method: 'S256',
                code_challenge: codeChallenge,
                redirect_uri: REDIRECT_URI,
            },
            // The authorize endpoint answers with a redirect to the (unreachable)
            // redirect URI that carries the code. Do not follow it.
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
        });
        const location = res.headers && res.headers.location;
        adapter.log.debug(`Authorization redirect path: ${sanitizeUrlForLog(location, true)}`);
        code = getCodeFromLocation(location);
        if (!code) {
            adapter.log.error(
                `Login failed: no authorization code received (HTTP ${res.status}). ` +
                    'Please check username, password and client ID',
            );
        }
    } catch (error) {
        adapter.logAxiosError('Authorization request failed', error);
        logIamHints(adapter, error.response && error.response.data);
    }

    if (!code) {
        await adapter.setConnected(false);
        return false;
    }

    try {
        const res = await adapter.requestClient.request({
            method: 'post',
            url: `${IAM_BASE_URL}/token`,
            headers: { Accept: 'application/json', 'User-Agent': adapter.userAgent },
            data: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                client_id: config.client_id,
                code_verifier: codeVerifier,
                redirect_uri: REDIRECT_URI,
            }),
        });
        adapter.log.debug(stringifyForLog(res.data));
        adapter.session = res.data || {};
        await adapter.setConnected(!!adapter.session.access_token);
        if (!adapter.session.access_token) {
            return false;
        }
        adapter.scheduleTokenRefresh();
        return true;
    } catch (error) {
        await adapter.setConnected(false);
        adapter.logAxiosError('Token request failed', error);
        logIamHints(adapter, error.response && error.response.data);
        return false;
    }
}

/**
 * Exchanges the refresh token for a new access token. The IAM may or may not
 * return a new refresh token, so the response is merged into the session.
 * Transient failures (network, 5xx) retry the refresh; a rejected refresh
 * token triggers a full relogin.
 *
 * @param {Record<string, any>} adapter
 * @returns {Promise<void>}
 */
async function refreshToken(adapter) {
    if (!adapter.session || !adapter.session.refresh_token) {
        adapter.session = {};
        adapter.scheduleRelogin();
        return;
    }
    try {
        const res = await adapter.requestClient.request({
            method: 'post',
            url: `${IAM_BASE_URL}/token`,
            headers: { Accept: 'application/json', 'User-Agent': adapter.userAgent },
            data: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: adapter.config.client_id,
                refresh_token: adapter.session.refresh_token,
            }),
        });
        adapter.log.debug(stringifyForLog(res.data));
        adapter.session = { ...adapter.session, ...res.data };
        await adapter.setConnected(true);
        adapter.scheduleTokenRefresh();
    } catch (error) {
        adapter.logAxiosError('Refresh token request failed', error);
        const status = error && error.response && error.response.status;
        if (!status || status >= 500) {
            adapter.log.info(
                `Token refresh failed temporarily. Retrying in ${TOKEN_REFRESH_RETRY_DELAY_MS / 1000} seconds`,
            );
            adapter.scheduleTokenRefresh(TOKEN_REFRESH_RETRY_DELAY_MS);
            return;
        }
        adapter.session = {};
        await adapter.setConnected(false);
        adapter.scheduleRelogin();
    }
}

module.exports = {
    TOKEN_REFRESH_EXPIRY_BUFFER_SECONDS,
    MIN_TOKEN_REFRESH_DELAY_MS,
    TOKEN_REFRESH_RETRY_DELAY_MS,
    RELOGIN_DELAY_MS,
    RELOGIN_MAX_DELAY_MS,
    OAUTH_SCOPE,
    getCodeChallenge,
    getCodeFromLocation,
    getTokenRefreshDelayMs,
    clearAuthTimers,
    scheduleTokenRefresh,
    scheduleRelogin,
    login,
    refreshToken,
};
