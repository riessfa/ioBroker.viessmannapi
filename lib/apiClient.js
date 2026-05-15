'use strict';

const axios = require('axios').default;
const rax = require('retry-axios');

function createApiClient() {
  const client = axios.create();
  client.defaults.raxConfig = {
    instance: client,
    retry: 0,
    statusCodesToRetry: [[500, 599]],
    httpMethodsToRetry: ['POST'],
  };
  const retryInterceptorId = rax.attach(client);
  return { client, retryInterceptorId };
}

module.exports = { createApiClient };
