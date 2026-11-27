import { describe, expect, it } from 'vitest';
import type { OpelRuntime } from '../../src/types';
import { lint } from '../support/test-utils';

const runtime: OpelRuntime = {
  globals: {
    runtimeKey: { type: 'string' },
    runtimeValue: { type: 'string' },
    numericKey: { type: 'integer' },
    otherKey: { type: 'string', enum: ['other'] },
    finiteKey: { type: 'string', enum: ['other', 'third'] },
    idKey: { type: 'string', const: 'id', enum: ['id', 'other'] },
    possibleIdKey: { type: 'string', enum: ['id', 'other'] },
    mixedKey: { enum: [1, 'id'] },
    mixedTypeKey: {
      anyOf: [{ enum: ['id', 'other'] }, { type: 'integer' }],
    },
    unknownLastKey: { anyOf: [{ enum: ['other', 'third'] }, true] },
    unknownFirstKey: { anyOf: [true, { enum: ['other', 'third'] }] },
    otherMixedKey: { enum: ['other', 1] },
    otherMixedTypeKey: {
      anyOf: [{ enum: ['other', 'third'] }, { type: 'integer' }],
    },
    invalidTypeKey: {
      anyOf: [{ type: 'integer', enum: ['id'] }, { const: 'other' }],
    },
    invalidConstKey: {
      anyOf: [{ const: 'id', enum: ['other'] }, { const: 'other' }],
    },
  },
  functions: {
    makeKey: {
      signatures: [
        { parameters: [], returns: { type: 'string', const: 'name' } },
      ],
    },
    nextKey: {
      signatures: [{ parameters: [], returns: { type: 'string' } }],
    },
    makeValue: {
      signatures: [
        {
          parameters: [],
          returns: {
            $ref: '#/$defs/Result',
            $defs: {
              Result: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
              },
            },
          },
        },
      ],
    },
    acceptInteger: {
      signatures: [
        { parameters: [{ schema: { type: 'integer' } }], returns: true },
      ],
    },
    acceptString: {
      signatures: [
        { parameters: [{ schema: { type: 'string' } }], returns: true },
      ],
    },
    acceptIntegerMap: {
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
    acceptStringMap: {
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
    acceptOptionalId: {
      signatures: [
        {
          parameters: [
            {
              schema: {
                type: 'object',
                properties: { id: { type: 'integer' } },
                additionalProperties: { type: 'string' },
              },
            },
          ],
          returns: true,
        },
      ],
    },
  },
};

describe('runtime-compatible map keys', () => {
  it('uses the variable value as the property name', () => {
    const source = "val key = 'name'; val value = 1; val map = {key: value};";

    expect(lint(`${source} acceptInteger(map.name)`, { runtime })).toEqual([]);
    expect(lint(`${source} acceptString(map.name)`, { runtime })).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("argument of type 'integer'"),
      }),
    ]);
    expect(lint("val key = 'name'; val map = {key: 1}; map.key")).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Property "key" is not defined'),
      }),
    ]);
  });

  it('keeps quoted keys literal', () => {
    expect(lint("val key = 'other'; val map = {'key': key}; map.key")).toEqual(
      []
    );
  });

  it('reports an unknown variable used as a map key', () => {
    expect(lint('{missingKey: 1}')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Unknown symbol "missingKey".',
      }),
    ]);
  });

  it.each([
    {
      name: 'joined strings',
      source: "val value = 1; val map = {('x' + 'y'): value};",
      read: 'map.xy',
    },
    {
      name: 'a variable joined with a string',
      source: "val key = 'x'; val value = 1; val map = {(key + 'y'): value};",
      read: 'map.xy',
    },
    {
      name: 'a parenthesized string',
      source: "val value = 1; val map = {('name'): value};",
      read: 'map.name',
    },
    {
      name: 'an object property',
      source:
        "val config = {'name': 'x'}; val value = 1; val map = {config.name: value};",
      read: 'map.x',
    },
    {
      name: 'a function result',
      source: 'val value = 1; val map = {makeKey(): value};',
      read: 'map.name',
    },
    {
      name: 'an unknown runtime key',
      source: 'val value = 1; val map = {runtimeKey: value};',
      read: 'map.name',
    },
  ])('keeps the value type when the key is $name', ({ source, read }) => {
    expect(lint(`${source} acceptInteger(${read})`, { runtime })).toEqual([]);
    expect(lint(`${source} acceptString(${read})`, { runtime })).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("argument of type 'integer'"),
      }),
    ]);
  });

  it.each(['1', 'true', 'null'])(
    'tracks value reads with a non-string key: %s',
    (key) => {
      expect(
        lint(`val value = 1; val map = {${key}: value}; map[${key}]`)
      ).toEqual([]);
    }
  );

  it('tracks reads when a key variable contains a number', () => {
    expect(
      lint('val key = 2; val value = 1; val map = {key: value}; map[key]')
    ).toEqual([]);
  });

  it.each([
    ['map.missing', 'missing'],
    ["map['1']", '1'],
  ])('rejects %s on a map with only a numeric key', (access, name) => {
    expect(lint(`val map = {1: 42}; ${access}`)).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining(`Property "${name}" is not defined`),
      }),
    ]);
  });

  it('only uses entries that can match the requested string key', () => {
    const source = 'val map = {1: 42, mixedKey: runtimeValue};';

    expect(lint(`${source} acceptInteger(map.id)`, { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'string'"),
      }),
    ]);
    expect(lint(`${source} map.missing`, { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Property "missing" is not defined'),
      }),
    ]);
  });

  it('reports errors in both the computed key and its value', () => {
    expect(lint('{missingKey(): missingValue}')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Unknown function "missingKey".',
      }),
      expect.objectContaining({
        severity: 'error',
        message: 'Unknown symbol "missingValue".',
      }),
    ]);
  });

  it('treats __proto__ as a regular property name', () => {
    expect(
      lint(
        "val key = '__proto__'; val map = {key: runtimeValue}; acceptInteger(map['__proto__'])",
        { runtime }
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'string'"),
      }),
    ]);
  });

  it.each(['1', 'runtimeKey', 'makeKey()'])(
    'checks map values when the key is %s',
    (key) => {
      expect(lint(`acceptIntegerMap({${key}: 1})`, { runtime })).toEqual([]);
      expect(
        lint(`acceptIntegerMap({${key}: runtimeValue})`, { runtime })
      ).toEqual([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('Type mismatch'),
        }),
      ]);
    }
  );

  it('keeps a returned object property type when the map key is unknown', () => {
    const source = 'val map = {runtimeKey: makeValue()};';

    expect(lint(`${source} acceptString(map.name.id)`, { runtime })).toEqual(
      []
    );
    expect(lint(`${source} acceptInteger(map.name.id)`, { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'string'"),
      }),
    ]);
  });

  it('keeps the integer type when both possible values are integers', () => {
    const source = "val map = {'id': 1, runtimeKey: 2};";

    expect(lint(`${source} acceptInteger(map.id)`, { runtime })).toEqual([]);
    expect(lint(`${source} acceptString(map.id)`, { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it.each([
    { name: 'a number', key: 'numericKey' },
    { name: 'another string', key: 'otherKey' },
    { name: 'another string or a number', key: 'otherMixedKey' },
    { name: 'separate string and number choices', key: 'otherMixedTypeKey' },
  ])('keeps the id type when the later key cannot be id: $name', ({ key }) => {
    expect(
      lint(`val map = {'id': 1, ${key}: runtimeValue}; acceptString(map.id)`, {
        runtime,
      })
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'integer'"),
      }),
    ]);
  });

  it.each([
    { name: 'any string', key: 'runtimeKey' },
    { name: 'a string or number', key: 'mixedKey' },
    { name: 'separate string and number choices', key: 'mixedTypeKey' },
    { name: 'an unknown alternative last', key: 'unknownLastKey' },
    { name: 'an unknown alternative first', key: 'unknownFirstKey' },
  ])(
    'keeps both value types when the later key could be id: $name',
    ({ key }) => {
      expect(
        lint(
          `val map = {'id': 1, ${key}: runtimeValue}; acceptInteger(map.id)`,
          {
            runtime,
          }
        )
      ).toEqual([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining(
            "argument of type 'integer | string'"
          ),
        }),
      ]);
    }
  );

  it('uses the later id value when an earlier key could also be id', () => {
    expect(
      lint(
        "val map = {runtimeKey: runtimeValue, 'id': 1}; acceptString(map.id)",
        {
          runtime,
        }
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'integer'"),
      }),
    ]);
  });

  it('uses the last value when literal and variable keys collide', () => {
    expect(
      lint(
        "val key = 'id'; val map = {'id': 1, key: runtimeValue}; acceptStringMap(map)",
        { runtime }
      )
    ).toEqual([]);
    expect(
      lint(
        "val key = 'id'; val map = {key: runtimeValue, 'id': 1}; acceptStringMap(map)",
        { runtime }
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it.each([
    {
      name: 'a captured key',
      source: 'val k = runtimeKey; acceptIntegerMap({k: runtimeValue, k: 1})',
    },
    {
      name: 'a runtime key',
      source: 'acceptIntegerMap({runtimeKey: runtimeValue, runtimeKey: 1})',
    },
    {
      name: 'an alias of a captured key',
      source:
        'val k = runtimeKey; val alias = k; acceptIntegerMap({k: runtimeValue, alias: 1})',
    },
  ])('uses the last value for $name', ({ source }) => {
    expect(lint(source, { runtime })).toEqual([]);
  });

  it('removes an overwritten value from named property types', () => {
    const source =
      "val k = runtimeKey; val map = {'id': 1, k: runtimeValue, k: 2};";

    expect(lint(`${source} acceptInteger(map.id)`, { runtime })).toEqual([]);
    expect(lint(`${source} acceptString(map.id)`, { runtime })).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it('still checks expressions in overwritten entries', () => {
    expect(
      lint('val k = runtimeKey; val map = {k: missingValue, k: 1}; map', {
        runtime,
      })
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Unknown symbol "missingValue"'),
      }),
    ]);
  });

  it('allows separate function calls to produce different keys', () => {
    expect(
      lint('acceptIntegerMap({nextKey(): runtimeValue, nextKey(): 1})', {
        runtime,
      })
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it("accepts keys that can only be 'other' or 'third'", () => {
    expect(
      lint('acceptOptionalId({finiteKey: runtimeValue})', { runtime })
    ).toEqual([]);
  });

  it.each([
    { name: 'a string outside the declared type', key: 'invalidTypeKey' },
    {
      name: 'a fixed value outside the allowed choices',
      key: 'invalidConstKey',
    },
  ])('ignores $name when checking possible keys', ({ key }) => {
    expect(
      lint(`acceptOptionalId({${key}: runtimeValue})`, { runtime })
    ).toEqual([]);
  });

  it('uses the fixed key even when other names are listed', () => {
    expect(lint('acceptStringMap({idKey: runtimeValue})', { runtime })).toEqual(
      []
    );
  });

  it.each([
    { name: 'another name', key: 'possibleIdKey' },
    { name: 'a number', key: 'mixedKey' },
  ])('reports a missing required id when the key could be $name', ({ key }) => {
    expect(
      lint(`acceptStringMap({${key}: runtimeValue})`, { runtime })
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it('checks the optional id type only for keys that could be id', () => {
    expect(lint('acceptOptionalId({1: runtimeValue})', { runtime })).toEqual(
      []
    );
    expect(
      lint('acceptOptionalId({possibleIdKey: runtimeValue})', { runtime })
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Type mismatch'),
      }),
    ]);
  });

  it('keeps earlier values when the later key might name another field', () => {
    expect(
      lint(
        'val map = {runtimeKey: 1, finiteKey: runtimeValue}; acceptInteger(map.other)',
        { runtime }
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("argument of type 'integer | string'"),
      }),
    ]);
  });
});
