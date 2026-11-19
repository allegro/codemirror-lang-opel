import { describe, expect, it } from 'vitest';
import type { OpelRuntime } from '../../src/types';
import { lint } from '../support/test-utils';

const runtime: OpelRuntime = {
  globals: { axisScale: { type: 'string' } },
};

describe('runtime-aware variable bindings', () => {
  it('errors once when a local shadows a runtime global and resolves reads locally', () => {
    const source = 'val axisScale = 1; axisScale - axisScale';
    const diagnostics = lint(source, { runtime });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        from: 4,
        to: 13,
        severity: 'error',
        message: "Cannot redeclare runtime global 'axisScale'",
      }),
    ]);
  });

  it('does not error without the corresponding runtime global', () => {
    expect(lint('val axisScale = 1; axisScale - axisScale')).toHaveLength(0);
  });

  it('reports both shadowing and unused locals at the declaration', () => {
    const diagnostics = lint('val axisScale = 1; 0', { runtime });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cannot redeclare runtime global'),
        expect.stringContaining('is declared but never used'),
      ])
    );
    expect(
      diagnostics.every(
        (diagnostic) => diagnostic.from === 4 && diagnostic.to === 13
      )
    ).toBe(true);
  });

  it('resolves the initializer against the global before adding the local binding', () => {
    const diagnostics = lint('val axisScale = axisScale; axisScale', {
      runtime,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe(
      "Cannot redeclare runtime global 'axisScale'"
    );
  });

  it('errors when a local val uses a runtime function name', () => {
    const diagnostics = lint('val sketch = 1; sketch', {
      runtime: {
        functions: {
          sketch: {
            signatures: [{ parameters: [], returns: { type: 'integer' } }],
          },
        },
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        from: 4,
        to: 10,
        severity: 'error',
        message: "Cannot redeclare runtime global function 'sketch'",
      }),
    ]);
  });

  it('tracks reads by binding identity through lambda shadowing and local calls', () => {
    const source = 'val angle = 1; val rotate = angle -> angle + 1; rotate(2)';
    const diagnostics = lint(source);
    const unused = diagnostics.filter((diagnostic) =>
      diagnostic.message.includes('is declared but never used')
    );

    expect(unused).toHaveLength(1);
    expect(unused[0]).toMatchObject({ from: 4, to: 9 });
    expect(unused[0].message).toContain('Variable "angle"');
  });

  it('preserves one use-before-declaration diagnostic without an unknown-symbol duplicate', () => {
    const diagnostics = lint("val a = foo; val foo = 'x'; a");

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
});
