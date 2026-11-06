import { describe, expect, it } from 'vitest';
import { isValueCompatibleWithSchema } from '../../src/linter/schema-compatibility';
import { createRuntimeContext } from '../../src/runtime';
import type { OpelRuntime, OpelSchema } from '../../src/types';

describe('recursive schema compatibility', () => {
  it('compares recursive schemas and finds a mismatch below their roots', () => {
    const runtime: OpelRuntime = {
      schemas: {
        Source: {
          type: 'object',
          properties: {
            value: { type: 'integer' },
            next: { $ref: 'Source' },
          },
          additionalProperties: false,
        },
        Compatible: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            next: { $ref: 'Compatible' },
          },
          additionalProperties: false,
        },
        Incompatible: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            next: { $ref: 'BadChild' },
          },
          additionalProperties: false,
        },
        BadChild: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            next: { $ref: 'BadChild' },
          },
          additionalProperties: false,
        },
      },
    };
    const source: OpelSchema = { $ref: 'Source' };
    const compatible: OpelSchema = { $ref: 'Compatible' };
    const incompatible: OpelSchema = { $ref: 'Incompatible' };

    expect(
      isValueCompatibleWithSchema(
        { schema: source },
        compatible,
        compatible,
        runtime
      )
    ).toBe(true);
    expect(
      isValueCompatibleWithSchema(
        { schema: source },
        incompatible,
        incompatible,
        runtime
      )
    ).toBe(false);
  });

  it('bounds comparisons across different recursive cycles', () => {
    const cycle = (prefix: string, length: number) =>
      Object.fromEntries(
        Array.from({ length }, (_, index) => [
          `${prefix}${index}`,
          {
            type: 'object',
            properties: { next: { $ref: `${prefix}${(index + 1) % length}` } },
            additionalProperties: false,
          },
        ])
      );
    const runtime: OpelRuntime = {
      schemas: { ...cycle('Source', 61), ...cycle('Target', 62) },
    };
    const issues: { code: string }[] = [];
    const validated = createRuntimeContext(runtime, (next) =>
      issues.push(...next)
    ).runtime;
    expect(issues).toHaveLength(0);
    const source: OpelSchema = { $ref: 'Source0' };
    const target: OpelSchema = { $ref: 'Target0' };

    expect(
      isValueCompatibleWithSchema({ schema: source }, target, target, validated)
    ).toBe(true);
  });
});
