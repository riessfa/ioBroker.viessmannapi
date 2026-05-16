# AGENT.md — ioBroker.viessmannapi

> Guidance for AI coding agents (GitHub Copilot, OpenAI Codex, Claude Code, Cursor, etc.)

## Project Overview

- **Name:** ioBroker.viessmannapi (npm: `iobroker.viessmannapi`)
- **Purpose:** ioBroker adapter that connects the Viessmann Developer Cloud API to ioBroker home automation. Monitors and controls Viessmann heating/climate systems (boilers, heat pumps, DHW cylinders, solar collectors, ventilation) via polling. Used for home automation flows and data logging.
- **Language:** JavaScript (Node.js), type-checked with TypeScript (`allowJs` + `checkJs`, no compilation step)
- **License:** MIT
- **Original author:** TA2k
- **Current maintainer:** riessfa
- **Fork status:** Maintained fork of `TA2k/ioBroker.viessmannapi`; preserve npm package name for ioBroker compatibility.

## Architecture and Key Files

### Core

```
main.js                   Entry point. Class Viessmannapi extends utils.Adapter.
                          OAuth PKCE login, token refresh, device discovery,
                          feature polling, event polling, command dispatch.
lib/extractKeys.js        Dynamic mapping of Viessmann API JSON responses to
                          ioBroker object/state trees. Auto-creates channels,
                          states, and writable setValue objects from API metadata.
lib/tools.js              Utility helpers (isObject, isArray, translateText).
```

### Admin UI

```
admin/index_m.html        Materialize CSS configuration UI for adapter instances.
admin/words.js            i18n translation strings (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn).
admin/style.css           Admin UI styles.
```

### Tests

```
main.test.js              Primary tests (Mocha + Chai + Sinon): retry-axios
                          interceptor, extractKeys unit tests, auth timer handling,
                          sensitive-data log redaction.
test/unit.js              @iobroker/testing unit test harness.
test/integration.js       @iobroker/testing integration test harness.
test/package.js           @iobroker/testing package validation.
test/mocha.setup.js       Mocha setup: chai-as-promised, sinon-chai, should interface.
test/mocharc.custom.json  Mocha config for the custom test suite.
```

### Configuration

```
io-package.json           ioBroker adapter metadata, native config defaults, Sentry config.
package.json              npm metadata, scripts, dependencies.
tsconfig.json             Root TypeScript config for editor support and type checking.
tsconfig.check.json       Extends tsconfig.json for CI type checking.
eslint.config.cjs         ESLint flat config (eslint:recommended + custom rules).
.prettierrc.js            Prettier config.
```

### CI

```
.github/workflows/test-and-release.yml
  - check-and-lint: ESLint + TypeScript checking + package validation
  - adapter-tests: matrix of Node 20/22/24 x Ubuntu/Windows/macOS
```

## Development Setup

```bash
git clone <repo-url>
cd ioBroker.viessmannapi
npm ci
```

- **Node.js >=20 <25** required (see `engines` in package.json); CI covers Node.js 20, 22, and 24.
- No build step — JavaScript source runs directly
- TypeScript is used only for type checking, not compilation

## Build, Lint, Test Commands

| Command                    | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `npm run lint`             | ESLint with flat config                                   |
| `npm run check`            | TypeScript type checking (`tsc --noEmit`)                 |
| `npm run test:js`          | Mocha: main.test.js (retry, extractKeys, auth, redaction) |
| `npm run test:package`     | @iobroker/testing: package structure validation           |
| `npm run test:unit`        | @iobroker/testing: adapter unit tests                     |
| `npm run test:integration` | @iobroker/testing: adapter integration tests              |
| `npm run test`             | Runs `test:js` then `test:package`                        |

**Run before committing:** `npm run lint && npm run check && npm run test`

## Code Conventions and Style

### Formatting (Prettier)
- 2-space indent, no tabs
- Single quotes, semicolons always
- 120-character line width
- Trailing commas (`all`)
- LF line endings

### Linting (ESLint)
- `eslint:recommended` base
- `no-var` — use `const` / `let` only
- `prefer-const` enforced
- Unused variables error (rest siblings ignored, `_`-prefixed args ignored)
- No trailing spaces
- Single quotes (with `avoidEscape` and `allowTemplateLiterals`)

### Type Checking (TypeScript)
- `strict: true` with `noImplicitAny: false`
- Types via JSDoc annotations (`@param {string}`, `@returns {Promise<void>}`)
- Target: ES2018, Module: CommonJS

### General Conventions
- CommonJS modules (`require` / `module.exports`), not ES modules
- `'use strict';` at top of every JS file
- Prefer `async/await` over raw `.then()` chains
- Sensitive data (tokens, passwords, client IDs) must never appear in logs — use `sanitizeForLog()` / `stringifyForLog()` / `logAxiosError()` from `main.js`
- `SENSITIVE_LOG_KEYS` set in `main.js` defines which fields get redacted: `authorization`, `access_token`, `refresh_token`, `client_id`, `password`, `code`

## ioBroker Adapter Conventions

### Object Hierarchy
- Separator: `"."` — objects form a tree: `adapter.instance.device.channel.state`
- Types: `device` > `channel` > `state`
- Use `setObjectNotExistsAsync()` to create objects only if they don't already exist

### State Semantics
- `val` — the actual value
- `ack: false` — command (written by user/script to trigger an action)
- `ack: true` — confirmed status (written by the adapter after reading from API)
- `ts` — timestamp, `lc` — last change, `from` — originating adapter instance

### Adapter Lifecycle (daemon mode)
- **`onReady()`** — DB connected and config loaded. Perform login, start polling.
- **`onStateChange(id, state)`** — Subscribed state changed. If `!state.ack`, it's a user command to process.
- **`onUnload(callback)`** — Shutdown. **Must** clear ALL timers, intervals, connections and call `callback()`.

### State Roles (used in `extractKeys.js`)
- `indicator` — read-only boolean
- `switch` — writable boolean
- `value` — read-only number
- `level` — writable number
- `text` — string
- `state` — fallback

### Compact Mode
- Adapter is compact-mode compatible
- Exports a factory function when `require.main !== module`

### Config Fields (`io-package.json` native)

| Field           | Type    | Default | Description                                            |
| --------------- | ------- | ------- | ------------------------------------------------------ |
| `username`      | string  | `""`    | Viessmann account email                                |
| `password`      | string  | `""`    | Viessmann account password (encrypted in storage)      |
| `client_id`     | string  | `""`    | OAuth client ID from Viessmann Developer Portal (encrypted) |
| `interval`      | number  | `5`     | Feature polling interval in minutes (min 0.5)          |
| `eventInterval` | number  | `300`   | Event polling interval in minutes (min 0.5)            |
| `gatewayIndex`  | number  | `1`     | Which gateway to use if multiple (1-based)             |
| `devicelist`    | string  | `""`    | Comma-separated device ID allowlist                    |
| `featureFilter` | string  | `""`    | Comma-separated feature path filter (wildcard `*` supported) |
| `allowVirtual`  | boolean | `false` | Include virtual devices (e.g. room controls)           |

## Viessmann API Integration Details

### Authentication (OAuth 2.0 PKCE)
1. Generate 64-char random hex code verifier, SHA-256 hash as base64url code challenge
2. `GET /idp/v3/authorize` with Basic auth (username:password), code challenge, scope `IoT User offline_access`, redirect URI `http://localhost:4200/`
3. Extract authorization code from redirect URL
4. `POST /idp/v3/token` to exchange code for access + refresh tokens
- IAM base: `https://iam.viessmann-climatesolutions.com`

### Token Refresh
- Scheduled `(expires_in - 100) * 1000` ms before expiry
- On 401 during polling: retry refresh in 30s
- On refresh failure: full re-login in 60s
- `clearAuthTimers()` prevents timer accumulation on re-scheduling

### API Endpoints
- **Base:** `https://api.viessmann-climatesolutions.com`
- **Installations:** `GET /iot/v2/equipment/installations?includeGateways=true`
- **Features:** `GET /iot/v2/features/installations/{id}/gateways/{serial}/devices/{deviceId}/features`
- **Events:** `GET /iot/v2/events-history/installations/{id}/events`
- **Commands:** `POST` to the URI stored in the feature's `.uri` state

### Rate Limits
- **1450 calls per 24 hours** (free tier), **3000** (advanced tier)
- Resets daily at **02:00 UTC**
- HTTP 429 response when exceeded — adapter logs warning and continues with stale data
- Mitigations: configurable polling interval, feature filter with wildcards, device allowlist

### Command Dispatch (`onStateChange`)
- Only processes states whose path contains `.setValue`
- Reads the command URI from the sibling `.uri` state
- Reads parameter metadata from `.setValue` object's `common.param`
- Single param: sends `{ paramName: value }`
- Multi param: expects JSON string input, sends parsed object
- POST retry: 5 retries, 5s static backoff, only on 500-599 status, POST method only
- After successful command: polls updated features after 10s delay

### Feature Filtering
- `featureFilter` config accepts comma-separated patterns
- `heating.boiler.*` matches `heating.boiler` and all children
- Exact match also supported: `heating.dhw.temperature`
- Reduces API response processing and ioBroker object count

## Key Design Patterns

### Dynamic Object Tree (`extractKeys`)
- Recursively walks any JSON structure and creates matching ioBroker object hierarchy
- Arrays: indexed with zero-padded numbers (`01`, `02`, ...) or use element's `id`/`name`/`feature` field as path segment
- `forceIndex: true` disables smart naming — uses numeric indices (used for events)
- When `isExecutable: true` found: creates a writable `setValue` state with param constraints (min/max/enum) from API metadata
- JSON strings auto-parsed and recursively extracted
- Objects cached in `alreadyCreatedObjects` map to skip redundant `setObjectNotExistsAsync` calls
- `json-bigint` used to safely parse responses with large numeric IDs

### Sensitive Data Handling
- `SENSITIVE_LOG_KEYS` set defines redacted fields
- `sanitizeForLog()` — recursively redacts sensitive keys in objects
- `sanitizeUrlForLog()` — strips query parameters from URLs
- `sanitizeStringForLog()` — regex-replaces inline tokens/bearer values
- `logAxiosError()` — consistent redacted error logging for all HTTP failures

### Retry Strategy
- `retry-axios` interceptor attached at construction, default retries disabled (`retry: 0`)
- Only command POSTs configure per-request retries: 5 retries, 5s static backoff, 500-599 only
- GET requests never retry
- Non-command POSTs (token requests) use default `retry: 0`

### Timer Management
- `clearAuthTimers()` — clears `refreshTokenTimeout`, `refreshTokenInterval`, `reLoginTimeout`
- `clearPollingTimers()` — clears `updateInterval`, `eventInterval`
- `onUnload()` — calls both, also detaches retry interceptor
- Auth timers always cleared before scheduling new ones to prevent accumulation

## Developer Resources

### ioBroker
- [ioBroker Developer Portal](https://www.iobroker.dev/)
- [ioBroker Dev Docs](https://iobroker.github.io/dev-docs/)
- [Adapter Development Guide](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterdev.md)
- [Objects Schema Reference](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/objectsschema.md)
- [State Roles Reference](https://iobroker.github.io/dev-docs/concepts/02-state-roles/)
- [create-adapter CLI Tool](https://github.com/ioBroker/create-adapter)
- [@iobroker/testing](https://github.com/ioBroker/testing)
- [ioBroker Adapter Checker](https://github.com/ioBroker/ioBroker.repochecker)

### Viessmann
- [Viessmann Developer Portal](https://developer.viessmann-climatesolutions.com)
- [API Products Overview](https://developer.viessmann-climatesolutions.com/start/api-products.html)
- [Developer App Console](https://app.developer.viessmann-climatesolutions.com/) — create OAuth client IDs here
- [Data Points Reference](https://documentation.viessmann.com/static/iot/data-points)
- [Device Compatibility List](https://documentation.viessmann.com/static/compatibility)
- [Viessmann API Community Forum](https://www.viessmann-community.com/t5/The-Viessmann-API/bd-p/dev-viessmann-api)

### Platform Requirements
- Node.js >=20 <25
- js-controller >= 7.0.7
- admin >= 7.7.2
