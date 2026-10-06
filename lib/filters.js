'use strict';

/**
 * Splits a comma-separated config value into trimmed, non-empty entries.
 *
 * @param {any} value
 * @returns {string[]}
 */
function parseList(value) {
    if (typeof value !== 'string') {
        return [];
    }
    return value
        .split(',')
        .map(entry => entry.replace(/\s/g, ''))
        .filter(entry => entry);
}

/**
 * Compiles the feature filter config into a predicate. Patterns are exact
 * feature names or prefixes ending with `*` (`heating.*` matches `heating`,
 * `heating.boiler`, ...).
 *
 * @param {any} value Comma-separated patterns
 * @returns {((feature: string) => boolean) | null} null when no filter is configured
 */
function compileFeatureFilter(value) {
    const patterns = parseList(value);
    if (patterns.length === 0) {
        return null;
    }
    const exact = new Set();
    const prefixes = [];
    for (const pattern of patterns) {
        if (pattern.endsWith('*')) {
            let prefix = pattern.slice(0, -1);
            if (prefix.endsWith('.')) {
                prefix = prefix.slice(0, -1);
            }
            if (prefix === '') {
                // a bare "*" matches everything
                return null;
            }
            prefixes.push(prefix);
        } else {
            exact.add(pattern);
        }
    }
    return feature =>
        exact.has(feature) || prefixes.some(prefix => feature === prefix || feature.startsWith(`${prefix}.`));
}

module.exports = { parseList, compileFeatureFilter };
