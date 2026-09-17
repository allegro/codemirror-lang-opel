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
};

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
    expect(runtimeTypo[0].message).not.toContain('Available symbols:');

    const localTypo = lint("val user = 'x'; useer", { runtime });
    expect(localTypo).toHaveLength(1);
    expect(localTypo[0].message).toContain('Did you mean: user?');
    expect(localTypo[0].message).not.toContain('Available symbols:');
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
    expect(mismatch[0].message).toContain("'string'");
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
        diagnostics.some((diagnostic) =>
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
