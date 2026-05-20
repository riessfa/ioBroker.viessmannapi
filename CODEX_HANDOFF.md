# Codex Handoff — Deferred Production-Readiness Items

This file lists work intentionally **not** included in the production-readiness
sweep on `claude/production-readiness-check-O6qRX`
(commits `3fc696c`, `c88f71a`). Each item below is independent — pick any in any
order. None are blocking; the adapter is shippable as-is.

For project conventions, architecture, and how to run lint/check/tests, see
`AGENT.md`.

---

## 1. Translation quality in existing dictionary entries

**File:** `admin/words.js`
**Why deferred:** Needs native-speaker review. Machine-rewriting these is
likely to make them worse, not better.

Known issues in the `'Allowlist of IDs which allow to update to prevent rate limit with ViCare Einzelraumsteuerung. Example: 0,HeatDemandControl'` entry (currently around lines 54–67):

- **`nl`** ends with `"Vertaling:"` — a stub leftover from an unfinished
  translation. Replace with a real Dutch sentence covering "allowlist of IDs
  that may be updated, to avoid the ViCare per-room-control rate limit".
- **`pl`** starts with the English word `"Allowlist"` rather than a Polish
  translation. Replace with proper Polish.
- **`zh-cn`** contains garbled text (`"维克雷·埃斯利拉姆特森松"`,
  `"例:00"`). Rewrite with a real Chinese translation; "ViCare
  Einzelraumsteuerung" is a German product name and can stay verbatim or be
  rendered as "ViCare 单房间控制".
- **`uk`** is present on this one entry but absent on every other entry. Either
  add `uk` to all five other entries for consistency, or remove it from this
  one. Don't leave it half-applied.

Don't translate by free text — match the structure of the English string
(comma-separated list, example token).

## 2. Tests covering the wrapped polling callbacks

**Files:** `main.test.js` (add tests), `main.js` lines 120–133 and 763–769
(behavior under test)
**Why deferred:** The try/catch wrappers in commit `c88f71a` are purely
additive; the existing 42-test suite still exercises the happy path. A
regression test isn't required, but would be cheap insurance.

Suggested test cases:

- Stub `updateDevices` to reject. Fire the interval callback (advance fake
  timers). Assert no `unhandledRejection` event is emitted and that
  `this.log.error` was called with the prefix `"updateDevices interval failed:"`.
- Same for `getEvents` interval and the post-command refresh setTimeout
  (`"getEvents interval failed:"`, `"refresh updateDevices failed:"`).

Use the existing `sinon`/`mocha` setup in `main.test.js`; the auth-timer
tests (search for `clearAuthTimers` / `scheduleTokenRefresh`) are a good
template.

## 3. JSDoc on the extracted lib/ modules

**Files:** `lib/apiClient.js`, `lib/auth.js`, `lib/extractKeys.js`,
`lib/safeLog.js`, `lib/tools.js`
**Why deferred:** Code is short and self-documenting after recent refactors.
TypeScript's `checkJs` already validates type usage at call sites.

If you do this, add `@param` / `@returns` only — no narrative docstrings, no
"this function does X" prose. Match the style of existing JSDoc in `main.js`
(constructor at line 34, `onReady` at line 84). Skip private helpers.

## 4. README screenshots of the admin config UI

**File:** `README.md`
**Why deferred:** Optional polish; adapter is functional without.

Add one screenshot of the admin config dialog (after `npm install` in
ioBroker) showing the Client ID / Username / Password fields, plus one of the
Viessmann developer portal step where the user creates the client. Place
images in `admin/` (or `docs/`) and reference them in both the German and
English sections of the README.

## 5. Troubleshooting section in README

**File:** `README.md`
**Why deferred:** Out of scope for production-readiness; nice-to-have.

Add a "Troubleshooting" subsection covering the failures users actually
report:

- **"Cannot find clientId in the viessmann Account"** — wait 15 min after
  creating a new client (mentioned in code at `main.js` line 170).
- **"Invalid redirection URI"** — redirect URI must be
  `http://localhost:4200/` with the trailing slash (`main.js` line 177).
- **`429 Too Many Requests`** — Viessmann daily rate limit; resets at 02:00
  the next day. Recommend the user reduce polling frequency (`interval`,
  `eventInterval`) or use the `devicelist` / `featureFilter` settings to
  narrow the request surface.
- **Token refresh failing repeatedly** — the adapter automatically falls back
  to a full re-login after 1 minute (see `lib/auth.js`
  `scheduleRelogin`).

## 6. npm audit findings (dev dependencies)

**Command to reproduce:** `npm audit --audit-level=moderate`
**Why deferred:** All 9 findings (1 low / 5 moderate / 3 high as of writing)
are in transitive dev dependencies (`mocha` → `glob` → `minimatch`,
`mocha` → `serialize-javascript`, `@alcalzone/release-script` → 
`@alcalzone/esbuild-register`). They don't ship in the npm package and don't
run in user environments.

CI runs `npm audit --audit-level=moderate` in the `dependency-audit` job
(`.github/workflows/test-and-release.yml`). **Verify this job is actually
passing on the current main branch** — if it is, the findings may be
suppressed or limited to production deps in a way I missed. If it's failing,
either:

- Run `npm audit fix` for the non-breaking subset, then evaluate the
  remaining `--force` candidates one at a time (notably bumping `mocha` and
  `@iobroker/testing` to current majors), **or**
- Add `--omit=dev` to the CI audit command to scope it to production
  dependencies only and re-evaluate.

Don't blindly `npm audit fix --force` — it will install
`@iobroker/testing@5.0.4` and other breaking majors.

## 7. Enable automated npm publishing

**File:** `.github/workflows/test-and-release.yml` (the commented-out
`deploy` job)
**Why deferred:** Requires a repository admin action (adding the
`NPM_TOKEN` secret), not a code change.

Once the maintainer adds `NPM_TOKEN` to repository secrets, uncomment the
`deploy` job. The `@alcalzone/release-script` plus its `iobroker`, `manual-review`,
and `license` plugins are already configured (`.releaseconfig.json`,
`package.json` `release` script). `npm run release patch` will then bump the
version, update `io-package.json` `news`, tag, and push.

The fixes on the current branch are the obvious starting point for `2.5.1`.

---

## How to claim an item

Open a small PR per item. Reference this file and the item number in the PR
description. Keep each PR scoped to a single item — items 1, 2, and 3
especially must not be bundled, because they touch disjoint review
disciplines (translations, tests, JSDoc).
