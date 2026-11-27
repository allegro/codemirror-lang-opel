import { describe, expect, it } from 'vitest';
import type { OpelRuntime, OpelSchema } from '../../src/types';
import { lint } from '../support/test-utils';

const geometryRuntime: OpelRuntime = {
  globals: {
    selector: true,
    items: {
      oneOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'array' }],
    },
  },
  functions: {
    sketch: {
      signatures: [
        {
          parameters: [
            { name: 'preset', schema: { type: 'integer', enum: [1, 2] } },
          ],
          returns: { $ref: 'Shape' },
        },
        {
          parameters: [{ name: 'description', schema: { type: 'string' } }],
          returns: true,
        },
      ],
    },
    acceptInteger: {
      signatures: [
        { parameters: [{ schema: { type: 'integer' } }], returns: true },
      ],
    },
    acceptString: {
      signatures: [
        { parameters: [{ schema: { type: 'string' } }], returns: true },
      ],
    },
  },
  schemas: {
    Shape: {
      oneOf: [
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', const: 'circle' },
            radius: { type: 'number' },
          },
          required: ['id', 'kind', 'radius'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', const: 'square' },
            side: { type: 'number' },
          },
          required: ['id', 'kind', 'side'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
  },
};

function localReferenceRuntime(reverse: boolean): OpelRuntime {
  const withFirst: OpelSchema = {
    $ref: '#/$defs/Result',
    $defs: {
      Result: {
        type: 'object',
        properties: { first: { type: 'string' } },
        required: ['first'],
        additionalProperties: false,
      },
    },
  };
  const withSecond: OpelSchema = {
    $ref: '#/$defs/Result',
    $defs: {
      Result: {
        type: 'object',
        properties: { second: { type: 'integer' } },
        required: ['second'],
        additionalProperties: false,
      },
    },
  };
  const signatures = [
    { parameters: [{ schema: { type: 'integer' } }], returns: withFirst },
    { parameters: [{ schema: { type: 'string' } }], returns: withSecond },
  ];
  return {
    globals: { selector: true },
    functions: {
      choose: { signatures: reverse ? signatures.reverse() : signatures },
      acceptString: {
        signatures: [
          { parameters: [{ schema: { type: 'string' } }], returns: true },
        ],
      },
      acceptInteger: {
        signatures: [
          { parameters: [{ schema: { type: 'integer' } }], returns: true },
        ],
      },
      consume: {
        signatures: [
          {
            parameters: [
              { schema: { type: 'string' } },
              { schema: { type: 'integer' } },
            ],
            returns: true,
          },
        ],
      },
    },
  };
}

describe('unconstrained inference alternatives', () => {
  it('does not reject a property on an unknown function result', () => {
    const diagnostics = lint('acceptInteger(sketch(selector).missing)', {
      runtime: geometryRuntime,
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining(
          'Multiple function signatures could match this call'
        ),
      }),
    ]);
  });

  it('reports a missing property on a closed return type', () => {
    const diagnostics = lint('sketch(1).missing', { runtime: geometryRuntime });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Property "missing" is not defined'),
      }),
    ]);
  });

  it('retains known property types when the overload is selected', () => {
    expect(
      lint('acceptString(sketch(1).id)', { runtime: geometryRuntime }).some(
        (diagnostic) => diagnostic.message.includes('Type mismatch')
      )
    ).toBe(false);
    expect(
      lint('acceptInteger(sketch(1).id)', { runtime: geometryRuntime }).some(
        (diagnostic) => diagnostic.message.includes('Type mismatch')
      )
    ).toBe(true);
  });

  it.each(["pick(selector) + '!'", "'!' + pick(selector)"])(
    'allows string concatenation with an unknown result: %s',
    (expression) => {
      const runtime: OpelRuntime = {
        ...geometryRuntime,
        globals: { selector: true },
        functions: {
          ...geometryRuntime.functions,
          pick: {
            signatures: [
              {
                parameters: [{ schema: { type: 'integer' } }],
                returns: { type: 'string' },
              },
              {
                parameters: [{ schema: { type: 'string' } }],
                returns: true,
              },
            ],
          },
        },
      };

      expect(lint(`acceptString(${expression})`, { runtime })).toEqual([
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining(
            'Multiple function signatures could match this call'
          ),
        }),
      ]);
    }
  );

  it.each(['selector + 1', '1 + selector'])(
    'allows a string result with an unknown operand: %s',
    (expression) => {
      expect(
        lint(`acceptString(${expression})`, { runtime: geometryRuntime })
      ).toEqual([]);
    }
  );

  it.each([
    ['the unknown alternative is first', true],
    ['the unknown alternative is last', false],
  ] as const)(
    'warns about deprecated properties in either schema order: %s',
    (_description, unknownFirst) => {
      const objectSchema: OpelSchema = {
        type: 'object',
        properties: {
          old: { type: 'string', deprecated: 'Use current instead.' },
        },
        additionalProperties: false,
      };
      const runtime: OpelRuntime = {
        ...geometryRuntime,
        globals: {
          value: {
            anyOf: unknownFirst ? [true, objectSchema] : [objectSchema, true],
          },
        },
      };

      expect(lint('acceptInteger(value.old)', { runtime })).toEqual([
        expect.objectContaining({
          severity: 'warning',
          message: 'Use current instead.',
        }),
      ]);
      expect(lint('value.missing', { runtime })).toEqual([]);
    }
  );

  it('keeps string item types when an array may also be null', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      globals: {
        items: {
          anyOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'null' },
          ],
        },
      },
    };

    expect(lint('acceptInteger(items[0])', { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'string'"),
      }),
    ]);
  });

  it('keeps an unknown array alternative permissive', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      globals: {
        items: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, {}],
        },
      },
    };

    expect(lint('acceptInteger(items[0])', { runtime })).toEqual([]);
  });

  // Union inference must not change when the alternatives are reordered.
  it.each([
    ['the integer-item alternative is first', false],
    ['the integer-item alternative is second', true],
  ] as const)(
    'treats unspecified array items as unknown in either schema order: %s',
    (_description, reverse) => {
      const arrays: OpelSchema[] = [
        { type: 'array', items: { type: 'integer' } },
        { type: 'array' },
      ];
      if (reverse) {
        arrays.reverse();
      }
      const runtime = {
        ...geometryRuntime,
        globals: { ...geometryRuntime.globals, items: { oneOf: arrays } },
      } satisfies OpelRuntime;

      expect(lint('acceptString(items[0])', { runtime })).toHaveLength(0);
    }
  );

  // Each overload result has its own local-ref root, regardless of union order.
  it.each([
    ['the integer overload is first', false],
    ['the integer overload is second', true],
  ] as const)(
    'keeps local reference roots for each overload result: %s',
    (_description, reverse) => {
      const diagnostics = lint(
        'consume(choose(selector).first, choose(selector).second)',
        { runtime: localReferenceRuntime(reverse) }
      );

      expect(
        diagnostics.filter((item) => item.message.includes('Type mismatch'))
      ).toHaveLength(0);
      expect(
        diagnostics.filter((item) =>
          item.message.includes(
            'Multiple function signatures could match this call'
          )
        )
      ).toHaveLength(2);
    }
  );

  it("preserves a returned value's type when storing it in an object", () => {
    // `make()` returns a local ref whose definition lives on the return schema.
    // After wrapping it, `.child.id` should still resolve to string, so passing it
    // to `acceptInteger` must report a type mismatch.
    const returnSchema: OpelSchema = {
      $ref: '#/$defs/Child',
      $defs: {
        Child: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    };
    const runtime: OpelRuntime = {
      functions: {
        make: { signatures: [{ parameters: [], returns: returnSchema }] },
        acceptInteger: {
          signatures: [
            { parameters: [{ schema: { type: 'integer' } }], returns: true },
          ],
        },
      },
    };

    expect(
      lint(
        "val wrapped = { 'child': make() }; acceptInteger(wrapped.child.id)",
        {
          runtime,
        }
      )
    ).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      })
    );
  });

  it('ignores an impossible method result when checking a conditional', () => {
    const runtime: OpelRuntime = {
      globals: {
        selector: { type: 'boolean' },
        // An arbitrary global name whose false schema admits no values.
        neverValue: false,
      },
      functions: {
        acceptInteger: {
          signatures: [
            { parameters: [{ schema: { type: 'integer' } }], returns: true },
          ],
        },
      },
    };

    // The impossible call contributes never, leaving a string result that
    // `acceptInteger` must reject.
    expect(
      lint('acceptInteger(if (selector) neverValue.missing() else "text")', {
        runtime,
      })
    ).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      })
    );
  });

  it('discards impossible alternatives when inferring array items', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      globals: {
        ...geometryRuntime.globals,
        items: {
          oneOf: [false, { type: 'array', items: { type: 'string' } }],
        },
      },
    };

    expect(
      lint('acceptInteger(items[0])', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Type mismatch')
      )
    ).toBe(true);
  });

  it('ignores an array variant that cannot contain items', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      globals: {
        ...geometryRuntime.globals,
        items: {
          oneOf: [
            { type: 'array', items: false },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
    };

    expect(
      lint('acceptInteger(items[0])', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Type mismatch')
      )
    ).toBe(true);
  });

  it('property and index access on an impossible value stay impossible', () => {
    const options = { runtime: { globals: { impossible: false } } };
    const diagnostics = [
      ...lint('(impossible.missing)()', options),
      ...lint('(impossible[0])()', options),
    ];

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("Type 'never' has no call signatures"),
      }),
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("Type 'never' has no call signatures"),
      }),
    ]);
  });
});
