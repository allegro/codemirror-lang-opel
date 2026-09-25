import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

const runtime = {
  globals: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', deprecated: 'use displayName' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    choice: {
      oneOf: [
        { type: 'object', properties: { name: { type: 'string' } } },
        { type: 'object', properties: { id: { type: 'integer' } } },
      ],
    },
  },
  functions: {
    lookup: {
      signatures: [
        {
          parameters: [{ name: 'id', schema: { type: 'integer' } }],
          returns: { type: 'string' },
        },
      ],
    },
  },
  methods: {
    string: {
      length: {
        signatures: [{ parameters: [], returns: { type: 'integer' } }],
      },
    },
  },
} as const;

describe('runtime-aware semantics', () => {
  it('reports unknown symbols and functions with or without runtime metadata', () => {
    expect(
      lint('missing', { runtime }).some((d) =>
        d.message.includes('Unknown symbol')
      )
    ).toBe(true);
    expect(
      lint('missing() ', { runtime }).some((d) =>
        d.message.includes('Unknown function')
      )
    ).toBe(true);
    expect(
      lint('missing').some((d) => d.message.includes('Unknown symbol'))
    ).toBe(true);
  });

  it('suggests visible local and runtime names for unknown symbols', () => {
    const runtimeTypo = lint('userr', { runtime });
    expect(runtimeTypo).toHaveLength(1);
    expect(runtimeTypo[0].message).toContain('Did you mean: user?');

    const localTypo = lint("val user = 'x'; useer", { runtime });
    const localUnknown = localTypo.filter((diagnostic) =>
      diagnostic.message.includes('Unknown symbol')
    );
    expect(localUnknown).toHaveLength(1);
    expect(localUnknown[0].message).toContain('Did you mean: user?');
  });

  it('does not duplicate used-before-declaration diagnostics', () => {
    const diagnostics = lint("val a = foo; val foo = 'x'; a", { runtime });

    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('used before declaration')
      )
    ).toHaveLength(1);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Unknown symbol')
      )
    ).toBe(false);
  });

  it('checks inferred argument types without requiring literals', () => {
    const diagnostics = lint('lookup(text)', {
      runtime: {
        ...runtime,
        globals: { ...runtime.globals, text: { type: 'string' } },
      },
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('lists and truncates parameter values when no overload matches', () => {
    const names = [
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
      'ninth',
      'tenth',
      'eleventh',
      'twelfth',
    ];
    const diagnostics = lint("lookup('unknown')", {
      runtime: {
        functions: {
          lookup: {
            signatures: names.map((name) => ({
              parameters: [{ name: 'name', schema: { const: name } }],
              returns: true,
            })),
          },
        },
      },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain(
      'any of the available values (12): "first", "second", "third" (+9 more)'
    );
  });

  it('validates arguments in every part of an if expression', () => {
    const diagnostics = lint(
      "if(lookup('first') != null) lookup('second') else lookup('third')",
      { runtime }
    );

    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(3);
  });

  it('accepts valid arguments in every part of an if expression', () => {
    expect(
      lint('if(lookup(1) != null) lookup(2) else lookup(3)', { runtime })
    ).toHaveLength(0);
  });

  it('preserves local schema reference roots through chained access', () => {
    const diagnostics = lint('user.child.name', {
      runtime: {
        globals: {
          user: {
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
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('rejects contradictory allOf schemas during compatibility checks', () => {
    const diagnostics = lint('acceptString(value)', {
      runtime: {
        globals: {
          value: { allOf: [{ type: 'number' }, { type: 'string' }] },
        },
        functions: {
          acceptString: {
            signatures: [
              {
                parameters: [{ schema: { type: 'string' } }],
                returns: true,
              },
            ],
          },
        },
      },
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('resolves parameter-local references against each parameter schema', () => {
    const diagnostics = lint('accept(text)', {
      runtime: {
        globals: { text: { type: 'string' } },
        functions: {
          accept: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      $ref: '#/definitions/Text',
                      definitions: { Text: { type: 'string' } },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('checks non-literal const, enum, object, required, and item constraints', () => {
    const options = {
      runtime: {
        globals: {
          constValue: { const: 'actual' },
          enumValue: { enum: ['actual'] },
          objectValue: {
            type: 'object',
            properties: { id: { type: 'integer' } },
          },
          itemsValue: { type: 'array', items: { type: 'string' } },
        },
        functions: {
          acceptConst: {
            signatures: [
              {
                parameters: [{ schema: { const: 'expected' } }],
                returns: true,
              },
            ],
          },
          acceptEnum: {
            signatures: [
              {
                parameters: [{ schema: { enum: ['expected'] } }],
                returns: true,
              },
            ],
          },
          acceptObject: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                      required: ['name'],
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
          acceptItems: {
            signatures: [
              {
                parameters: [
                  { schema: { type: 'array', items: { type: 'integer' } } },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    } as const;
    for (const expression of [
      'acceptConst(constValue)',
      'acceptEnum(enumValue)',
      'acceptObject(objectValue)',
      'acceptItems(itemsValue)',
    ]) {
      expect(
        lint(expression, options).filter((diagnostic) =>
          diagnostic.message.includes('argument')
        ),
        expression
      ).toHaveLength(1);
    }
  });

  it('preserves allOf alternatives and merged object properties', () => {
    const options = {
      runtime: {
        globals: {
          value: {
            allOf: [
              {
                oneOf: [
                  { type: 'object', properties: { name: { type: 'string' } } },
                  { type: 'object', properties: { id: { type: 'integer' } } },
                ],
              },
              {
                type: 'object',
                properties: { common: { type: 'boolean' } },
              },
            ],
            additionalProperties: false,
          },
        },
      },
    } as const;
    const commonDiagnostics = lint('value.common', options);
    const nameDiagnostics = lint('value.name', options);
    const idDiagnostics = lint('value.id', options);

    expect(
      commonDiagnostics.filter(
        (diagnostic) =>
          diagnostic.message.includes('Unknown property') ||
          diagnostic.message.includes('not available on every member')
      )
    ).toHaveLength(0);
    expect(
      nameDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('Unknown property')
      )
    ).toHaveLength(0);
    expect(
      nameDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('not available on every member')
      )
    ).toHaveLength(1);
    expect(
      idDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('Unknown property')
      )
    ).toHaveLength(0);
    expect(
      idDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('not available on every member')
      )
    ).toHaveLength(1);
  });

  it('infers bare object keys and requires present non-literal properties', () => {
    const options = {
      runtime: {
        globals: { text: { type: 'string' } },
        functions: {
          acceptInteger: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'integer' } },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
          acceptRequired: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                      required: ['id'],
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    } as const;

    expect(lint('acceptInteger({id: text})', options)).toHaveLength(1);
    expect(lint('acceptRequired({id: text})', options)).toHaveLength(0);
  });

  it('rejects broad schemas for const and enum parameters', () => {
    const options = {
      runtime: {
        globals: { text: { type: 'string' } },
        functions: {
          acceptConst: {
            signatures: [
              { parameters: [{ schema: { const: 'x' } }], returns: true },
            ],
          },
          acceptEnum: {
            signatures: [
              { parameters: [{ schema: { enum: ['x'] } }], returns: true },
            ],
          },
        },
      },
    } as const;

    expect(lint('acceptConst(text)', options)).toHaveLength(1);
    expect(lint('acceptEnum(text)', options)).toHaveLength(1);
  });

  it('checks pattern properties and typed additional properties', () => {
    const options = {
      runtime: {
        globals: { text: { type: 'string' } },
        functions: {
          acceptPattern: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      patternProperties: { '^x-': { type: 'string' } },
                      additionalProperties: false,
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
          acceptTyped: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      additionalProperties: { type: 'integer' },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    } as const;

    expect(lint("acceptPattern({'x-id': text})", options)).toHaveLength(0);
    expect(lint("acceptTyped({'count': 'x'})", options)).toHaveLength(1);
  });

  it('requires properties to satisfy every matching pattern', () => {
    const diagnostics = lint('acceptInteger(value.x)', {
      runtime: {
        globals: {
          value: {
            type: 'object',
            patternProperties: {
              '^x': { type: 'integer' },
              x$: { type: 'string' },
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
      },
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('enforces pattern constraints alongside explicit properties', () => {
    const diagnostics = lint('acceptString(value.name)', {
      runtime: {
        globals: {
          value: {
            type: 'object',
            properties: { name: { type: 'string' } },
            patternProperties: { '^name$': { type: 'integer' } },
          },
        },
        functions: {
          acceptString: {
            signatures: [
              { parameters: [{ schema: { type: 'string' } }], returns: true },
            ],
          },
        },
      },
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('does not treat unrestricted extra properties as compatible', () => {
    const closedDiagnostics = lint('acceptClosed(open)', {
      runtime: {
        globals: {
          open: { type: 'object', additionalProperties: true },
        },
        functions: {
          acceptClosed: {
            signatures: [
              {
                parameters: [
                  { schema: { type: 'object', additionalProperties: false } },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });
    expect(
      closedDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(1);

    const typedDiagnostics = lint('acceptTyped(open)', {
      runtime: {
        globals: {
          open: { type: 'object', additionalProperties: true },
        },
        functions: {
          acceptTyped: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });
    expect(
      typedDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(1);
  });

  it('keeps branch-specific additional property constraints in allOf', () => {
    const patternPropertyDiagnostics = lint('acceptPatternProperty(source)', {
      runtime: {
        globals: {
          source: {
            type: 'object',
            patternProperties: { '^x': { type: 'string' } },
          },
        },
        functions: {
          acceptPatternProperty: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { x: { type: 'integer' } },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });
    expect(
      patternPropertyDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(1);

    const extraDiagnostics = lint('acceptExtra(source)', {
      runtime: {
        globals: {
          source: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        functions: {
          acceptExtra: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { x: { type: 'integer' } },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });
    expect(
      extraDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(1);

    const closedDiagnostics = lint('closedValue.extra', {
      runtime: {
        globals: {
          closedValue: {
            allOf: [
              { additionalProperties: false },
              {
                type: 'object',
                properties: { extra: { type: 'integer' } },
              },
            ],
          },
        },
      },
    });
    expect(
      closedDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('Unknown property')
      )
    ).toHaveLength(1);

    const typedDiagnostics = lint('acceptInteger(typedValue.extra)', {
      runtime: {
        globals: {
          typedValue: {
            allOf: [
              { additionalProperties: { type: 'string' } },
              {
                type: 'object',
                properties: { extra: { type: 'integer' } },
              },
            ],
          },
        },
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
    });
    expect(
      typedDiagnostics.filter((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toHaveLength(1);
  });

  it('checks source pattern properties against target patterns', () => {
    const diagnostics = lint('accept(source)', {
      runtime: {
        globals: {
          source: {
            type: 'object',
            patternProperties: { '^x': { type: 'string' } },
          },
        },
        functions: {
          accept: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      patternProperties: { '^x': { type: 'integer' } },
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('argument'))
    ).toBe(true);
  });

  it('filters impossible enum members from allOf intersections', () => {
    const diagnostics = lint('accept(value)', {
      runtime: {
        globals: {
          value: {
            allOf: [{ enum: ['valid', 1] }, { type: 'string' }],
          },
        },
        functions: {
          accept: {
            signatures: [
              { parameters: [{ schema: { enum: ['valid'] } }], returns: true },
            ],
          },
        },
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('decodes escaped object literal keys before schema matching', () => {
    const diagnostics = lint("accept({'a\\nb': 1})", {
      runtime: {
        functions: {
          accept: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { 'a\nb': { type: 'integer' } },
                      required: ['a\nb'],
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
        },
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('preserves required, items, and repeated const constraints in allOf', () => {
    const options = {
      runtime: {
        globals: {
          requiredValue: {
            allOf: [
              { required: ['id'] },
              { type: 'object', properties: { id: { type: 'string' } } },
            ],
          },
          itemsValue: {
            allOf: [{ items: { type: 'string' } }, { type: 'array' }],
          },
          constValue: { allOf: [{ const: 'x' }, { const: 'x' }] },
        },
        functions: {
          acceptRequired: {
            signatures: [
              {
                parameters: [
                  {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                      required: ['id'],
                    },
                  },
                ],
                returns: true,
              },
            ],
          },
          acceptItems: {
            signatures: [
              {
                parameters: [
                  { schema: { type: 'array', items: { type: 'integer' } } },
                ],
                returns: true,
              },
            ],
          },
          acceptConst: {
            signatures: [
              { parameters: [{ schema: { const: 'y' } }], returns: true },
            ],
          },
        },
      },
    } as const;

    expect(lint('acceptRequired(requiredValue)', options)).toHaveLength(0);
    expect(lint('acceptItems(itemsValue)', options)).toHaveLength(1);
    expect(lint('acceptConst(constValue)', options)).toHaveLength(1);
  });

  const primitiveTypes = [
    'string',
    'number',
    'integer',
    'boolean',
    'array',
    'null',
  ] as const;

  it.each(primitiveTypes)(
    'rejects property access on a function returning %s',
    (type) => {
      const diagnostics = lint("lookup('name').arbitrary", {
        runtime: {
          functions: {
            lookup: {
              signatures: [
                {
                  parameters: [{ name: 'name', schema: { type: 'string' } }],
                  returns: { type },
                },
              ],
            },
          },
        },
      });

      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes('Unknown property "arbitrary"')
        )
      ).toBe(true);
    }
  );

  it.each(primitiveTypes)(
    'rejects property access on a global of type %s',
    (type) => {
      const diagnostics = lint('value.arbitrary', {
        runtime: { globals: { value: { type } } },
      });

      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes('Unknown property "arbitrary"')
        )
      ).toBe(true);
    }
  );

  it('rejects property access on a function returning multiple types when none of them is an object', () => {
    const diagnostics = lint("lookup('name').arbitrary", {
      runtime: {
        functions: {
          lookup: {
            signatures: [
              {
                parameters: [{ name: 'name', schema: { type: 'string' } }],
                returns: { type: ['integer', 'null'] },
              },
            ],
          },
        },
      },
    });

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Unknown property "arbitrary"')
      )
    ).toBe(true);
  });

  it('rejects property access on a global with multiple types when none of them is an object', () => {
    const diagnostics = lint('value.arbitrary', {
      runtime: { globals: { value: { type: ['integer', 'null'] } } },
    });

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Unknown property "arbitrary"')
      )
    ).toBe(true);
  });

  it.each([
    ["'actual'", 'argument "actual"'],
    ['1', 'argument 1'],
    ['1.5', 'argument 1.5'],
    ['true', 'argument true'],
    ['null', 'argument null'],
    ["{'key': 'value'}", "argument of type '{ key: string }'"],
    ['[1]', "argument of type 'integer[]'"],
  ])(
    'describes the passed literal %s in mismatch diagnostics',
    (literal, expected) => {
      const diagnostics = lint(`accept(${literal})`, {
        runtime: {
          functions: {
            accept: {
              signatures: [
                {
                  parameters: [{ schema: { const: 'expected' } }],
                  returns: true,
                },
              ],
            },
          },
        },
      });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain(expected);
    }
  );

  it('checks object members, deprecation, arguments, methods, and access ranges', () => {
    const deprecated = lint('user.name', { runtime });
    const unknownProperty = lint('user.missing', { runtime });
    const mismatch = lint("lookup('x')", { runtime });
    const method = lint("'abc'.length()", { runtime });
    expect(deprecated.some((d) => d.message.includes('use displayName'))).toBe(
      true
    );
    expect(
      unknownProperty.some((d) => d.message.includes('Unknown property'))
    ).toBe(true);
    expect(mismatch.some((d) => d.message.includes('argument'))).toBe(true);
    expect(mismatch[0].message).toContain('argument "x"');
    expect(mismatch[0].message).toContain("'integer'");
    expect(method.some((d) => d.message.includes('Invalid method'))).toBe(
      false
    );
    expect(
      [...deprecated, ...unknownProperty, ...mismatch, ...method].every(
        (d) => d.from >= 0 && d.to >= d.from
      )
    ).toBe(true);
  });

  it('validates arithmetic with an empty runtime', () => {
    expect(
      lint('true + false').some((diagnostic) =>
        diagnostic.message.includes("Operator '+' cannot be applied")
      )
    ).toBe(true);
  });

  it('reports arithmetic applied to booleans on either side', () => {
    for (const expression of ['true + false', 'true + 1', '1 + false']) {
      const diagnostics = lint(expression, { runtime });
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes("Operator '+' cannot be applied")
        )
      ).toBe(true);
    }

    for (const expression of [
      'true - 1',
      '1 - false',
      'true * 2',
      '2 * false',
      'true / 2',
      '2 / false',
    ]) {
      const diagnostics = lint(expression, { runtime });
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.message.includes('Operator') &&
            (diagnostic.message.includes("Operator '-' cannot be applied") ||
              diagnostic.message.includes("Operator '*' cannot be applied") ||
              diagnostic.message.includes("Operator '/' cannot be applied"))
        )
      ).toBe(true);
    }
  });

  it('enforces required properties and strict local lambda arity', () => {
    const diagnostics = lint('val f = x -> x; f(1, 2)', {
      runtime: {
        globals: {
          value: {
            type: 'object',
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
            required: ['id', 'name'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(diagnostics.some((d) => d.message.includes('arity'))).toBe(true);
  });
});
