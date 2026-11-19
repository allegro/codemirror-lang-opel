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
  it('keeps an unknown overload result permissive after property access', () => {
    const diagnostics = lint('acceptInteger(sketch(selector).missing)', {
      runtime: geometryRuntime,
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('Call is ambiguous'),
      }),
    ]);
  });

  it('still reports typos on a known closed overload result', () => {
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

  // Union inference must not change when the alternatives are reordered.
  it.each([false, true])(
    'keeps omitted array items unknown regardless of alternative order (%s)',
    (reverse) => {
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
  it.each([false, true])(
    'keeps local reference roots for each overload result (%s)',
    (reverse) => {
      const diagnostics = lint(
        'consume(choose(selector).first, choose(selector).second)',
        { runtime: localReferenceRuntime(reverse) }
      );

      expect(
        diagnostics.filter((item) => item.message.includes('Type mismatch'))
      ).toHaveLength(0);
      expect(
        diagnostics.filter((item) => item.message.includes('Call is ambiguous'))
      ).toHaveLength(2);
    }
  );

  it('keeps local reference roots for values inside object literals', () => {
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
      lint('val wrapped = { child: make() }; acceptInteger(wrapped.child.id)', {
        runtime,
      })
    ).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      })
    );
  });

  it('keeps impossible method results out of conditional joins', () => {
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

  it('keeps forbidden array items out of inferred unions', () => {
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

  it('keeps property access on an impossible receiver impossible', () => {
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
