import { Validator } from '@cfworker/json-schema';
import type { Schema, SchemaDraft } from '@cfworker/json-schema';

/**
 * Checks a tool call's arguments against the tool's input schema before anything is sent: a call the server
 * would refuse fails here with a sentence the agent can act on. @cfworker/json-schema interprets the schema
 * without generating code, so it runs under the extension's CSP (ajv would need `new Function`).
 */

// Keywords that only say "something inside failed"; the inner errors say what
const WRAPPER_KEYWORDS = new Set(['properties', 'items', 'allOf', '$ref', 'additionalItems', 'prefixItems', 'anyOf']);
const MAX_ERRORS = 4;

function draftOf(schema: Record<string, unknown>): SchemaDraft {
  const declared = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (declared.includes('draft-04')) return '4';
  if (declared.includes('draft-07') || declared.includes('draft-06')) return '7';
  if (declared.includes('2019-09')) return '2019-09';
  // MCP says a schema without $schema is JSON Schema 2020-12
  return '2020-12';
}

export type ArgsCheck = { ok: true } | { ok: false; errors: string[] };

/** Whether `args` fits the tool's input schema, with up to four reasons when it does not. */
export function checkArgs(inputSchema: Record<string, unknown> | undefined, args: Record<string, unknown>): ArgsCheck {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object' };
  let result;
  try {
    result = new Validator(schema as Schema, draftOf(schema), false).validate(args);
  } catch {
    return { ok: false, errors: ["the tool's argument rules could not be read"] };
  }
  if (result.valid) return { ok: true };
  const specific = result.errors.filter(error => !WRAPPER_KEYWORDS.has(error.keyword));
  const errors = (specific.length ? specific : result.errors).slice(0, MAX_ERRORS).map(error => {
    const where = error.instanceLocation.replace(/^#\/?/, '').replace(/\//g, '.');
    return where ? `${where}: ${error.error}` : error.error;
  });
  return { ok: false, errors };
}

/** The arguments a tool takes, required ones marked with *, for the agent's list of tools. */
export function argumentNames(inputSchema: Record<string, unknown> | undefined): string[] {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(inputSchema?.required) ? (inputSchema.required as unknown[]) : []);
  return Object.keys(properties as Record<string, unknown>).map(name => (required.has(name) ? `${name}*` : name));
}
