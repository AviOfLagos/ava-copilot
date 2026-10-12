import { jsonSchema, tool } from 'ai';
import type { JSONSchema7, ToolSet } from 'ai';
import type { VoiceToolDeclaration } from '../../registry';

/**
 * The voice tools, as a text model sees them: the same declarations the Live session gets (written in Gemini's
 * schema dialect: OBJECT, STRING, …) turned into JSON Schema tools whose calls go to the voice manager.
 */

const TYPES: Record<string, JSONSchema7['type']> = {
  STRING: 'string',
  BOOLEAN: 'boolean',
  INTEGER: 'integer',
  NUMBER: 'number',
  ARRAY: 'array',
  OBJECT: 'object',
};

/** A declaration's parameters as JSON Schema. */
export function toJsonSchema(parameters: VoiceToolDeclaration['parameters']): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {};
  for (const [name, property] of Object.entries(parameters?.properties ?? {})) {
    properties[name] = {
      type: TYPES[property.type.toUpperCase()] ?? 'string',
      ...(property.description ? { description: property.description } : {}),
    };
  }
  return {
    type: 'object',
    properties,
    ...(parameters?.required?.length ? { required: parameters.required } : {}),
    additionalProperties: false,
  };
}

export type RunVoiceTool = (name: string, args: Record<string, unknown>) => Promise<string>;

/** Tools for `generateText`, each running through `run` (the voice manager's onTool, with its guard). */
export function voiceToolSet(declarations: VoiceToolDeclaration[], run: RunVoiceTool): ToolSet {
  const tools: ToolSet = {};
  for (const declaration of declarations) {
    tools[declaration.name] = tool({
      description: declaration.description,
      inputSchema: jsonSchema<Record<string, unknown>>(toJsonSchema(declaration.parameters)),
      execute: async (input: Record<string, unknown>) => run(declaration.name, input ?? {}),
    });
  }
  return tools;
}
