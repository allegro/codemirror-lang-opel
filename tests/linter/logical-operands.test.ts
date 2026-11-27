import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

const runtime = {
  globals: { maybe: { $ref: 'nullableBoolean' } },
  functions: {
    foo: {
      signatures: [
        { parameters: [], returns: { type: 'integer', nullable: true } },
      ],
    },
    unknown: {
      signatures: [{ parameters: [], returns: true }],
    },
  },
  schemas: {
    nullableBoolean: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
  },
} as const;

describe('logical operand types', () => {
  it.each([
    ['true && 200', '&&', '200', 'integer'],
    ['200 && true', '&&', '200', 'integer'],
    ['false || 200', '||', '200', 'integer'],
    ['200 || false', '||', '200', 'integer'],
    ['!200', '!', '200', 'integer'],
    ['!null', '!', 'null', 'null'],
    ['!maybe', '!', 'maybe', 'nullableBoolean'],
    ["true && 'true'", '&&', "'true'", 'string'],
    ['val bar = true; bar && foo()', '&&', 'foo()', 'integer | null'],
  ])(
    'reports the incompatible operand in %s',
    (code, operator, operand, type) => {
      const from = code.indexOf(operand);
      expect(lint(code, { runtime })).toEqual([
        expect.objectContaining({
          from,
          to: from + operand.length,
          severity: 'error',
          message: expect.stringContaining(
            `Operator '${operator}' cannot be applied to type '${type}'.`
          ),
        }),
      ]);
    }
  );

  it('reports each incompatible operand once in a chain', () => {
    const code = '!(true && 200 && 300 && false)';
    const diagnostics = lint(code, { runtime });

    expect(diagnostics.map(({ from, to }) => code.slice(from, to))).toEqual([
      '200',
      '300',
    ]);
  });

  it.each([
    'true && !false || true',
    'null && true',
    'false || null',
    'maybe && true || maybe',
    'unknown() && !unknown()',
    'val bar = true; bar && (foo() == 404)',
  ])('accepts %s', (code) => {
    expect(lint(code, { runtime })).toEqual([]);
  });

  it('preserves the diagnostic for an operand with an existing error', () => {
    expect(lint('!missing()')).toEqual([
      expect.objectContaining({ message: 'Unknown function "missing".' }),
    ]);
  });

  it('avoids a follow-on type error when a logical expression is invalid', () => {
    expect(lint('(!200) + 1')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Operator '!' cannot be applied"),
      }),
    ]);
  });
});
