import { describe, expect, it } from 'vitest';
import { resolveSchemaReference } from '../../src/linter/schema';
import type { OpelRuntime, OpelSchema } from '../../src/types';

describe('schema reference cycle guards', () => {
  it.each(['$defs', 'definitions'])(
    'stops a repeated local %s reference in the same document',
    (definitions) => {
      const loop: OpelSchema = { $ref: `#/${definitions}/Value` };
      const root: OpelSchema = {
        $ref: `#/${definitions}/Value`,
        [definitions]: { Value: loop },
      };
      const resolved = resolveSchemaReference(root, root, {});

      expect(resolved.schema).toBe(loop);
      expect(resolved.root).toBe(root);
    }
  );

  it('stops a named reference cycle across schema documents', () => {
    const a: OpelSchema = { $ref: 'B' };
    const b: OpelSchema = { $ref: 'A' };
    const runtime: OpelRuntime = { schemas: { A: a, B: b } };
    const entry: OpelSchema = { $ref: 'A' };
    const resolved = resolveSchemaReference(entry, entry, runtime);

    expect([a, b]).toContain(resolved.schema);
    expect([a, b]).toContain(resolved.root);
  });
});
