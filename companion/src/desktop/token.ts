import { createHash, randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESKTOP_TOKEN_FILE } from '@protocol';

/**
 * The desktop app's token: new at every start, written to Ava Brain's data folder (readable by this user only, like
 * everything else there), and only its hash kept in memory. The app's main process reads the file; a web page
 * cannot, and a process that can read the file can already read Ava Brain's whole folder.
 */
export async function writeDesktopToken(dataDir: string): Promise<{ token: string; hash: string }> {
  const token = randomBytes(32).toString('base64url');
  const path = join(dataDir, DESKTOP_TOKEN_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
