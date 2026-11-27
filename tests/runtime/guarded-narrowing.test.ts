import { describe, expect, it } from 'vitest';
import type { OpelRuntime, OpelSchema } from '../../src/types';
import { lint } from '../support/test-utils';

const shapeSchemas = {
  Shape: {
    oneOf: [{ $ref: 'Circle' }, { $ref: 'Square' }, { type: 'null' }],
  },
  NonNullShape: { oneOf: [{ $ref: 'Circle' }, { $ref: 'Square' }] },
  Circle: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', const: 'circle' },
      radius: { type: 'number' },
    },
    required: ['id', 'kind', 'radius'],
    additionalProperties: false,
  },
  Square: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', const: 'square' },
      side: { type: 'number' },
    },
    required: ['id', 'kind', 'side'],
    additionalProperties: false,
  },
} satisfies Record<string, OpelSchema>;

const geometryRuntime: OpelRuntime = {
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
    nonNullShape: {
      signatures: [{ parameters: [], returns: { $ref: 'NonNullShape' } }],
    },
  },
  schemas: shapeSchemas,
  methods: {
    Circle: {
      circleMethod: {
        signatures: [{ parameters: [], returns: { type: 'string' } }],
      },
    },
  },
};

function diagnosticsWith(
  message: string,
  source: string,
  runtime = geometryRuntime
) {
  return lint(source, { runtime }).filter((diagnostic) =>
    diagnostic.message.includes(message)
  );
}

describe('null-guarded semantic analysis', () => {
  it('keeps unguarded nullable access warning and clears it in either null-check order', () => {
    const unguarded = 'val item = sketch(1); item.id';
    const warning = diagnosticsWith(
      'Property "id" is only defined for some variants',
      unguarded
    );
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({
      from: unguarded.indexOf('.id'),
      to: unguarded.indexOf('.id') + 3,
      severity: 'warning',
    });

    for (const source of [
      'val item = sketch(1); if (item != null) item.id else null',
      'val item = sketch(1); if (null != item) item.id else null',
      'val item = sketch(1); if (!(item == null)) item.id else null',
      'val item = sketch(1); if ((item) != null) item.id else null',
      'val item = sketch(1); if (null != (item)) item.id else null',
      "val item = sketch(1); if (item != null && item.id == 'x') item.id else null",
      "val item = sketch(1); if (item == null || item.id == 'x') null else item.id",
      'val item = sketch(1); if (item != null && item == null) item.id else null',
    ]) {
      expect(
        diagnosticsWith(
          'Property "id" is only defined for some variants',
          source
        )
      ).toEqual([]);
    }
  });

  it('keeps aliases stable but does not reuse facts for another call or shadow', () => {
    const alias =
      'val item = sketch(1); val alias = item; if (item != null) alias.id else null';
    expect(
      diagnosticsWith('Property "id" is only defined for some variants', alias)
    ).toEqual([]);

    const shadow =
      'val item = sketch(1); if (item != null) (inner -> { val item = sketch(1); item.id })(0) else null';
    expect(
      diagnosticsWith('Property "id" is only defined for some variants', shadow)
    ).toHaveLength(1);

    const calls = 'if (sketch(1) != null) sketch(1).id else null';
    expect(
      diagnosticsWith('Property "id" is only defined for some variants', calls)
    ).toHaveLength(1);
  });

  it('uses branch facts while linting an unfinished if without hiding its syntax error', () => {
    const source = 'val item = sketch(1); if (item != null) item.id';
    const diagnostics = lint(source, { runtime: geometryRuntime });
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          'Property "id" is only defined for some variants'
        )
      )
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ).toBe(true);
  });

  it('keeps unconstrained nullable values unknown rather than null-only', () => {
    const runtime: OpelRuntime = {
      globals: { unknownNullable: { nullable: true } },
    };
    const source = 'val marker = 1; if (unknownNullable != null) marker else 0';
    expect(
      lint(source, { runtime }).some((diagnostic) =>
        diagnostic.message.includes(
          'Variable "marker" is declared but never used'
        )
      )
    ).toBe(false);
  });

  it('drops impossible null and discriminator outcomes from conditional results', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      functions: {
        ...geometryRuntime.functions,
        squareOnly: {
          signatures: [{ parameters: [], returns: { $ref: 'Square' } }],
        },
        acceptInteger: {
          signatures: [
            { parameters: [{ schema: { type: 'integer' } }], returns: true },
          ],
        },
      },
      globals: { anything: true },
    };
    const discriminator =
      "val item = squareOnly(); acceptInteger(if (item.kind == 'circle') anything else 'text')";
    const contradictoryNull =
      'val item = sketch(1); acceptInteger(if (item != null && item == null) anything else "text")';
    for (const source of [discriminator, contradictoryNull]) {
      expect(
        diagnosticsWith('Type mismatch: argument', source, runtime)
      ).toHaveLength(1);
    }
  });

  it('normalizes dotted and literal bracket paths for nullable properties', () => {
    const runtime: OpelRuntime = {
      globals: {
        holder: {
          type: 'object',
          properties: {
            owner: {
              type: 'object',
              nullable: true,
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          required: ['owner'],
          additionalProperties: false,
        },
        typedHolder: {
          type: ['object', 'null'],
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    };
    expect(
      diagnosticsWith(
        'Property "id" is only defined for some variants',
        "if (holder.owner != null) holder['owner'].id else null",
        runtime
      )
    ).toEqual([]);

    const typedArray = 'if (typedHolder != null) typedHolder.id else null';
    expect(
      diagnosticsWith(
        'Property "id" is only defined for some variants',
        typedArray,
        runtime
      )
    ).toEqual([]);
    expect(
      diagnosticsWith(
        'Property "id" is only defined for some variants',
        'typedHolder.id',
        runtime
      )
    ).toHaveLength(1);

    const computedKey =
      "val key = 'owner'; if (holder[key] != null) holder[key].id else null";
    expect(
      diagnosticsWith(
        'Property "id" is only defined for some variants',
        computedKey,
        runtime
      )
    ).toHaveLength(1);
  });

  it('does not use a true-only fact after a conditional or in the opposite branch', () => {
    const after =
      'val item = sketch(1); val guarded = if (item != null) item.id else null; item.id';
    const warning = diagnosticsWith(
      'Property "id" is only defined for some variants',
      after
    );
    expect(warning).toHaveLength(1);
    expect(warning[0].from).toBe(after.lastIndexOf('.id'));

    const opposite =
      'val item = sketch(1); if (item == null) null else item.id';
    expect(
      diagnosticsWith(
        'Property "id" is only defined for some variants',
        opposite
      )
    ).toEqual([]);
  });
});

describe('discriminator narrowing', () => {
  it('narrows required literal tags in either operand order and with bracket paths', () => {
    const cases = [
      "val item = nonNullShape(); if ('circle' == item['kind']) item.radius else item.side",
      "val item = nonNullShape(); if (item.kind != 'circle') item.side else item.radius",
      "val item = nonNullShape(); if ('circle' != item.kind) item.side else item.radius",
      "val item = nonNullShape(); if (item.kind == 'circle') item.radius else item.side",
      "val item = nonNullShape(); val alias = item; if (alias.kind == 'circle') alias.radius else alias.side",
    ];
    for (const source of cases) {
      expect(lint(source, { runtime: geometryRuntime })).toEqual([]);
    }
  });

  it('keeps unknown and overlapping tag alternatives in every possible outcome', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      functions: {
        ...geometryRuntime.functions,
        nonNullShape: {
          signatures: [{ parameters: [], returns: { $ref: 'TaggedShape' } }],
        },
      },
      schemas: {
        ...shapeSchemas,
        TaggedShape: {
          oneOf: [
            { $ref: 'Circle' },
            { $ref: 'Square' },
            { $ref: 'UnknownTag' },
          ],
        },
        UnknownTag: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        OverlapShape: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['circle', 'round'] },
                radius: { type: 'number' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
            { $ref: 'Square' },
          ],
        },
      },
      globals: { flag: { type: 'boolean' } },
    };

    const unknown =
      "val item = nonNullShape(); if (item.kind == 'circle') item.radius else null";
    expect(
      diagnosticsWith(
        'Property "radius" is only defined for some variants',
        unknown,
        runtime
      )
    ).toHaveLength(1);

    const overlapRuntime: OpelRuntime = {
      ...runtime,
      functions: {
        ...runtime.functions,
        nonNullShape: {
          signatures: [{ parameters: [], returns: { $ref: 'OverlapShape' } }],
        },
      },
    };
    const overlap =
      "val item = nonNullShape(); if (item.kind != 'circle') item.side else item.radius";
    expect(
      diagnosticsWith(
        'Property "side" is only defined for some variants',
        overlap,
        overlapRuntime
      )
    ).toHaveLength(1);

    const partialOr =
      "val item = nonNullShape(); if (item.kind == 'circle' || flag) item.radius else null";
    expect(
      diagnosticsWith(
        'Property "radius" is only defined for some variants',
        partialOr,
        runtime
      )
    ).toHaveLength(1);
  });

  it('keeps an optional singleton tag in the unequal branch', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      functions: {
        ...geometryRuntime.functions,
        nonNullShape: {
          signatures: [
            { parameters: [], returns: { $ref: 'OptionalTagShape' } },
          ],
        },
      },
      schemas: {
        ...shapeSchemas,
        OptionalTagShape: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'circle' },
                radius: { type: 'number' },
              },
              required: ['radius'],
              additionalProperties: false,
            },
            { $ref: 'Square' },
          ],
        },
      },
    };
    const source =
      "val item = nonNullShape(); if (item.kind != 'circle') item.radius else null";
    expect(
      diagnosticsWith(
        'Property "radius" is only defined for some variants',
        source,
        runtime
      )
    ).toHaveLength(1);
  });

  it('keeps a nullable singleton tag in the unequal branch', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      functions: {
        ...geometryRuntime.functions,
        nonNullShape: {
          signatures: [
            { parameters: [], returns: { $ref: 'NullableTagShape' } },
          ],
        },
      },
      schemas: {
        ...shapeSchemas,
        NullableTagShape: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  const: 'circle',
                  nullable: true,
                },
                radius: { type: 'number' },
              },
              required: ['kind', 'radius'],
              additionalProperties: false,
            },
            { $ref: 'Square' },
          ],
        },
      },
    };
    const source =
      "val item = nonNullShape(); if (item.kind != 'circle') item.radius else null";
    expect(
      diagnosticsWith(
        'Property "radius" is only defined for some variants',
        source,
        runtime
      )
    ).toHaveLength(1);
  });

  it('intersects explicit and every matching pattern discriminator schema', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      functions: {
        ...geometryRuntime.functions,
        nonNullShape: {
          signatures: [{ parameters: [], returns: { $ref: 'PatternShape' } }],
        },
      },
      schemas: {
        ...shapeSchemas,
        PatternShape: {
          oneOf: [{ $ref: 'PatternCircle' }, { $ref: 'Square' }],
        },
        PatternCircle: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['circle', 'square'] },
            radius: { type: 'number' },
          },
          patternProperties: {
            '^kind$': { type: 'string', const: 'circle' },
            '^k': { type: 'string', enum: ['circle', 'round'] },
          },
          required: ['kind', 'radius'],
          additionalProperties: false,
        },
      },
    };
    const source =
      "val item = nonNullShape(); if (item.kind != 'circle') item.side else item.radius";
    expect(lint(source, { runtime })).toEqual([]);
  });

  it('preserves narrowed named method receivers and warns on the unguarded union', () => {
    const guarded =
      "val item = nonNullShape(); if (item.kind == 'circle') item.circleMethod() else null";
    expect(lint(guarded, { runtime: geometryRuntime })).toEqual([]);

    const unguarded = 'nonNullShape().circleMethod()';
    expect(
      diagnosticsWith('only be called on some receiver variants', unguarded)
    ).toHaveLength(1);
  });

  it('resolves discriminator literals through chained schema references', () => {
    const runtime: OpelRuntime = {
      ...geometryRuntime,
      schemas: {
        ...shapeSchemas,
        Circle: {
          ...shapeSchemas.Circle,
          properties: {
            ...shapeSchemas.Circle.properties,
            kind: { $ref: 'CircleTagAlias' },
          },
        },
        CircleTagAlias: { $ref: 'CircleTag' },
        CircleTag: { type: 'string', const: 'circle' },
      },
    };
    const source =
      "val item = nonNullShape(); if (item.kind == 'circle') item.circleMethod() else item.side";
    expect(lint(source, { runtime })).toEqual([]);
  });

  it('narrows an unfinished discriminator branch while retaining the missing-else error', () => {
    const source =
      "val item = nonNullShape(); if (item.kind == 'circle') item.radius";
    const diagnostics = lint(source, { runtime: geometryRuntime });
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          'Property "radius" is only defined for some variants'
        )
      )
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ).toBe(true);
  });

  it('narrows a nullable union through a null check and kind check combined with &&, retaining the unguarded warning', () => {
    const guarded =
      "val item = sketch(1); if (item != null && item.kind == 'circle') item.radius else null";
    expect(lint(guarded, { runtime: geometryRuntime })).toEqual([]);

    expect(
      diagnosticsWith(
        'Property "radius" is only defined for some variants',
        'val item = sketch(1); item.radius'
      )
    ).toHaveLength(1);
  });
});

describe('numeric equality guards', () => {
  it('respects OPEL BigDecimal scale when folding numeric literal comparisons', () => {
    expect(lint('if (1.0 == 1) missingNumericBranch else true')).toEqual([]);
    expect(lint('if (1.0 == 1.0) true else missingNumericBranch')).toEqual([]);
  });
});
