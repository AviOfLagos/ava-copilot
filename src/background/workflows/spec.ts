import { isPrivateHost } from './net';
import { Cron } from 'croner';
import { z } from 'zod';
import { malformedPlaces, templateRefs } from './template';

/**
 * A workflow (a routine) as data: a small directed graph of triggers, steps and outputs, with edges that
 * carry data from one step to the next through {{steps.<id>.output}} places. Pure TypeScript, shared by
 * the background, the panel and, later, the Mac companion, so a workflow can run with the browser closed.
 */

export const SPEC_VERSION = 1;
export const MAX_NODES = 30;
export const MAX_EDGES = 60;
// A schedule may fire at most this often, so a routine cannot run away with the user's budget
export const MIN_SCHEDULE_GAP_MS = 5 * 60_000;
export const DEFAULT_HTTP_BYTES = 1_000_000;
export const MAX_HTTP_BYTES = 2_000_000;

export const NODE_TYPES = [
  'trigger.schedule',
  'trigger.manual',
  'trigger.event',
  'trigger.tab',
  'step.http_get',
  'step.web_search',
  'step.browse',
  'step.read_page',
  'step.memory_search',
  'step.memory_save',
  'step.llm',
  'step.condition',
  'step.agent',
  'step.tool',
  'step.sandbox',
  'out.inbox',
  'out.brief_section',
  'out.notify',
  'out.speak',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type NodeGroup = 'trigger' | 'step' | 'output';

export function groupOf(type: NodeType): NodeGroup {
  return type.startsWith('trigger.') ? 'trigger' : type.startsWith('out.') ? 'output' : 'step';
}

// Kinds that exist in the spec but are run by streams still being built (agents, connectors, the Mac
// companion, voice out). A run that reaches one stops with a plain message; the trigger kinds never fire yet.
export const NOT_YET_AVAILABLE: ReadonlySet<NodeType> = new Set<NodeType>([
  'trigger.tab',
  'step.agent',
  'step.tool',
  'step.sandbox',
  'out.speak',
]);

export const CONDITION_OPS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const TRIGGER_EVENTS = ['meeting_ended', 'inbox_item'] as const;

/**
 * Fields filled from earlier steps' outputs. Every other field is taken as written: instructions, tasks,
 * search words and addresses never come from outside content, so a fetched page cannot steer a step.
 */
export const DATA_FIELDS: Partial<Record<NodeType, readonly string[]>> = {
  'step.browse': ['context'],
  'step.memory_search': ['query'],
  'step.memory_save': ['title', 'text'],
  'step.llm': ['input'],
  'step.condition': ['left', 'right'],
  'step.tool': ['args'],
  'out.inbox': ['title', 'body'],
  'out.brief_section': ['title', 'content'],
  'out.notify': ['title', 'message'],
  'out.speak': ['text'],
};

// Roots a place may start with, and the names under the fixed ones
const RUN_FIELDS = new Set(['date', 'startedAt', 'trigger']);
const WORKFLOW_FIELDS = new Set(['name']);

const nodeId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'An id is 1 to 32 lowercase letters, digits or "_", starting with a letter.');
const label = z.string().trim().min(1).max(80);
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(value => isHttpUrl(value), 'It must be a full http or https address with no user name or password.');
const instruction = z.string().trim().min(1).max(4000);
const data = z.string().max(8000);

const base = { id: nodeId, label };

export const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('trigger.schedule'),
    cron: z.string().trim().min(9).max(120),
    timezone: z.string().trim().min(1).max(64),
  }),
  z.object({ ...base, type: z.literal('trigger.manual') }),
  z.object({
    ...base,
    type: z.literal('trigger.event'),
    event: z.enum(TRIGGER_EVENTS),
    source: z.string().trim().max(80).optional(),
  }),
  z.object({ ...base, type: z.literal('trigger.tab'), urlPattern: z.string().trim().min(1).max(300) }),
  z.object({
    ...base,
    type: z.literal('step.http_get'),
    url: httpUrl,
    format: z.enum(['json', 'text']).default('json'),
    maxBytes: z.number().int().min(1000).max(MAX_HTTP_BYTES).default(DEFAULT_HTTP_BYTES),
  }),
  z.object({ ...base, type: z.literal('step.web_search'), query: instruction.max(300) }),
  z.object({
    ...base,
    type: z.literal('step.browse'),
    task: instruction,
    startUrl: httpUrl.optional(),
    context: data.optional(),
  }),
  z.object({ ...base, type: z.literal('step.read_page'), url: httpUrl }),
  z.object({
    ...base,
    type: z.literal('step.memory_search'),
    query: data.min(1),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  z.object({ ...base, type: z.literal('step.memory_save'), title: data.min(1), text: data.min(1) }),
  z.object({ ...base, type: z.literal('step.llm'), instructions: instruction, input: data.default('') }),
  z.object({
    ...base,
    type: z.literal('step.condition'),
    left: data,
    op: z.enum(CONDITION_OPS),
    right: data.default(''),
  }),
  z.object({ ...base, type: z.literal('step.agent'), task: instruction, agent: z.string().trim().max(80).optional() }),
  z.object({
    ...base,
    type: z.literal('step.tool'),
    connector: z.string().trim().min(1).max(80),
    tool: z.string().trim().min(1).max(120),
    args: data.default(''),
    readOnly: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal('step.sandbox'), command: instruction }),
  z.object({
    ...base,
    type: z.literal('out.inbox'),
    title: data.min(1),
    body: data.default(''),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
  z.object({ ...base, type: z.literal('out.brief_section'), title: data.min(1), content: data.min(1) }),
  z.object({ ...base, type: z.literal('out.notify'), title: data.min(1), message: data.default('') }),
  z.object({ ...base, type: z.literal('out.speak'), text: data.min(1) }),
]);

export const edgeSchema = z.object({
  from: nodeId,
  to: nodeId,
  // Only on edges leaving a condition: the branch it takes
  when: z.enum(['true', 'false']).optional(),
});

export const DEFAULT_BUDGET = {
  // Step attempts per run, retries included
  maxSteps: 60,
  // Model calls per run (summaries; a browser task's own calls are its chat's)
  maxModelCalls: 10,
  // Tokens per run, input and output
  maxTokens: 400_000,
  // Scheduled runs per day
  maxRunsPerDay: 24,
};

export const budgetSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).default(DEFAULT_BUDGET.maxSteps),
  maxModelCalls: z.number().int().min(0).max(40).default(DEFAULT_BUDGET.maxModelCalls),
  maxTokens: z.number().int().min(1000).max(4_000_000).default(DEFAULT_BUDGET.maxTokens),
  maxRunsPerDay: z.number().int().min(1).max(288).default(DEFAULT_BUDGET.maxRunsPerDay),
});

export const specSchema = z.object({
  v: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(''),
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_EDGES).default([]),
  // Hosts the fetching steps may reach: exact names, or "*.example.com" for its subdomains
  allowHosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(30).default([]),
  budget: budgetSchema.default(DEFAULT_BUDGET),
});

export type WorkflowSpec = z.infer<typeof specSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export type NodeOf<T extends NodeType> = Extract<WorkflowNode, { type: T }>;

export interface SpecIssue {
  nodeId?: string;
  message: string;
}

export type SpecCheck = { ok: true; spec: WorkflowSpec } | { ok: false; issues: SpecIssue[] };

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Whether a host is on the list: exactly, or under a "*.example.com" entry. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowHosts.some(entry =>
    entry.startsWith('*.') ? name.endsWith(entry.slice(1)) || name === entry.slice(2) : name === entry,
  );
}

/** The host names an address list reaches, lower case, without duplicates. */
export function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // Not an address: the checks report it
    }
  }
  return [...hosts];
}

/** The addresses a spec fetches by itself (not the browser agent's, which its own firewall governs). */
export function fetchedUrls(spec: Pick<WorkflowSpec, 'nodes'>): string[] {
  return spec.nodes.flatMap(node =>
    node.type === 'step.http_get' || node.type === 'step.read_page' ? [node.url] : [],
  );
}

/** Whether a step reaches outside on the user's behalf (sends, writes, runs code): it waits for their click. */
export function isSideEffect(node: WorkflowNode): boolean {
  switch (node.type) {
    case 'step.tool':
      return !node.readOnly;
    case 'step.agent':
    case 'step.sandbox':
      return true;
    default:
      return false;
  }
}

export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * When a schedule fires next, after `after`, or an error sentence: not a cron expression, a time zone that
 * does not exist, never fires, or fires more often than every five minutes.
 */
export function checkSchedule(cron: string, timezone: string, after: number): { next: number } | { error: string } {
  if (!isTimezone(timezone)) return { error: `"${timezone}" is not a time zone (use a name like Europe/Lisbon).` };
  let runs: Date[];
  try {
    runs = new Cron(cron, { timezone, paused: true }).nextRuns(3, new Date(after));
  } catch {
    return { error: `"${cron}" is not a schedule (use cron, e.g. "30 7 * * *" for every day at 07:30).` };
  }
  if (runs.length === 0) return { error: `The schedule "${cron}" never runs.` };
  for (let index = 1; index < runs.length; index++) {
    if (runs[index].getTime() - runs[index - 1].getTime() < MIN_SCHEDULE_GAP_MS) {
      return { error: `The schedule "${cron}" runs too often; the most often is every 5 minutes.` };
    }
  }
  return { next: runs[0].getTime() };
}

export function nodeById(spec: Pick<WorkflowSpec, 'nodes'>, id: string): WorkflowNode | undefined {
  return spec.nodes.find(node => node.id === id);
}

export function incomingEdges(spec: Pick<WorkflowSpec, 'edges'>, id: string): WorkflowEdge[] {
  return spec.edges.filter(edge => edge.to === id);
}

/**
 * The nodes in an order where each comes after everything it depends on; ties keep the spec's order.
 * Null when the edges loop.
 */
export function topoOrder(spec: Pick<WorkflowSpec, 'nodes' | 'edges'>): string[] | null {
  const ids = spec.nodes.map(node => node.id);
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const edge of spec.edges) {
    if (indegree.has(edge.to) && indegree.has(edge.from)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < ids.length) {
    const next = ids.find(id => !done.has(id) && indegree.get(id) === 0);
    if (!next) return null;
    order.push(next);
    done.add(next);
    for (const edge of spec.edges) {
      if (edge.from === next && indegree.has(edge.to)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) - 1);
    }
  }
  return order;
}

/** Every node a node depends on, directly or through others. */
export function ancestorsOf(spec: Pick<WorkflowSpec, 'edges'>, id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const edge of spec.edges) {
      if (edge.to === current && !found.has(edge.from)) {
        found.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return found;
}

function describeZodIssue(input: unknown, issue: z.core.$ZodIssue): SpecIssue {
  const path = issue.path.map(String);
  if (path[0] === 'nodes' && path.length >= 2) {
    const raw = (input as { nodes?: { id?: unknown }[] } | null)?.nodes?.[Number(path[1])];
    const id = typeof raw?.id === 'string' ? raw.id : `#${Number(path[1]) + 1}`;
    const field = path.slice(2).join('.');
    return {
      nodeId: typeof raw?.id === 'string' ? raw.id : undefined,
      message: `Step "${id}"${field ? `, ${field}` : ''}: ${issue.message}`,
    };
  }
  return { message: `${path.join('.') || 'The workflow'}: ${issue.message}` };
}

/** Checks the places in one step's fields: only data fields may have them, and only from steps before it. */
function placeIssues(spec: WorkflowSpec, node: WorkflowNode): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const dataFields = new Set(DATA_FIELDS[node.type] ?? []);
  const ancestors = ancestorsOf(spec, node.id);
  for (const [field, value] of Object.entries(node)) {
    if (typeof value !== 'string' || field === 'type' || field === 'id') continue;
    const where = `Step "${node.id}", ${field}`;
    for (const place of malformedPlaces(value)) {
      issues.push({ nodeId: node.id, message: `${where}: ${place} is not a place; write {{steps.<id>.output}}.` });
    }
    const refs = templateRefs(value);
    if (refs.length === 0) continue;
    if (!dataFields.has(field)) {
      issues.push({
        nodeId: node.id,
        message: `${where}: places like {{steps.<id>.output}} are only allowed in ${[...dataFields].join(', ') || 'no field of this step'}. Instructions and addresses are written out, never filled from fetched content.`,
      });
      continue;
    }
    for (const ref of refs) {
      const [root, name, sub] = ref;
      if (root === 'steps') {
        if (!name || !spec.nodes.some(other => other.id === name)) {
          issues.push({ nodeId: node.id, message: `${where}: there is no step "${name ?? ''}".` });
        } else if (!ancestors.has(name)) {
          issues.push({
            nodeId: node.id,
            message: `${where}: it uses step "${name}", which does not come before it (add an edge from "${name}").`,
          });
        } else if (sub !== 'output') {
          issues.push({ nodeId: node.id, message: `${where}: write {{steps.${name}.output}}.` });
        }
      } else if (root === 'run') {
        if (!RUN_FIELDS.has(name ?? ''))
          issues.push({ nodeId: node.id, message: `${where}: {{run.${name ?? ''}}} does not exist.` });
      } else if (root === 'workflow') {
        if (!WORKFLOW_FIELDS.has(name ?? ''))
          issues.push({ nodeId: node.id, message: `${where}: {{workflow.${name ?? ''}}} does not exist.` });
      } else {
        issues.push({
          nodeId: node.id,
          message: `${where}: {{${ref.join('.')}}} does not exist; places start with steps, run or workflow.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Checks a workflow fully: its shape, a graph that flows one way from a trigger, places that only read
 * earlier steps, addresses on the allowed hosts, schedules that make sense, and the limits. The issues are
 * plain sentences, fit for the user or for the model that wrote the workflow.
 */
export function validateSpec(input: unknown, now = Date.now()): SpecCheck {
  const parsed = specSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 12).map(issue => describeZodIssue(input, issue)) };
  }
  const spec = parsed.data;
  const issues: SpecIssue[] = [];
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) issues.push({ nodeId: node.id, message: `Two steps have the id "${node.id}".` });
    ids.add(node.id);
  }

  const triggers = spec.nodes.filter(node => groupOf(node.type) === 'trigger');
  if (triggers.length === 0) issues.push({ message: 'A workflow needs a trigger: a schedule, an event, or by hand.' });
  if (spec.nodes.filter(node => node.type === 'trigger.schedule').length > 1) {
    issues.push({ message: 'A workflow has at most one schedule; put the times in one cron expression.' });
  }

  const byId = new Map(spec.nodes.map(node => [node.id, node]));
  const edgeKeys = new Set<string>();
  for (const edge of spec.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      issues.push({
        message: `An edge joins "${edge.from}" to "${edge.to}", but ${!from ? edge.from : edge.to} is not a step.`,
      });
      continue;
    }
    if (edge.from === edge.to) issues.push({ nodeId: edge.from, message: `Step "${edge.from}" points to itself.` });
    if (groupOf(to.type) === 'trigger')
      issues.push({ nodeId: to.id, message: `Trigger "${to.id}" cannot follow another step.` });
    const key = `${edge.from}>${edge.to}`;
    if (edgeKeys.has(key)) issues.push({ message: `"${edge.from}" is joined to "${edge.to}" twice.` });
    edgeKeys.add(key);
    if (from.type === 'step.condition' && !edge.when) {
      issues.push({
        nodeId: from.id,
        message: `The edges leaving condition "${from.id}" must say when: "true" or "false".`,
      });
    }
    if (from.type !== 'step.condition' && edge.when) {
      issues.push({ nodeId: from.id, message: `Only a condition's edges say when; "${from.id}" is not a condition.` });
    }
  }

  if (!topoOrder(spec)) {
    issues.push({ message: 'The steps loop back on themselves; a workflow must flow one way.' });
  } else {
    // Every step must be reachable from a trigger, or it would never run
    const reached = new Set(triggers.map(node => node.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of spec.edges) {
        if (reached.has(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to);
          grew = true;
        }
      }
    }
    for (const node of spec.nodes) {
      if (!reached.has(node.id)) {
        issues.push({
          nodeId: node.id,
          message: `Step "${node.id}" is not connected to a trigger, so it would never run.`,
        });
      }
    }
    for (const node of spec.nodes) issues.push(...placeIssues(spec, node));
  }

  for (const node of spec.nodes) {
    if (node.type === 'trigger.schedule') {
      const schedule = checkSchedule(node.cron, node.timezone, now);
      if ('error' in schedule) issues.push({ nodeId: node.id, message: `Step "${node.id}": ${schedule.error}` });
    }
    if (node.type === 'step.http_get' || node.type === 'step.read_page') {
      const [host] = hostsOf([node.url]);
      if (host && !hostAllowed(host, spec.allowHosts)) {
        issues.push({ nodeId: node.id, message: `Step "${node.id}" fetches ${host}, which is not in allowHosts.` });
      }
      // A routine never reaches this machine or a private network (the test-only stand-ins are applied later)
      if (host && isPrivateHost(host)) {
        issues.push({ nodeId: node.id, message: `Step "${node.id}" reaches ${host}, a private or local address.` });
      }
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, spec };
}

/** The spec of a stored record, or null when it is missing or no longer valid. */
export function parseSpec(input: unknown): WorkflowSpec | null {
  if (!input) return null;
  const parsed = specSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
