/**
 * Resolve a data-file path (charter, fixture) for both ways the Steward runs:
 * from a repo checkout, where `charters/…` and `fixtures/…` sit in the cwd,
 * and from an npm install, where they ship inside the package.
 *
 * An absolute path, or a relative one that exists from the cwd, is used as
 * given, so a user's own charter always wins. Otherwise the path is tried
 * against the package root (one level above dist/ or src/). If neither
 * exists, the original path is returned so the caller's error names what
 * the user asked for.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export function resolveAsset(path: string, root: string = PACKAGE_ROOT): string {
  if (isAbsolute(path) || existsSync(path)) return path;
  const bundled = join(root, path);
  return existsSync(bundled) ? bundled : path;
}
