import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

describe('runtime semantic safety', () => {
  it('ignores inherited names in runtime and schema dictionaries', () => {
    const issues: { code: string }[] = [];
    const runtime = {
      globals: {
        toString: { type: 'string' as const },
        user: {
          type: 'object' as const,
          properties: { id: { type: 'integer' as const } },
          additionalProperties: false,
        },
      },
      functions: {},
      methods: {
        string: {
          length: {
            signatures: [
              { parameters: [], returns: { type: 'integer' as const } },
            ],
          },
        },
      },
    };

    expect(
      lint('toString', {
        runtime,
        onRuntimeIssues: (next) => issues.push(...next),
      }).some((diagnostic) => diagnostic.message.includes('Unknown symbol'))
    ).toBe(false);
    expect(issues).toHaveLength(0);
    expect(
      lint("'x'.toString()", { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Invalid method')
      )
    ).toBe(true);
    expect(
      lint('user.toString', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Unknown property')
      )
    ).toBe(true);
  });

  it('keeps enclosing bindings visible in nested blocks', () => {
    expect(
      lint('val x = 1; { x }', { runtime: {} }).some((diagnostic) =>
        diagnostic.message.includes('Unknown symbol')
      )
    ).toBe(false);
  });

  it('rejects an unconstrained array for a constrained parameter', () => {
    const runtime = {
      globals: {
        values: { type: 'array' as const },
        emptyOnly: { type: 'array' as const, items: false },
      },
      functions: {
        acceptIntegers: {
          signatures: [
            {
              parameters: [
                {
                  schema: {
                    type: 'array' as const,
                    items: { type: 'integer' as const },
                  },
                },
              ],
              returns: true,
            },
          ],
        },
      },
    };

    expect(
      lint('acceptIntegers(values)', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Type mismatch')
      )
    ).toBe(true);
    expect(
      lint('acceptIntegers(emptyOnly)', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Type mismatch')
      )
    ).toBe(false);
  });

  it('validates unused named schemas and rejects composition cycles', () => {
    const invalidIssues: { code: string; path: string }[] = [];
    lint('1', {
      runtime: { schemas: { Broken: { type: 'invalid' as never } } },
      onRuntimeIssues: (next) => invalidIssues.push(...next),
    });
    expect(invalidIssues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-schema',
        path: '/schemas/Broken/type',
      })
    );

    const cyclicIssues: { code: string }[] = [];
    expect(() =>
      lint('value', {
        runtime: {
          schemas: { Loop: { oneOf: [{ $ref: 'Loop' }] } },
          globals: { value: { $ref: 'Loop' } },
        },
        onRuntimeIssues: (next) => cyclicIssues.push(...next),
      })
    ).not.toThrow();
    expect(cyclicIssues.some((issue) => issue.code === 'invalid-schema')).toBe(
      true
    );
  });

  it('preserves recursive object schemas', () => {
    const issues: { code: string }[] = [];
    lint('node.next', {
      runtime: {
        schemas: {
          Node: {
            type: 'object',
            properties: { next: { $ref: 'Node' } },
          },
        },
        globals: { node: { $ref: 'Node' } },
      },
      onRuntimeIssues: (next) => issues.push(...next),
    });
    expect(issues).toHaveLength(0);
  });
});
