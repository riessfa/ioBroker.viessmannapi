'use strict';

const axios = require('axios').default;

const IAM_BASE_URL = 'https://iam.viessmann-climatesolutions.com/idp/v3';
const API_BASE_URL = 'https://api.viessmann-climatesolutions.com';
const REDIRECT_URI = 'http://localhost:4200/';
const REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * Creates the axios instance used for all Viessmann requests. Every request
 * shares the given abort signal so in-flight requests are cancelled on unload.
 *
 * @param {AbortSignal} [signal]
 * @returns {import('axios').AxiosInstance}
 */
function createApiClient(signal) {
    return axios.create({ timeout: REQUEST_TIMEOUT_MS, signal });
}

/**
 * Sends a request and retries it on 5xx responses with a static delay.
 * Network errors and 4xx responses are not retried.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {import('axios').AxiosRequestConfig} config
 * @param {{ retries: number, delayMs: number, wait?: (ms: number) => Promise<void>, onRetry?: (attempt: number, error: any) => void }} options
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function requestWithRetry(client, config, options) {
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await client.request(config);
        } catch (error) {
            const status = error && error.response && error.response.status;
            if (attempt >= options.retries || !status || status < 500) {
                throw error;
            }
            options.onRetry && options.onRetry(attempt + 1, error);
            await wait(options.delayMs);
        }
    }
}

module.exports = {
    IAM_BASE_URL,
    API_BASE_URL,
    REDIRECT_URI,
    REQUEST_TIMEOUT_MS,
    createApiClient,
    requestWithRetry,
};
