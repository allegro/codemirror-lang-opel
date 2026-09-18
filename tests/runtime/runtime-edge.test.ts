import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

describe('runtime semantic edge cases', () => {
  it('resolves local and exact external references, including recursion', () => {
    const runtime = {
      schemas: {
        'catalog/user/1.0': {
          type: 'object',
          properties: {
            name: { type: 'string' },
            next: { $ref: 'catalog/user/1.0' },
          },
        },
      },
      globals: {
        user: {
          type: 'object',
          definitions: { Name: { type: 'string' } },
          properties: {
            name: { $ref: '#/definitions/Name' },
            next: { $ref: 'catalog/user/1.0' },
          },
        },
      },
    };
    const issues: { code: string }[] = [];
    expect(
      lint('user.name', {
        runtime,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).toHaveLength(0);
    expect(
      lint('user.next.name', {
        runtime,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });

  it('resolves local references inside external schemas against the external root', () => {
    const issues: { code: string }[] = [];
    lint('user.name', {
      runtime: {
        schemas: {
          'catalog/user/1.0': {
            type: 'object',
            definitions: { Name: { type: 'string' } },
            properties: { name: { $ref: '#/definitions/Name' } },
          },
        },
        globals: { user: { $ref: 'catalog/user/1.0' } },
      },
      onRuntimeIssues: (next) => issues.push(...next),
    });

    expect(issues).toHaveLength(0);
  });

  it('preserves external schema roots through derived property access', () => {
    const diagnostics = lint('user.child.name', {
      runtime: {
        schemas: {
          'catalog/user/1.0': {
            type: 'object',
            definitions: {
              Child: {
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
            properties: { child: { $ref: '#/definitions/Child' } },
          },
        },
        globals: { user: { $ref: 'catalog/user/1.0' } },
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('disables the whole runtime for an unresolved reachable reference', () => {
    const issues: { code: string }[] = [];
    const diagnostics = lint('user', {
      runtime: { globals: { user: { $ref: 'missing/schema' } } },
      onRuntimeIssues: (next) => issues.push(...next),
    });
    expect(issues.some((issue) => issue.code === 'unresolved-reference')).toBe(
      true
    );
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Unknown symbol')
      )
    ).toBe(true);
  });

  it('reports invalid primitive runtime roots without throwing', () => {
    const issues: { code: string }[] = [];

    expect(() =>
      lint('value', {
        runtime: true as never,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).not.toThrow();
    expect(issues.some((issue) => issue.code === 'invalid-runtime-entry')).toBe(
      true
    );
  });

  it('reports malformed items and additionalProperties schemas', () => {
    for (const [keyword, schema] of [
      ['items', { type: 'array', items: 'invalid' }],
      [
        'additionalProperties',
        { type: 'object', additionalProperties: 'invalid' },
      ],
    ] as const) {
      const issues: { code: string; path: string }[] = [];
      lint('value', {
        runtime: {
          globals: { value: schema as never },
        },
        onRuntimeIssues: (next) => issues.push(...next),
      });

      expect(
        issues.some(
          (issue) =>
            issue.code === 'invalid-schema' &&
            issue.path.endsWith(`/${keyword}`)
        )
      ).toBe(true);
    }
  });

  it('decodes escaped local reference segments during semantic analysis', () => {
    const diagnostics = lint('value.name', {
      runtime: {
        globals: {
          value: {
            type: 'object',
            definitions: {
              'a/b': {
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
            properties: { name: { $ref: '#/definitions/a~1b' } },
          },
        },
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('preserves external roots through inferred lists, objects, and allOf', () => {
    const diagnostics = [
      ...lint('acceptInteger(items[0].name)', {
        runtime: {
          schemas: {
            'catalog/items': {
              type: 'array',
              definitions: {
                Item: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
              items: { $ref: '#/definitions/Item' },
            },
          },
          globals: { items: { $ref: 'catalog/items' } },
          functions: {
            acceptInteger: {
              signatures: [
                {
                  parameters: [{ schema: { type: 'integer' } }],
                  returns: true,
                },
              ],
            },
          },
        },
      }),
      ...lint('({child: user.child}).child.name', {
        runtime: {
          schemas: {
            'catalog/user': {
              type: 'object',
              definitions: {
                Child: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
              properties: { child: { $ref: '#/definitions/Child' } },
            },
          },
          globals: { user: { $ref: 'catalog/user' } },
        },
      }),
      ...lint('value.child.name', {
        runtime: {
          schemas: {
            'catalog/first': {
              type: 'object',
              properties: { first: { type: 'string' } },
            },
            'catalog/second': {
              type: 'object',
              definitions: {
                Child: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
              properties: { child: { $ref: '#/definitions/Child' } },
            },
          },
          globals: {
            value: {
              allOf: [{ $ref: 'catalog/first' }, { $ref: 'catalog/second' }],
            },
          },
        },
      }),
    ];

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('reports invalid falsy and non-cloneable runtime roots', () => {
    for (const runtime of [false, null, 0, ''] as never[]) {
      const issues: { code: string }[] = [];
      expect(() =>
        lint('value', {
          runtime,
          onRuntimeIssues: (next) => issues.push(...next),
        })
      ).not.toThrow();
      expect(
        issues.some((issue) => issue.code === 'invalid-runtime-entry')
      ).toBe(true);
    }

    const issues: { code: string }[] = [];
    expect(() =>
      lint('value', {
        runtime: (() => undefined) as never,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).not.toThrow();
    expect(issues.some((issue) => issue.code === 'invalid-runtime-entry')).toBe(
      true
    );
  });

  it('uses strict overloads, optional trailing parameters, and integer number inheritance', () => {
    const runtime = {
      functions: {
        choose: {
          signatures: [
            {
              parameters: [{ schema: { type: 'integer' } }],
              returns: { const: 'integer' },
            },
            {
              parameters: [
                { schema: { type: 'string' } },
                { schema: { type: 'boolean' }, optional: true },
              ],
              returns: { const: 'string' },
            },
          ],
        },
      },
      methods: {
        number: {
          abs: {
            signatures: [{ parameters: [], returns: { type: 'number' } }],
          },
        },
      },
    };
    expect(lint('choose(1)', { runtime })).toHaveLength(0);
    expect(lint("choose('x', true)", { runtime })).toHaveLength(0);
    expect(
      lint("choose('x', true, false)", { runtime }).some((d) =>
        d.message.includes('arity')
      )
    ).toBe(true);
    expect(lint('1.abs()', { runtime })).toHaveLength(0);
  });

  it('calls a parenthesized callable property without method fallback', () => {
    const diagnostics = lint("({'get': x -> x + x}.get)('get')", {
      runtime: {},
    });
    expect(
      diagnostics.filter((d) => d.message.includes('not callable'))
    ).toHaveLength(0);
  });

  it('handles closed objects, dynamic keys, lists, and union members', () => {
    const runtime = {
      globals: {
        closed: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          additionalProperties: false,
        },
        values: { type: 'array', items: { type: 'integer' } },
        union: {
          oneOf: [
            { type: 'object', properties: { id: { type: 'integer' } } },
            { type: 'object', properties: { name: { type: 'string' } } },
          ],
        },
      },
    };
    expect(
      lint('closed.missing', { runtime }).some((d) => d.severity === 'error')
    ).toBe(true);
    expect(
      lint('closed[unknown]', { runtime }).some((d) => d.severity === 'warning')
    ).toBe(true);
    expect(
      lint('values["x"]', { runtime }).some((d) =>
        d.message.includes('Invalid list index')
      )
    ).toBe(true);
    expect(
      lint('union.id', { runtime }).some((d) => d.severity === 'warning')
    ).toBe(true);
  });
});
