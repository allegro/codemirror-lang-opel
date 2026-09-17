import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

describe('runtime configuration', () => {
  it('reports duplicate symbols and disables runtime semantics atomically', () => {
    const issues: { code: string; path: string; severity: string }[] = [];
    const diagnostics = lint('missing', {
      runtime: {
        globals: { same: { type: 'string' } },
        functions: {
          same: { signatures: [{ parameters: [], returns: true }] },
        },
      },
      onRuntimeIssues: (next) => issues.push(...next),
    });

    expect(issues.some((issue) => issue.code === 'duplicate-symbol')).toBe(
      true
    );
    expect(issues.every((issue) => issue.path.startsWith('/'))).toBe(true);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('Unknown symbol')
      )
    ).toBe(true);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('duplicate-symbol')
      )
    ).toBe(false);
  });

  it('clones the runtime metadata and warns once for malformed presentation metadata', () => {
    const issues: {
      code: string;
      severity: string;
      message: string;
      path: string;
    }[] = [];
    const runtime = {
      globals: { user: { type: 'string', title: 42 as unknown as string } },
    };

    lint('user', {
      runtime,
      onRuntimeIssues: (next) => issues.push(...next),
    });
    runtime.globals.user = { type: 'integer' };

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('invalid-metadata');
    expect(issues[0].severity).toBe('warning');
  });
});
