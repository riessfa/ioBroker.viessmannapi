'use strict';

const SENSITIVE_LOG_KEYS = new Set(['authorization', 'access_token', 'refresh_token', 'client_id', 'password', 'code']);
const REDACTED_LOG_VALUE = '[redacted]';

function sanitizeUrlForLog(value, pathOnly = false) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    const parsedUrl = new URL(value);
    return pathOnly ? parsedUrl.pathname : parsedUrl.origin + parsedUrl.pathname;
  } catch {
    const [path] = value.split('?');
    return path;
  }
}

function sanitizeStringForLog(value) {
  return value
    .replace(/([?&]?)(access_token|refresh_token|client_id|password|code)=([^&\s"']+)/gi, `$1$2=${REDACTED_LOG_VALUE}`)
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, `$1 ${REDACTED_LOG_VALUE}`)
    .replace(/https?:\/\/[^\s"']+/gi, (match) => sanitizeUrlForLog(match));
}

function sanitizeForLog(value, key = '') {
  if (value === null || value === undefined) {
    return value;
  }

  const normalizedKey = key.toLowerCase();
  if (SENSITIVE_LOG_KEYS.has(normalizedKey)) {
    return REDACTED_LOG_VALUE;
  }

  if (typeof value === 'string') {
    if (normalizedKey === 'url' || normalizedKey === '_currenturl' || normalizedKey === 'currenturl') {
      return sanitizeUrlForLog(value, true);
    }
    return sanitizeStringForLog(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry));
  }

  if (typeof value === 'object') {
    const sanitized = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeForLog(entryValue, entryKey);
    }
    return sanitized;
  }

  return value;
}

function stringifyForLog(value) {
  if (typeof value === 'string') {
    return sanitizeStringForLog(value);
  }

  try {
    return JSON.stringify(sanitizeForLog(value));
  } catch {
    return REDACTED_LOG_VALUE;
  }
}

module.exports = {
  SENSITIVE_LOG_KEYS,
  REDACTED_LOG_VALUE,
  sanitizeUrlForLog,
  sanitizeStringForLog,
  sanitizeForLog,
  stringifyForLog,
};
