import { describe, expect, it } from 'vitest';
import type { OpelRuntime, OpelSchema } from '../../src/types';
import { lint } from '../support/test-utils';

const methods: OpelRuntime['methods'] = {
  string: {
    describe: { signatures: [{ parameters: [], returns: { type: 'string' } }] },
    convert: {
      signatures: [
        {
          parameters: [{ schema: { type: 'string' } }],
          returns: { type: 'string' },
        },
      ],
    },
    onlyString: { signatures: [{ parameters: [], returns: true }] },
  },
  number: {
    describe: {
      signatures: [{ parameters: [], returns: { type: 'integer' } }],
    },
    convert: {
      signatures: [
        {
          parameters: [{ schema: { type: 'integer' } }],
          returns: { type: 'integer' },
        },
      ],
    },
  },
};

describe('methods on union receivers', () => {
  it.each(['oneOf', 'anyOf', 'type'] as const)(
    'combines results independently of %s order',
    (keyword) => {
      const results = [false, true].map((reverse) => {
        const types = reverse
          ? (['integer', 'string'] as const)
          : (['string', 'integer'] as const);
        const schema: OpelSchema =
          keyword === 'type'
            ? { type: types }
            : { [keyword]: types.map((type) => ({ type })) };
        const runtime: OpelRuntime = {
          globals: { value: schema },
          methods,
          functions: {
            acceptString: {
              signatures: [
                { parameters: [{ schema: { type: 'string' } }], returns: true },
              ],
            },
          },
        };
        expect(lint('value.describe()', { runtime })).toHaveLength(0);
        return lint('acceptString(value.describe())', { runtime });
      });
      expect(results[0]).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('Type mismatch'),
        })
      );
      expect(results[1]).toEqual(results[0]);
    }
  );

  it.each([
    ["value.convert('x')", 'warning'],
    ['value.convert(1)', 'warning'],
    ['value.convert(true)', 'error'],
    ['value.convert()', 'error'],
    ['value.onlyString()', 'warning'],
    ['value.missing()', 'error'],
  ])('checks each receiver alternative for %s', (expression, severity) => {
    const results = [false, true].map((reverse) => {
      const alternatives: OpelSchema[] = [
        { type: 'string' },
        { type: 'integer' },
      ];
      if (reverse) {
        alternatives.reverse();
      }
      return lint(expression, {
        runtime: { globals: { value: { oneOf: alternatives } }, methods },
      });
    });
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].severity).toBe(severity);
    expect(results[1]).toEqual(results[0]);
  });

  it('uses the result of the successful alternative after a partial argument match', () => {
    const runtime: OpelRuntime = {
      globals: { value: { type: ['string', 'integer'] } },
      methods,
      functions: {
        acceptString: {
          signatures: [
            { parameters: [{ schema: { type: 'string' } }], returns: true },
          ],
        },
      },
    };
    const diagnostics = lint("acceptString(value.convert('x'))", { runtime });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
  });

  it.each([
    true,
    {},
    { $ref: 'Unknown' },
    { oneOf: [true, { type: 'integer' }] },
  ])('keeps unknown receivers permissive: %j', (schema) => {
    expect(
      lint('value.missing()', {
        runtime: {
          globals: { value: schema as OpelSchema },
          schemas: { Unknown: true },
        },
      }).every((diagnostic) => diagnostic.severity !== 'error')
    ).toBe(true);
  });

  it('warns when nullable receivers only sometimes support a method', () => {
    const diagnostics = lint('value.describe()', {
      runtime: {
        globals: { value: { type: 'string', nullable: true } },
        methods,
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
  });

  it('preserves named aliases and primitive fallback within each alternative', () => {
    const runtime: OpelRuntime = {
      globals: { value: { $ref: 'Mixed' } },
      schemas: {
        Mixed: { oneOf: [{ $ref: 'Alias' }, { $ref: 'Count' }] },
        Alias: { $ref: 'Text' },
        Text: { type: 'string' },
        Count: { type: 'integer' },
      },
      methods: {
        ...methods,
        Alias: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'integer' } }],
          },
        },
        Text: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'boolean' } }],
          },
        },
      },
      functions: {
        acceptInteger: {
          signatures: [
            { parameters: [{ schema: { type: 'integer' } }], returns: true },
          ],
        },
      },
    };
    expect(lint('acceptInteger(value.describe())', { runtime })).toHaveLength(
      0
    );
  });

  it('prefers integer registrations over number fallback within a union', () => {
    const runtime: OpelRuntime = {
      globals: { value: { type: ['string', 'integer'] } },
      methods: {
        ...methods,
        integer: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'string' } }],
          },
        },
      },
      functions: {
        acceptString: {
          signatures: [
            { parameters: [{ schema: { type: 'string' } }], returns: true },
          ],
        },
      },
    };
    expect(lint('acceptString(value.describe())', { runtime })).toHaveLength(0);
  });

  it('keeps a method on a named union ahead of its branch registrations', () => {
    const runtime: OpelRuntime = {
      globals: { value: { $ref: 'Mixed' } },
      schemas: { Mixed: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
      methods: {
        ...methods,
        Mixed: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'boolean' } }],
          },
        },
      },
      functions: {
        acceptBoolean: {
          signatures: [
            { parameters: [{ schema: { type: 'boolean' } }], returns: true },
          ],
        },
      },
    };
    expect(lint('acceptBoolean(value.describe())', { runtime })).toHaveLength(
      0
    );
  });

  it('preserves named receiver dispatch inside intersections of unions', () => {
    const runtime: OpelRuntime = {
      globals: {
        value: {
          allOf: [{ oneOf: [{ $ref: 'Text' }, { $ref: 'Count' }] }, {}],
        },
      },
      schemas: { Text: { type: 'string' }, Count: { type: 'integer' } },
      methods: {
        Text: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'boolean' } }],
          },
        },
        Count: {
          describe: {
            signatures: [{ parameters: [], returns: { type: 'boolean' } }],
          },
        },
      },
      functions: {
        acceptBoolean: {
          signatures: [
            { parameters: [{ schema: { type: 'boolean' } }], returns: true },
          ],
        },
      },
    };
    expect(lint('acceptBoolean(value.describe())', { runtime })).toHaveLength(
      0
    );
  });

  it('keeps local reference roots on the results of different methods', () => {
    const runtime: OpelRuntime = {
      globals: { value: { type: ['string', 'integer'] } },
      methods: {
        string: {
          result: {
            signatures: [
              {
                parameters: [],
                returns: {
                  type: 'object',
                  properties: { item: { $ref: '#/$defs/Item' } },
                  $defs: {
                    Item: {
                      type: 'object',
                      properties: { id: { type: 'integer' } },
                      additionalProperties: false,
                    },
                  },
                },
              },
            ],
          },
        },
        number: {
          result: {
            signatures: [
              {
                parameters: [],
                returns: {
                  type: 'object',
                  properties: { item: { $ref: '#/$defs/Item' } },
                  $defs: {
                    Item: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                      additionalProperties: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
    const diagnostics = lint('value.result().item.id', { runtime });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('only defined for some variants'),
      })
    );
  });

  it.each(['value.convert(', "value.convert('x'"])(
    'suppresses argument and ambiguity diagnostics for incomplete calls: %s',
    (expression) => {
      const diagnostics = lint(expression, {
        runtime: {
          globals: { value: { type: ['string', 'integer'] } },
          methods,
        },
      });
      expect(
        diagnostics.filter((diagnostic) =>
          /arity|Type mismatch|ambiguous|some receiver variants/.test(
            diagnostic.message
          )
        )
      ).toHaveLength(0);
    }
  );

  it('deduplicates deprecation warnings across receiver alternatives', () => {
    const deprecated = {
      deprecated: true,
      signatures: [{ parameters: [], returns: true }],
    };
    const diagnostics = lint('value.old()', {
      runtime: {
        globals: { value: { type: ['string', 'integer'] } },
        methods: {
          string: { old: { ...deprecated } },
          number: { old: { ...deprecated } },
        },
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe('Deprecated.');
  });

  it('retains actual overload ambiguity without repeating the same warning', () => {
    const signatures = [
      { parameters: [{ schema: true }], returns: { type: 'integer' as const } },
      { parameters: [{ schema: true }], returns: { type: 'string' as const } },
    ];
    const diagnostics = lint('value.choose(1)', {
      runtime: {
        globals: { value: { type: ['string', 'integer'] } },
        methods: {
          string: { choose: { signatures } },
          number: { choose: { signatures } },
        },
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('Call is ambiguous'),
      })
    );
  });

  it('does not leak named registrations to null or unknown values', () => {
    const runtime: OpelRuntime = {
      globals: { value: true },
      schemas: { null: { type: 'object' }, unknown: { type: 'object' } },
      methods: {
        null: {
          namedOnly: {
            signatures: [{ parameters: [{ schema: true }], returns: true }],
          },
        },
        unknown: {
          namedOnly: {
            signatures: [{ parameters: [{ schema: true }], returns: true }],
          },
        },
      },
    };
    expect(lint('null.namedOnly()', { runtime })).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Invalid method'),
      })
    );
    expect(lint('value.namedOnly()', { runtime })).toHaveLength(0);
  });
});
