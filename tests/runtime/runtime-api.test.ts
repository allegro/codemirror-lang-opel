import { describe, expect, it } from 'vitest';
import type {
  OpelCallable,
  OpelRuntime,
  OpelSchema,
  OpelRuntimeIssue,
} from '../../src';
import { lint } from '../support/test-utils';

const userSchema: OpelSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string', deprecated: 'use displayName' },
  },
  required: ['id'],
  additionalProperties: false,
};

const lookup: OpelCallable = {
  signatures: [
    {
      parameters: [
        { name: 'id', schema: { type: 'integer' } },
        { name: 'verbose', schema: { type: 'boolean' }, optional: true },
      ],
      returns: userSchema,
      deprecated: false,
    },
  ],
};

const runtime: OpelRuntime = {
  globals: { user: userSchema },
  functions: { lookup },
  methods: {
    object: { keys: lookup },
    string: {
      length: {
        signatures: [{ parameters: [], returns: { type: 'integer' } }],
      },
    },
  },
  schemas: { User: userSchema },
};

const partialMethodsRuntime: OpelRuntime = {
  methods: {
    string: {
      length: {
        signatures: [{ parameters: [], returns: { type: 'integer' } }],
      },
    },
  },
};

describe('runtime API', () => {
  it('accepts the public runtime contract and exposes runtime diagnostics separately', () => {
    const issues: OpelRuntimeIssue[] = [];
    expect(() =>
      lint('user.name', {
        runtime,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).not.toThrow();
    expect(issues).toHaveLength(0);
    expect(() =>
      lint("'abc'.length()", {
        runtime: partialMethodsRuntime,
        onRuntimeIssues: (next) => issues.push(...next),
      })
    ).not.toThrow();
    expect(issues).toHaveLength(0);
  });
});
