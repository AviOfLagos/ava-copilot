import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeAppearance } from '@appearance';
import type { AppearanceSettingsConfig } from '@appearance';

/**
 * The appearance record (docs/appearance.md), kept in the app's own folder until the app and the extension share
 * one store (D7). Same fields, same values, same repair on read as the extension's.
 */
export class AppearanceStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(): Promise<AppearanceSettingsConfig> {
    try {
      return normalizeAppearance(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return normalizeAppearance(undefined);
    }
  }

  /** Writes one after another, so two quick clicks never read the same old record. */
  update(changes: Partial<AppearanceSettingsConfig>): Promise<AppearanceSettingsConfig> {
    const next = this.writes.then(async () => {
      const record = normalizeAppearance({ ...(await this.get()), ...changes });
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return record;
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
