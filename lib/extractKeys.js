'use strict';

const JSONbig = require('json-bigint')({ storeAsString: true });

/**
 * Returns the per-adapter cache of already created object paths. Keeping the
 * cache on the adapter instance (instead of module scope) avoids collisions
 * between adapter instances in compact mode and lets it be garbage-collected
 * with the adapter.
 *
 * @param {Record<string, any>} adapter
 * @returns {Record<string, boolean>}
 */
function getCreatedObjectsCache(adapter) {
    if (!adapter._createdObjectsCache) {
        adapter._createdObjectsCache = {};
    }
    return adapter._createdObjectsCache;
}
/**
 * @param {Record<string, any>} adapter
 * @param {string} path
 * @param {any} element
 * @param {string} [preferredArrayName]
 * @param {boolean} [forceIndex]
 * @param {boolean} [write]
 * @param {string} [channelName]
 * @returns {Promise<void>}
 */
async function extractKeys(adapter, path, element, preferredArrayName, forceIndex, write, channelName) {
    try {
        if (element === null || element === undefined) {
            adapter.log.debug(`Cannot extract empty: ${path}`);
            return;
        }
        const alreadyCreatedObjects = getCreatedObjectsCache(adapter);

        const objectKeys = Object.keys(element);

        if (!write) {
            write = false;
        }
        path = sanitizeId(adapter, path);
        if (typeof element === 'string' || typeof element === 'number' || typeof element === 'boolean') {
            const name = path.split('.').pop() || path;
            if (!alreadyCreatedObjects[path]) {
                await adapter
                    .setObjectNotExistsAsync(path, {
                        type: 'state',
                        common: {
                            name: name,
                            role: getRole(element, write),
                            type: typeof element,
                            write: write,
                            read: true,
                        },
                        native: {},
                    })
                    .then(() => {
                        alreadyCreatedObjects[path] = true;
                    })
                    .catch(error => {
                        adapter.log.error(error);
                    });
            }

            await setStateAsync(adapter, path, element, true);
            return;
        }
        if (!alreadyCreatedObjects[path]) {
            await adapter
                .setObjectNotExistsAsync(path, {
                    type: 'channel',
                    common: {
                        name: channelName || '',
                        write: false,
                        read: true,
                    },
                    native: {},
                })
                .then(() => {
                    alreadyCreatedObjects[path] = true;
                })
                .catch(error => {
                    adapter.log.error(error);
                });
        }
        if (Array.isArray(element)) {
            await extractArray(adapter, element, '', path, write, preferredArrayName, forceIndex);
            return;
        }
        for (let key of objectKeys) {
            if (isJsonString(element[key])) {
                element[key] = JSONbig.parse(element[key]);
            }

            if (Array.isArray(element[key])) {
                await extractArray(adapter, element, key, path, write, preferredArrayName, forceIndex);
            } else if (
                element[key] !== null &&
                typeof element[key] === 'object' &&
                `${path}.${key}`.indexOf('.entries.value') === -1
            ) {
                await extractKeys(adapter, `${path}.${key}`, element[key], preferredArrayName, forceIndex, write);
            } else {
                let value = element[key];
                key = sanitizeId(adapter, key.replace(/\./g, '_'));
                const statePath = `${path}.${key}`;
                if (statePath.indexOf('.entries.value') !== -1) {
                    value = JSON.stringify(value);
                    if (!alreadyCreatedObjects[statePath]) {
                        // extendObject also repairs objects created with the invalid type "json" by older versions
                        await adapter.extendObjectAsync(statePath, {
                            type: 'state',
                            common: { name: key, role: 'json', type: 'string', write: write, read: true },
                            native: {},
                        });
                        alreadyCreatedObjects[statePath] = true;
                    }
                } else if (!alreadyCreatedObjects[statePath]) {
                    await adapter
                        .setObjectNotExistsAsync(statePath, {
                            type: 'state',
                            common: {
                                name: key,
                                role: getRole(value, write),
                                type: typeof value,
                                write: write,
                                read: true,
                            },
                            native: {},
                        })
                        .then(() => {
                            alreadyCreatedObjects[statePath] = true;
                        })
                        .catch(error => {
                            adapter.log.error(error);
                        });
                    if (key === 'isExecutable') {
                        await createSetValueObject(adapter, path, element.params);
                    }
                }
                await setStateAsync(adapter, statePath, value, true);
            }
        }
    } catch (error) {
        adapter.log.error(`Error extract keys: ${path} ${JSON.stringify(element)}`);
        adapter.log.error(error);
    }
}
/**
 * Replaces characters that are not allowed in ioBroker object IDs.
 *
 * @param {Record<string, any>} adapter
 * @param {string} id
 * @returns {string}
 */
function sanitizeId(adapter, id) {
    const forbidden = adapter.FORBIDDEN_CHARS || /[\][*,;'"`<>\\?]/g;
    return id.replace(/;/g, '_').replace(forbidden, '_');
}

/**
 * Converts a Viessmann command parameter definition into a validation spec.
 *
 * @param {string} name
 * @param {any} definition `{ type, required, constraints: { min, max, stepping, enum } }`
 * @returns {Record<string, any>}
 */
function getParamSpec(name, definition) {
    const spec = { param: name, type: 'mixed' };
    if (!definition) {
        return spec;
    }
    if (definition.type === 'number' || definition.type === 'boolean') {
        spec.type = definition.type;
    }
    if (definition.required === false) {
        spec.required = false;
    }
    const constraints = definition.constraints;
    if (constraints) {
        if (typeof constraints.min === 'number') {
            spec.min = constraints.min;
        }
        if (typeof constraints.max === 'number') {
            spec.max = constraints.max;
        }
        if (typeof constraints.stepping === 'number' && constraints.stepping > 0) {
            spec.step = constraints.stepping;
        }
        if (Array.isArray(constraints.enum)) {
            spec.states = {};
            for (const value of constraints.enum) {
                spec.states[value] = value;
            }
        }
    }
    return spec;
}

/**
 * Creates (or updates) the writable `setValue` state of a command. The object
 * is extended once per adapter run so that changed constraints are picked up.
 *
 * @param {Record<string, any>} adapter
 * @param {string} path Command channel path
 * @param {any} params Command parameter definitions from the API
 */
async function createSetValueObject(adapter, path, params) {
    const common = /** @type {Record<string, any>} */ ({
        name: 'Einstellungen sind hier änderbar / You can change the settings here',
        role: 'state',
        type: 'mixed',
        write: true,
        read: true,
        param: '',
    });
    const names = params ? Object.keys(params) : [];
    if (names.length > 1) {
        common.param = names.map(name => getParamSpec(name, params[name]));
        common.type = 'string';
        common.role = 'json';
    } else if (names.length === 1) {
        const spec = getParamSpec(names[0], params[names[0]]);
        Object.assign(common, spec);
        if (spec.type === 'number') {
            common.role = 'level';
        } else if (spec.type === 'boolean') {
            common.role = 'switch';
        }
    }
    try {
        await adapter.extendObjectAsync(`${path}.setValue`, { type: 'state', common: common, native: {} });
    } catch (error) {
        adapter.log.error(error);
    }
}
async function extractArray(adapter, element, key, path, write, preferredArrayName, forceIndex) {
    try {
        const alreadyCreatedObjects = getCreatedObjectsCache(adapter);
        if (key) {
            element = element[key];
        }
        for (const [arrayIndex, arrayElement] of element.entries()) {
            let index = arrayIndex + 1;
            if (index < 10) {
                index = `0${index}`;
            }
            let arrayPath = key + index;
            if (typeof arrayElement !== 'object' || arrayElement === null) {
                const primitivePath = key ? `${path}.${key}.${arrayElement}` : `${path}.${arrayElement}`;
                await extractKeys(adapter, primitivePath, arrayElement, preferredArrayName, forceIndex, write);
                continue;
            }
            if (typeof arrayElement[Object.keys(arrayElement)[0]] === 'string') {
                arrayPath = arrayElement[Object.keys(arrayElement)[0]];
            }
            for (const keyName of Object.keys(arrayElement)) {
                if (keyName.endsWith('Id')) {
                    if (arrayElement[keyName] && arrayElement[keyName].replace) {
                        arrayPath = arrayElement[keyName].replace(/\./g, '');
                        arrayPath = arrayPath.replace(/;/g, '_');
                    } else {
                        arrayPath = arrayElement[keyName];
                    }
                }
            }
            for (const keyName of Object.keys(arrayElement)) {
                if (keyName.endsWith('Name')) {
                    arrayPath = arrayElement[keyName];
                }
            }

            if (arrayElement.id) {
                if (arrayElement.id.replace) {
                    arrayPath = arrayElement.id.replace(/\./g, '');
                    arrayPath = arrayPath.replace(/;/g, '_');
                } else {
                    arrayPath = arrayElement.id;
                }
            }
            if (arrayElement.name) {
                arrayPath = arrayElement.name.replace(/\./g, '');
                arrayPath = arrayPath.replace(/;/g, '_');
            }
            if (arrayElement.start_date_time) {
                arrayPath = arrayElement.start_date_time.replace(/\./g, '');
            }
            if (preferredArrayName && arrayElement[preferredArrayName]) {
                arrayPath = arrayElement[preferredArrayName]; //.replace(/\./g, "");
            }

            if (forceIndex) {
                arrayPath = key + index;
            }
            //special case array with 2 string objects
            if (
                !forceIndex &&
                Object.keys(arrayElement).length === 2 &&
                typeof Object.keys(arrayElement)[0] === 'string' &&
                typeof Object.keys(arrayElement)[1] === 'string' &&
                typeof arrayElement[Object.keys(arrayElement)[0]] !== 'object' &&
                typeof arrayElement[Object.keys(arrayElement)[1]] !== 'object' &&
                arrayElement[Object.keys(arrayElement)[0]] !== 'null'
            ) {
                let subKey = arrayElement[Object.keys(arrayElement)[0]];
                const subValue = arrayElement[Object.keys(arrayElement)[1]];
                const subName = `${Object.keys(arrayElement)[0]} ${Object.keys(arrayElement)[1]}`;
                if (key) {
                    subKey = `${key}.${subKey}`;
                }
                subKey = sanitizeId(adapter, String(subKey));
                if (!alreadyCreatedObjects[`${path}.${subKey}`]) {
                    await adapter
                        .setObjectNotExistsAsync(`${path}.${subKey}`, {
                            type: 'state',
                            common: {
                                name: subName,
                                role: getRole(subValue, write),
                                type: typeof subValue,
                                write: write,
                                read: true,
                            },
                            native: {},
                        })
                        .then(() => {
                            alreadyCreatedObjects[`${path}.${subKey}`] = true;
                        });
                }
                await setStateAsync(adapter, `${path}.${subKey}`, subValue, true);
                continue;
            }
            await extractKeys(adapter, `${path}.${arrayPath}`, arrayElement, preferredArrayName, forceIndex, write);
        }
    } catch (error) {
        adapter.log.error(`Cannot extract array ${path}`);
        adapter.log.error(error);
    }
}
async function setStateAsync(adapter, path, value, ack) {
    if (adapter.setStateAsync) {
        await adapter.setStateAsync(path, value, ack);
        return;
    }
    adapter.setState(path, value, ack);
}
function isJsonString(str) {
    if (typeof str !== 'string') {
        return false;
    }
    // Only treat object/array literals as JSON. Bare values like "123" or
    // "true" would also parse, but converting them flips state types.
    const firstChar = str.trim()[0];
    if (firstChar !== '{' && firstChar !== '[') {
        return false;
    }
    try {
        JSON.parse(str);
        // eslint-disable-next-line
    } catch (e) {
        return false;
    }
    return true;
}
function getRole(element, write) {
    if (typeof element === 'boolean' && !write) {
        return 'indicator';
    }
    if (typeof element === 'boolean' && write) {
        return 'switch';
    }
    if (typeof element === 'number' && !write) {
        return 'value';
    }
    if (typeof element === 'number' && write) {
        return 'level';
    }
    if (typeof element === 'string') {
        return 'text';
    }
    return 'state';
}
module.exports = {
    extractKeys,
};
