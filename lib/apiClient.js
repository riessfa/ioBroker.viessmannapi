'use strict';

const axios = require('axios').default;
const rax = require('retry-axios');

function createApiClient() {
  const client = axios.create({ timeout: 30000 });
  client.defaults.raxConfig = {
    retry: 0,
    statusCodesToRetry: [[500, 599]],
    httpMethodsToRetry: ['POST'],
  };
  const retryInterceptorId = rax.attach(client);
  return { client, retryInterceptorId };
}

module.exports = { createApiClient };
