import { describe, expect, it } from 'vitest';
import type { OpelRuntime } from '../../src';
import { lint } from '../support/test-utils';

const runtime: OpelRuntime = {
  functions: {
    clockNow: {
      signatures: [{ parameters: [], returns: { $ref: 'CalendarInstant' } }],
    },
    localNow: {
      signatures: [{ parameters: [], returns: { $ref: 'LocalInstant' } }],
    },
  },
  schemas: {
    CalendarInstant: { type: 'object' },
    LocalInstant: { $ref: 'CalendarInstant' },
  },
  methods: {
    CalendarInstant: {
      moveByDays: {
        signatures: [
          {
            parameters: [{ name: 'days', schema: { type: 'integer' } }],
            returns: { $ref: 'CalendarInstant' },
          },
        ],
      },
      renderAs: {
        signatures: [
          {
            parameters: [{ name: 'style', schema: { type: 'string' } }],
            returns: { type: 'string' },
          },
        ],
      },
      moveBy: {
        signatures: [
          {
            parameters: [{ schema: { type: 'integer' } }],
            returns: { $ref: 'CalendarInstant' },
          },
          {
            parameters: [{ schema: { type: 'string' } }],
            returns: { $ref: 'CalendarInstant' },
          },
        ],
      },
      normalize: {
        signatures: [{ parameters: [], returns: { $ref: 'CalendarInstant' } }],
      },
      deprecatedMove: {
        deprecated: true,
        signatures: [{ parameters: [], returns: { $ref: 'CalendarInstant' } }],
      },
      legacyMove: {
        deprecated: 'use moveByDays',
        signatures: [{ parameters: [], returns: { $ref: 'CalendarInstant' } }],
      },
    },
    LocalInstant: {
      toLocalZone: {
        signatures: [{ parameters: [], returns: { $ref: 'LocalInstant' } }],
      },
      normalize: {
        signatures: [{ parameters: [], returns: { type: 'string' } }],
      },
    },
    object: {
      normalize: {
        signatures: [{ parameters: [], returns: { type: 'string' } }],
      },
    },
    number: {
      round: {
        signatures: [{ parameters: [], returns: { type: 'number' } }],
      },
    },
    string: {
      upper: {
        signatures: [{ parameters: [], returns: { type: 'string' } }],
      },
    },
  },
};

describe('named schema method receivers', () => {
  it('resolves named methods and validates arguments', () => {
    expect(lint('clockNow().moveByDays(1)', { runtime })).toHaveLength(0);
    expect(
      lint("clockNow().moveByDays('one')", { runtime }).some((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toBe(true);
  });

  it('preserves named return schemas through chained calls', () => {
    expect(
      lint("clockNow().moveByDays(1).renderAs('date-only')", { runtime })
    ).toHaveLength(0);
  });

  it('lists named methods in unknown-method diagnostics', () => {
    const diagnostics = lint('clockNow().unknownMethod()', { runtime });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain(
      'Invalid method "unknownMethod" on type CalendarInstant.'
    );
    expect(diagnostics[0].message).toContain('"moveByDays"');
    expect(diagnostics[0].message).toContain('"renderAs"');
  });

  it('does not leak named methods to ordinary objects', () => {
    expect(
      lint("({'value': 1}).moveByDays(1)", { runtime }).some((diagnostic) =>
        diagnostic.message.includes('Invalid method "moveByDays"')
      )
    ).toBe(true);
  });

  it('supports overloads and deprecation metadata', () => {
    expect(lint('clockNow().moveBy(1)', { runtime })).toHaveLength(0);
    expect(lint("clockNow().moveBy('tomorrow')", { runtime })).toHaveLength(0);
    expect(
      lint('clockNow().moveBy(true)', { runtime }).some((diagnostic) =>
        diagnostic.message.includes('argument')
      )
    ).toBe(true);
    expect(lint('clockNow().deprecatedMove()', { runtime })[0]?.message).toBe(
      'Deprecated.'
    );
    expect(lint('clockNow().legacyMove()', { runtime })[0]?.message).toBe(
      'use moveByDays'
    );
  });

  it('inherits alias methods and prefers named methods over primitives', () => {
    expect(
      lint('localNow().toLocalZone().moveByDays(1)', { runtime })
    ).toHaveLength(0);
    expect(
      lint('clockNow().normalize().moveByDays(1)', { runtime })
    ).toHaveLength(0);
    expect(lint('localNow().normalize().upper()', { runtime })).toHaveLength(0);
  });

  it('does not treat local references as named receivers', () => {
    const diagnostics = lint('local.moveByDays(1)', {
      runtime: {
        ...runtime,
        globals: {
          local: {
            $ref: '#/$defs/CalendarInstant',
            $defs: { CalendarInstant: { type: 'object' } },
          },
        },
      },
    });

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Invalid method "moveByDays"')
      )
    ).toBe(true);
  });

  it('keeps primitive receivers and integer-to-number fallback working', () => {
    expect(lint("'x'.upper()", { runtime })).toHaveLength(0);
    expect(lint('1.round()', { runtime })).toHaveLength(0);
  });

  it('reports unknown receiver registrations as unresolved references', () => {
    const issues: { code: string; path: string; message: string }[] = [];

    lint('value', {
      runtime: { schemas: {}, methods: { MissingSchema: {} } },
      onRuntimeIssues: (next) => issues.push(...next),
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'unresolved-reference',
        path: '/methods/MissingSchema',
        message: 'unresolved method receiver "MissingSchema"',
      })
    );
  });
});
