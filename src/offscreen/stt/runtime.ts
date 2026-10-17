import { modelFetch } from '../../shared/lib/voice-models/resolve';

/**
 * How transformers.js runs inside the extension: models only from the extension itself (never the Hugging Face
 * hub): the copy downloaded on first use into its private storage, else its packed `voice/` folder (`modelFetch`);
 * no copy into Cache Storage (the files are already local); and onnxruntime-web's WebAssembly from the file the
 * build packs next to the worker, never the CDN transformers.js points at by default. No eval: transformers.js,
 * onnxruntime-web's bundle and the eSpeak phonemizer build no code from strings, and the extension's CSP only lets WebAssembly compile ('wasm-unsafe-eval'). Model bytes reach them as Responses
 * (data), never as code.
 */

interface TransformersEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  useBrowserCache: boolean;
  useWasmCache: boolean;
  fetch: (input: string | URL, init?: RequestInit) => Promise<unknown>;
  backends: { onnx: { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } } };
}

export function configureTransformers(env: TransformersEnv, modelBase: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelBase;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.fetch = modelFetch as TransformersEnv['fetch'];
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    // Unset, onnxruntime-web loads the .wasm the build emitted (same version as its JavaScript)
    wasm.wasmPaths = undefined;
    // Extension pages are not cross-origin isolated, so there are no shared-memory threads
    wasm.numThreads = 1;
    wasm.proxy = false;
  }
}

/** Whether this worker can use the GPU: WebGPU is there and gives an adapter. */
export async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}
