//v3.0viessmannapi
const JSONbig = require('json-bigint')({ storeAsString: true });
const alreadyCreatedObjects = {};
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
      adapter.log.debug('Cannot extract empty: ' + path);
      return;
    }

    const objectKeys = Object.keys(element);

    if (!write) {
      write = false;
    }
    path = path.replace(/;/g, '_');
    if (typeof element === 'string' || typeof element === 'number' || typeof element === 'boolean') {
      let name = element;
      if (typeof element === 'number') {
        name = element.toString();
      }
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
          .catch((error) => {
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
        .catch((error) => {
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
        (path + '.' + key).indexOf('.entries.value') === -1
      ) {
        await extractKeys(adapter, path + '.' + key, element[key], preferredArrayName, forceIndex, write);
      } else {
        let type = /** @type {string} */ (typeof element[key]);
        key = key.replace(/\./g, '_').replace(/;/g, '_');
        if ((path + '.' + key).indexOf('.entries.value') !== -1) {
          const entries = await adapter.getObjectAsync(path + '.' + key);
          if (entries) {
            if (!entries.common.type) {
              adapter.log.debug(path);
              await adapter.delObjectAsync(path + '.' + key, { recursive: true });
            }
          }
          element[key] = JSON.stringify(element[key]);
          type = 'json';
        }
        if (!alreadyCreatedObjects[path + '.' + key]) {
          await adapter
            .setObjectNotExistsAsync(path + '.' + key, {
              type: 'state',
              common: {
                name: key,
                role: getRole(element[key], write),
                type: type,
                write: write,
                read: true,
              },
              native: {},
            })
            .then(() => {
              alreadyCreatedObjects[path + '.' + key] = true;
            })
            .catch((error) => {
              adapter.log.error(error);
            });
          if (key === 'isExecutable') {
            const setStatePath = path + '.setValue';
            const common = /** @type {any} */ ({
              name: 'Einstellungen sind hier änderbar / You can change the settings here',
              role: 'value',
              type: 'mixed',
              write: true,
              read: true,
              param: '',
            });

            if (element.params && Object.keys(element.params).length > 0) {
              if (Object.keys(element.params).length > 1) {
                common.param = [];
                common.type = 'object';
                for (const param of Object.keys(element.params)) {
                  const curparam = {
                    param: param,
                    type: 'mixed',
                  };

                  if (element.params[param] && element.params[param].type === 'number') {
                    curparam.type = 'number';
                  }
                  if (element.params[param] && element.params[param].constraints) {
                    const constrains = element.params[param].constraints;
                    if (constrains.min) {
                      curparam.min = constrains.min;
                    }
                    if (constrains.max) {
                      curparam.max = constrains.max;
                    }
                    if (constrains.enum) {
                      curparam.states = {};
                      for (const cenum of constrains.enum) {
                        curparam.states[cenum] = cenum;
                      }
                    }
                  }
                  common.param.push(curparam);
                }
              } else {
                const param = Object.keys(element.params)[0];
                common.param = param;
                if (element.params[param] && element.params[param].type === 'number') {
                  common.type = 'number';
                }
                if (element.params[param] && element.params[param].constraints) {
                  const constrains = element.params[param].constraints;
                  if (constrains.min) {
                    common.min = constrains.min;
                  }
                  if (constrains.max) {
                    common.max = constrains.max;
                  }
                  if (constrains.enum) {
                    common.states = {};
                    for (const cenum of constrains.enum) {
                      common.states[cenum] = cenum;
                    }
                  }
                }
              }
            }
            await adapter.setObjectNotExistsAsync(setStatePath, {
              type: 'state',
              common: common,
              native: {},
            });
          }
        }
        await setStateAsync(adapter, path + '.' + key, element[key], true);
      }
    }
  } catch (error) {
    adapter.log.error('Error extract keys: ' + path + ' ' + JSON.stringify(element));
    adapter.log.error(error);
  }
}
async function extractArray(adapter, element, key, path, write, preferredArrayName, forceIndex) {
  try {
    if (key) {
      element = element[key];
    }
    for (const [arrayIndex, arrayElement] of element.entries()) {
      let index = arrayIndex + 1;
      if (index < 10) {
        index = '0' + index;
      }
      let arrayPath = key + index;
      if (typeof arrayElement !== 'object' || arrayElement === null) {
        await extractKeys(adapter, path + '.' + key + '.' + arrayElement, arrayElement, preferredArrayName, forceIndex, write);
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
        const subName = Object.keys(arrayElement)[0] + ' ' + Object.keys(arrayElement)[1];
        if (key) {
          subKey = key + '.' + subKey;
        }
        if (!alreadyCreatedObjects[path + '.' + subKey]) {
          await adapter
            .setObjectNotExistsAsync(path + '.' + subKey, {
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
              alreadyCreatedObjects[path + '.' + subKey] = true;
            });
        }
        await setStateAsync(adapter, path + '.' + subKey, subValue, true);
        continue;
      }
      await extractKeys(adapter, path + '.' + arrayPath, arrayElement, preferredArrayName, forceIndex, write);
    }
  } catch (error) {
    adapter.log.error('Cannot extract array ' + path);
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
