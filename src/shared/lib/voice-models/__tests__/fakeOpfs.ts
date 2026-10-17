/**
 * Just enough of the Origin Private File System for the voice model store, in memory: folders, files, writable
 * streams that only commit on close (as OPFS does), move().
 */

class FakeFile {
  data: Uint8Array = new Uint8Array(0);
}

function concat(a: Uint8Array, b: Uint8Array, at: number): Uint8Array {
  const size = Math.max(a.length, at + b.length);
  const out = new Uint8Array(size);
  out.set(a.subarray(0, Math.min(a.length, size)));
  out.set(b, at);
  return out;
}

async function toBytes(chunk: unknown): Promise<Uint8Array> {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
  throw new Error('unsupported chunk');
}

class FakeWritable {
  private buffer: Uint8Array;
  private position = 0;
  private closed = false;

  constructor(
    private readonly file: FakeFile,
    keep: boolean,
    // Counts writes, so a test can fail one
    private readonly onWrite?: () => void,
  ) {
    this.buffer = keep ? file.data.slice() : new Uint8Array(0);
  }

  async write(chunk: unknown): Promise<void> {
    this.onWrite?.();
    const bytes = await toBytes(chunk);
    this.buffer = concat(this.buffer, bytes, this.position);
    this.position += bytes.length;
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    this.buffer = this.buffer.slice(0, size);
    if (this.position > size) this.position = size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.file.data = this.buffer;
  }

  async abort(): Promise<void> {
    this.closed = true;
  }
}

export class FakeFileHandle {
  readonly kind = 'file';
  constructor(
    public name: string,
    readonly file: FakeFile,
    private readonly parent: FakeDirectoryHandle,
  ) {}

  async getFile(): Promise<File> {
    return new File([this.file.data as BlobPart], this.name);
  }

  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<FakeWritable> {
    return new FakeWritable(this.file, Boolean(options.keepExistingData), this.parent.onWrite);
  }

  async move(name: string): Promise<void> {
    this.parent.files.delete(this.name);
    this.name = name;
    this.parent.files.set(name, this.file);
  }
}

function notFound(name: string): Error {
  const error = new Error(`${name} not found`);
  error.name = 'NotFoundError';
  return error;
}

export class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly dirs = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFile>();
  onWrite?: () => void;

  constructor(readonly name = '') {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options.create) throw notFound(name);
      dir = new FakeDirectoryHandle(name);
      dir.onWrite = this.onWrite;
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    let file = this.files.get(name);
    if (!file) {
      if (!options.create) throw notFound(name);
      file = new FakeFile();
      this.files.set(name, file);
    }
    return new FakeFileHandle(name, file, this);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(name);
  }

  async *values(): AsyncIterable<FakeDirectoryHandle | FakeFileHandle> {
    for (const dir of this.dirs.values()) yield dir;
    for (const [name, file] of this.files) yield new FakeFileHandle(name, file, this);
  }

  /** Test helper: a file's bytes by path, or undefined. */
  read(path: string): Uint8Array | undefined {
    const parts = path.split('/');
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking down from this folder
    let dir: FakeDirectoryHandle | undefined = this;
    for (const part of parts.slice(0, -1)) dir = dir?.dirs.get(part);
    return dir?.files.get(parts[parts.length - 1])?.data;
  }

  /** Test helper: writes a file by path. */
  put(path: string, data: Uint8Array | string): void {
    const parts = path.split('/');
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking down from this folder
    let dir: FakeDirectoryHandle = this;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, new FakeDirectoryHandle(part));
      dir = dir.dirs.get(part)!;
    }
    const file = new FakeFile();
    file.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    dir.files.set(parts[parts.length - 1], file);
  }
}

/** The store's root, as the fake. */
export const rootOf = (fake: FakeDirectoryHandle) => async () => fake as unknown as FileSystemDirectoryHandle;
