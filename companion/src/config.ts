import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_DEFAULT_PORT, COMPANION_HOST } from '@protocol';

/** Where Nex Brain listens and keeps its files. Everything it writes stays under dataDir, mode 0700. */
export interface BrainConfig {
  host: typeof COMPANION_HOST;
  port: number;
  // ~/Library/Application Support/Avi Brain unless AVI_BRAIN_HOME says otherwise
  dataDir: string;
  // The companion package (package.json, the eve agent, node_modules)
  packageDir: string;
  version: string;
  // The Docker image every sandbox runs
  sandboxImage: string;
  // Nex Copilot may pair without a code (on unless AVI_BRAIN_AUTO_PAIR=0)
  autoPair?: boolean;
}

export const SANDBOX_IMAGE = 'avi-brain-sandbox:1';

function packageDirOf(): string {
  // src/config.ts in development and tests, dist/avi-brain.mjs when built: both sit one level down
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const packageDir = env.AVI_BRAIN_PACKAGE_DIR ?? packageDirOf();
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version ?? version;
  } catch {
    // Run from somewhere unusual: the version is only shown
  }
  const port = Number(env.AVI_BRAIN_PORT ?? COMPANION_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`AVI_BRAIN_PORT ${env.AVI_BRAIN_PORT} is not a port`);
  return {
    host: COMPANION_HOST,
    port,
    dataDir: env.AVI_BRAIN_HOME ?? join(homedir(), 'Library', 'Application Support', 'Avi Brain'),
    packageDir,
    version,
    sandboxImage: env.AVI_BRAIN_SANDBOX_IMAGE ?? SANDBOX_IMAGE,
    autoPair: env.AVI_BRAIN_AUTO_PAIR !== '0',
  };
}

/** A directory only this user can read, made if missing. */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
