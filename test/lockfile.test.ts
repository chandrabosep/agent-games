import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Render builds with npm 10, whose `npm ci` fails ("Invalid Version") on lockfile
// entries without a version; npm 11 writes them for some optional platform binaries.
it('lockfile has no versionless package entries (npm 10 / Render build)', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string; link?: boolean }>;
  };
  const bad = Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && !entry.version && !entry.link)
    .map(([path]) => path);
  expect(bad).toEqual([]);
});
