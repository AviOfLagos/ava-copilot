import type { VoiceModelComponentId } from './catalog';
import { openModelFile } from './store';

/**
 * Where the speech runtimes read a model file from. They ask for the packed path they always used
 * (`<extension>/voice/<component>/<file>`, `<extension>/wake/model.tar.gz`, `<extension>/wake/words.txt`); this
 * answers from the downloaded copy when the component was downloaded, else from the extension's own package (dev
 * builds made with the setup scripts), else with a 404, which the runtimes report as "not downloaded". Model files
 * are data handed over as a Response: nothing is evaluated, so the extension's CSP is untouched.
 */

const VOICE_IDS = new Set<VoiceModelComponentId>([
  'kitten',
  'kokoro',
  'moonshine-tiny',
  'moonshine-base',
  'whisper-base',
]);
const WAKE_FILES = new Set(['model.tar.gz', 'words.txt']);

/** The extension's own origin, with a trailing slash; workers have no chrome.runtime, but their location says. */
export function extensionBase(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL('');
  } catch {
    // Not in an extension context
  }
  const origin = (globalThis as { location?: Location }).location?.origin;
  return origin?.startsWith('chrome-extension://') ? `${origin}/` : '';
}

/** The component and file a packed model URL stands for, or null when it is not one. */
export function modelLocation(url: string, base = extensionBase()): { id: VoiceModelComponentId; path: string } | null {
  if (!base || !url.startsWith(base)) return null;
  const rest = url.slice(base.length).split(/[?#]/)[0];
  const voice = /^voice\/([^/]+)\/(.+)$/.exec(rest);
  if (voice && VOICE_IDS.has(voice[1] as VoiceModelComponentId) && !voice[2].split('/').includes('..')) {
    return { id: voice[1] as VoiceModelComponentId, path: voice[2] };
  }
  const wake = /^wake\/([^/]+)$/.exec(rest);
  if (wake && WAKE_FILES.has(wake[1])) return { id: 'vosk', path: wake[1] };
  return null;
}

export interface ModelFetchDeps {
  base?: string;
  open?: (id: VoiceModelComponentId, path: string) => Promise<File | null>;
  fetch?: typeof fetch;
}

const notFound = () => new Response(null, { status: 404, statusText: 'Not downloaded' });

/** A fetch that serves packed model URLs from the downloaded copy first; any other URL goes to the real fetch. */
export function createModelFetch(deps: ModelFetchDeps = {}): typeof fetch {
  const open = deps.open ?? ((id, path) => openModelFile(id, path));
  const packed = deps.fetch ?? fetch.bind(globalThis);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const location = modelLocation(url, deps.base ?? extensionBase());
    const call = () => (init ? packed(input, init) : packed(input));
    if (!location) return call();
    const file = await open(location.id, location.path).catch(() => null);
    if (file) {
      return new Response(file, {
        status: 200,
        headers: { 'Content-Length': String(file.size), 'Content-Type': 'application/octet-stream' },
      });
    }
    try {
      // A missing packed file is a network error for chrome-extension: URLs, not a 404
      const response = await call();
      return response.ok ? response : notFound();
    } catch {
      return notFound();
    }
  };
}

/** The model fetch for this context (workers, pages, the background). */
export const modelFetch: typeof fetch = (input, init) => createModelFetch()(input, init);
