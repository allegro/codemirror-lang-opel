import { describe, expect, it } from 'vitest';
import type {
  OpelRuntime,
  OpelRuntimeIssue,
  OpelSchema,
} from '../../src/types';
import { lint } from '../support/test-utils';

describe('runtime inference regressions', () => {
  it.each([
    ['!false', true, false],
    ['!true', false, true],
    ['!!true', true, false],
    ['-1', -1, 1],
    ['-(-2)', 2, -2],
  ])(
    'infers the complete unary expression %s',
    (expression, expected, wrong) => {
      const runtime: OpelRuntime = {
        functions: {
          accept: {
            signatures: [
              { parameters: [{ schema: { const: expected } }], returns: true },
            ],
          },
          reject: {
            signatures: [
              { parameters: [{ schema: { enum: [wrong] } }], returns: true },
            ],
          },
        },
      };
      expect(lint(`accept(${expression})`, { runtime })).toHaveLength(0);
      expect(lint(`reject(${expression})`, { runtime })).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('Type mismatch'),
        })
      );
    }
  );

  it('discards numeric constraints changed by unary minus', () => {
    const runtime: OpelRuntime = {
      globals: { positive: { type: 'integer', enum: [1, 2] } },
      functions: {
        accept: {
          signatures: [
            {
              parameters: [{ schema: { type: 'integer' } }],
              returns: true,
            },
          ],
        },
        acceptPositive: {
          signatures: [
            { parameters: [{ schema: { enum: [1, 2] } }], returns: true },
          ],
        },
      },
    };
    expect(lint('accept(-positive)', { runtime })).toHaveLength(0);
    expect(lint('acceptPositive(-positive)', { runtime })).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      })
    );
  });

  it.each([
    'val f = x -> { y -> x + y }; f(2)(3)',
    '(if (flag) foo else bar)(1)',
    'val f = if (flag) foo else bar; f(1)',
    '(if (flag) foo else 1)(1)',
    'unknown()',
    'unknownFactory()(1)',
  ])('keeps unmodeled callability permissive: %s', (expression) => {
    expect(
      lint(expression, {
        warnOnLambdaDefinitions: false,
        runtime: {
          globals: { flag: { type: 'boolean' }, unknown: true },
          functions: {
            unknownFactory: { signatures: [{ parameters: [], returns: true }] },
            foo: {
              signatures: [
                {
                  parameters: [{ schema: { type: 'integer' } }],
                  returns: { type: 'integer' },
                },
              ],
            },
            bar: {
              signatures: [
                {
                  parameters: [{ schema: { type: 'integer' } }],
                  returns: { type: 'integer' },
                },
              ],
            },
          },
        },
      }).filter((diagnostic) => diagnostic.severity === 'error')
    ).toEqual([]);
  });

  it.each(['val f = 1; f()', '(1)(2)', '(if (true) 1 else false)()'])(
    'still rejects known non-callable values: %s',
    (expression) => {
      expect(lint(expression)).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('not callable'),
        })
      );
    }
  );

  it.each([
    ['[]', false],
    ['[1]', true],
    ['[[]]', true],
  ])('checks false item schemas for %s', (expression, rejects) => {
    const diagnostics = lint(`accept(${expression})`, {
      runtime: {
        functions: {
          accept: {
            signatures: [
              {
                parameters: [{ schema: { type: 'array', items: false } }],
                returns: true,
              },
            ],
          },
        },
      },
    });
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Type mismatch')
      )
    ).toBe(rejects);
  });

  it('checks false item schemas inside nested literal arrays', () => {
    const runtime: OpelRuntime = {
      functions: {
        accept: {
          signatures: [
            {
              parameters: [
                {
                  schema: {
                    type: 'array',
                    items: { type: 'array', items: false },
                  },
                },
              ],
              returns: true,
            },
          ],
        },
      },
    };
    expect(lint('accept([[]])', { runtime })).toHaveLength(0);
    expect(lint('accept([[1]])', { runtime })).toContainEqual(
      expect.objectContaining({ severity: 'error' })
    );
  });

  it.each([42, 'value', null, {}])(
    'rejects malformed enum metadata: %j',
    (enumValue) => {
      const issues: OpelRuntimeIssue[] = [];
      const diagnostics = lint('accept(1)', {
        runtime: {
          functions: {
            accept: {
              signatures: [
                {
                  parameters: [{ schema: { enum: enumValue as never } }],
                  returns: true,
                },
              ],
            },
          },
        },
        onRuntimeIssues: (next) => issues.push(...next),
      });
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'invalid-schema',
          path: '/functions/accept/signatures/0/parameters/0/schema/enum',
          severity: 'error',
        })
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: 'Unknown function "accept".' })
      );
    }
  );

  it.each([
    [{}, 'invalid-runtime-entry', ''],
    [{ signatures: [{}] }, 'invalid-signature', '/signatures/0'],
    [
      { signatures: [{ parameters: [], returns: { enum: 42 } }] },
      'invalid-schema',
      '/signatures/0/returns/enum',
    ],
    [
      { signatures: [{ parameters: [], returns: { $ref: 'Missing' } }] },
      'unresolved-reference',
      '/signatures/0/returns/$ref',
    ],
    [
      {
        signatures: [
          { parameters: [{ schema: true, optional: 'yes' }], returns: true },
        ],
      },
      'invalid-signature',
      '/signatures/0/parameters/0/optional',
    ],
  ])('validates embedded callable metadata: %j', (callable, code, suffix) => {
    const issues: OpelRuntimeIssue[] = [];
    const diagnostics = lint('(obj.cb)()', {
      runtime: {
        globals: {
          obj: {
            type: 'object',
            properties: { cb: { callable: callable as never } },
          },
        },
      },
      onRuntimeIssues: (next) => issues.push(...next),
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        code,
        path: `/globals/obj/properties/cb/callable${suffix}`,
        severity: 'error',
      })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Unknown symbol "obj"'),
      })
    );
  });

  it('preserves recursive schemas returned by callable properties', () => {
    const issues: OpelRuntimeIssue[] = [];
    const diagnostics = lint('(obj.cb)().cb', {
      runtime: {
        globals: { obj: { $ref: 'Node' } },
        schemas: {
          Node: {
            type: 'object',
            properties: {
              cb: {
                callable: {
                  signatures: [{ parameters: [], returns: { $ref: 'Node' } }],
                },
              },
            },
          },
        },
      },
      onRuntimeIssues: (next) => issues.push(...next),
    });
    expect(issues).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('bounds validation of deeply nested callable schemas', () => {
    let schema: OpelSchema = true;
    for (let index = 0; index < 130; index++) {
      schema = {
        callable: { signatures: [{ parameters: [], returns: schema }] },
      };
    }
    const issues: OpelRuntimeIssue[] = [];
    lint('1', {
      runtime: { globals: { deep: schema } },
      onRuntimeIssues: (next) => issues.push(...next),
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-schema',
        message: expect.stringContaining('maximum depth'),
      })
    );
  });
});
