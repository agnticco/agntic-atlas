/**
 * Single source of truth for the app version — read from package.json so a
 * `npm version` bump (or scripts/release.sh) updates every surface at once:
 * /health, the What's-New feature, and anything else that reports the version.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let _v;
export function appVersion() {
  if (_v) return _v;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    _v = pkg.version || '0.0.0';
  } catch { _v = '0.0.0'; }
  return _v;
}

export const APP_VERSION = appVersion();
