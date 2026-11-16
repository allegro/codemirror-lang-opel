import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';
import type { OpelSchema } from '../../src/types';

function options(additionalProperties?: boolean | OpelSchema) {
  return {
    runtime: {
      functions: {
        entries: {
          signatures: [
            {
              parameters: [],
              returns: {
                type: 'array' as const,
                items: {
                  type: 'object' as const,
                  properties: {
                    label: { type: 'string' as const },
                    '0': { type: 'string' as const },
                  },
                  ...(additionalProperties === undefined
                    ? {}
                    : { additionalProperties }),
                },
              },
            },
          ],
        },
        index: {
          signatures: [
            { parameters: [], returns: { type: 'integer' as const } },
          ],
        },
        key: {
          signatures: [
            { parameters: [], returns: { type: 'string' as const } },
          ],
        },
      },
    },
  };
}

describe('member access diagnostics', () => {
  it('explains direct property access on a list without cascading', () => {
    const code = 'entries().label.missing()[0].other()';
    const diagnostics = lint(code, options());

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      from: code.indexOf('.label'),
      to: code.indexOf('.label') + '.label'.length,
    });
    expect(diagnostics[0].message).toContain('on a list');
    expect(diagnostics[0].message).toContain('Select a list item first');
  });

  it.each([undefined, false, true, { type: 'string' } as const])(
    'rejects numeric object keys regardless of additionalProperties: %j',
    (additionalProperties) => {
      for (const key of ['0', 'index()']) {
        const code = `entries()[0][${key}].label.missing()[0].other()`;
        const diagnostics = lint(code, options(additionalProperties));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          severity: 'error',
          from: code.indexOf(`[${key}]`, 'entries()[0]'.length),
          to: code.indexOf(`[${key}]`, 'entries()[0]'.length) + key.length + 2,
        });
        expect(diagnostics[0].message).toContain('Numeric indices');
      }
    }
  );

  it('accepts list indices, string keys, and dynamic strings', () => {
    for (const code of [
      'entries()[0].label',
      "entries()[0]['label']",
      "entries()[0]['0']",
      'entries()[0][key()]',
    ]) {
      expect(lint(code, options(true))).toHaveLength(0);
    }
  });

  it('preserves warnings and errors for missing string properties', () => {
    expect(lint("entries()[0]['missing']", options())[0].severity).toBe(
      'warning'
    );
    expect(lint("entries()[0]['missing']", options(false))[0].severity).toBe(
      'error'
    );
  });

  it('does not assume an unknown or mixed key is numeric', () => {
    for (const schema of [
      true,
      { type: ['integer', 'string'] } as const,
      { anyOf: [{ type: 'integer' }, true] } as const,
    ]) {
      expect(
        lint('object[key]', {
          runtime: {
            globals: {
              object: { type: 'object', additionalProperties: true },
              key: schema,
            },
          },
        })
      ).toHaveLength(0);
    }
  });
});
