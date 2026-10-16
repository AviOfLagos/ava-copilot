/**
 * Local models worth installing, from what the browser can tell about this computer. Pure: the Models page reads
 * the browser (`navigator.deviceMemory`, `hardwareConcurrency`, the WebGPU adapter) and what Ollama lists, and
 * passes them in.
 *
 * What a browser cannot tell: the real amount of memory (`deviceMemory` is rounded, and Chrome never says more than
 * 8 GB),
 * free disk space, the GPU's own memory, and whether other apps already use most of the memory. So the user can
 * say how much memory the computer has, and sizes are shown so they can judge.
 */

export interface SystemSpec {
  // navigator.deviceMemory: rounded, at most 8 in Chrome (other browsers may say more); null when not said
  reportedMemoryGb: number | null;
  // What the user says the computer has; wins over the browser's figure
  userMemoryGb: number | null;
  // navigator.hardwareConcurrency
  cores: number | null;
  // 'mac' | 'windows' | 'linux' | 'chromeos' | other
  platform: string | null;
  // The WebGPU adapter, when the browser has WebGPU
  gpu: { vendor: string; architecture: string } | null;
}

export type RecommendationKind = 'chat' | 'light' | 'vision' | 'embed';

export interface LocalRecommendation {
  // Ollama's name, as `ollama pull` takes it
  name: string;
  kind: RecommendationKind;
  // Download size, roughly
  sizeGb: number;
  installed: boolean;
  command: string;
}

export interface MemoryEstimate {
  gb: number;
  // false when the figure is the browser's capped guess
  certain: boolean;
}

// The browser never reports more than this
export const DEVICE_MEMORY_CAP_GB = 8;

/** The memory to plan with: what the user said, else the browser's figure (a floor when it hits the cap). */
export function memoryEstimate(spec: SystemSpec): MemoryEstimate {
  if (spec.userMemoryGb && spec.userMemoryGb > 0) return { gb: spec.userMemoryGb, certain: true };
  if (spec.reportedMemoryGb && spec.reportedMemoryGb > 0) {
    return { gb: spec.reportedMemoryGb, certain: spec.reportedMemoryGb < DEVICE_MEMORY_CAP_GB };
  }
  return { gb: DEVICE_MEMORY_CAP_GB, certain: false };
}

interface Candidate {
  name: string;
  kind: RecommendationKind;
  sizeGb: number;
}

const EMBED: Candidate = { name: 'nomic-embed-text', kind: 'embed', sizeGb: 0.3 };

// By memory tier, smallest first: a model should take at most about half the memory, leaving the rest to the
// browser and the system
const TIERS: { minGb: number; models: Candidate[] }[] = [
  { minGb: 0, models: [{ name: 'qwen3:1.7b', kind: 'chat', sizeGb: 1.4 }, EMBED] },
  {
    minGb: 6,
    models: [
      { name: 'qwen3:4b', kind: 'chat', sizeGb: 2.5 },
      { name: 'gemma3:4b', kind: 'vision', sizeGb: 3.3 },
      EMBED,
    ],
  },
  {
    minGb: 12,
    models: [
      { name: 'qwen3:8b', kind: 'chat', sizeGb: 5.2 },
      { name: 'qwen3:4b', kind: 'light', sizeGb: 2.5 },
      { name: 'gemma3:4b', kind: 'vision', sizeGb: 3.3 },
      EMBED,
    ],
  },
  {
    minGb: 24,
    models: [
      { name: 'qwen3:14b', kind: 'chat', sizeGb: 9.3 },
      { name: 'qwen3:4b', kind: 'light', sizeGb: 2.5 },
      { name: 'gemma3:12b', kind: 'vision', sizeGb: 8.1 },
      EMBED,
    ],
  },
  {
    minGb: 48,
    models: [
      { name: 'qwen3:30b', kind: 'chat', sizeGb: 19 },
      { name: 'qwen3:4b', kind: 'light', sizeGb: 2.5 },
      { name: 'gemma3:27b', kind: 'vision', sizeGb: 17 },
      EMBED,
    ],
  },
];

/** A model name without Ollama's default tag, for comparing. */
export function baseModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');
}

/** The tier index for a spec: by memory, one lower on a machine with few cores (it would be slow). */
export function tierFor(spec: SystemSpec): number {
  const { gb } = memoryEstimate(spec);
  let tier = 0;
  TIERS.forEach((candidate, index) => {
    if (gb >= candidate.minGb) tier = index;
  });
  if (spec.cores !== null && spec.cores > 0 && spec.cores < 4) tier = Math.max(0, tier - 1);
  return tier;
}

/**
 * Two to four local models that fit this computer: a chat model, a smaller one for light work when there is room,
 * a vision model, and an embedding model. Installed ones are marked so the page can offer a test instead.
 */
export function recommendLocalModels(spec: SystemSpec, installed: string[]): LocalRecommendation[] {
  const have = new Set(installed.map(baseModelName));
  return TIERS[tierFor(spec)].models.map(model => ({
    ...model,
    installed: have.has(baseModelName(model.name)),
    command: `ollama pull ${model.name}`,
  }));
}

/** The browser's platform as a short word. */
export function platformOf(userAgentPlatform: string | undefined | null): string | null {
  const value = (userAgentPlatform ?? '').toLowerCase();
  if (!value) return null;
  if (value.includes('mac')) return 'mac';
  if (value.includes('win')) return 'windows';
  if (value.includes('cros') || value.includes('chrome os')) return 'chromeos';
  if (value.includes('linux')) return 'linux';
  return value;
}
