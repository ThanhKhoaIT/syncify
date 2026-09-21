import { loadRc, saveRc, SyncifyRc } from '../config.js';
import { logger } from '../logger.js';

const ARRAY_KEYS = ['resources', 'guard.allowedDestinations', 'guard.allowedDevPlanNames', 'themeIgnorePatterns'];

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((acc, key) => (acc[key] ??= {}), obj);
  target[last] = value;
}

export function runConfigList(): void {
  const rc = loadRc();
  logger.info(JSON.stringify(rc, null, 2));
}

export function runConfigGet(key: string): void {
  const rc = loadRc();
  const value = getPath(rc, key);
  if (value === undefined) {
    logger.error(`No such config key: ${key}`);
    return;
  }
  logger.info(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function runConfigSet(key: string, rawValue: string): void {
  const rc = loadRc();
  const value = ARRAY_KEYS.includes(key) ? rawValue.split(',').map((v) => v.trim()) : rawValue;

  setPath(rc, key, value);
  saveRc(rc as SyncifyRc);
  logger.success(`Set ${key} = ${JSON.stringify(value)}`);
}
