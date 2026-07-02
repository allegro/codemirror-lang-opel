import { describe, expect, it } from 'vitest';
import { hasParseError } from '../support/test-utils';

describe('runtime parsing equivalents', () => {
  it('accepts expressions that runtime parser accepts', () => {
    const validExpressions = [
      '3',
      '1 + 1',
      '1 + 1 * 4',
      "'abc' + 'xyz'",
      '1 == 10',
      '1 != 10',
      'false || true && false || (true && false)',
      "fun1('x').items[0].name",
      'fun1(1==1)',
      'identity(1==1)',
      'function(10).items[0].prices[0].x',
      "zero () == 'zero'",
      "zero(   ) == 'zero'",
      "zero ( ) == 'zero'",
      "if (true) 'a' else 'b'",
      "if (1 == 1 && 2 == 2) 'a' else 'b'",
      "(if (true) 'a' else 'b').length()",
      'val x = 2; x + 1',
      'val condition=1==1; if(condition) 5 else 6',
      '[]',
      "['a', 2, 'c'].size()",
      "{:}",
      "{'x':2}",
      "{'x': 2, 'y':3 }",
      "val f = () -> 3; f()",
      "val square = x -> x * x; square(2)",
      "val square = (x) -> x * x; square(2)",
      '(x, y) -> {x*x + y*y}(1, 2)',
      'val f = a -> { b -> {a*2+b} }; f(2)(3)',
      "(aMap.get)('get')",
      "({'get': x->x+x}.get)('get')",
      "(if (x > 0) foo else bar)(x)",
      "'Guns N\\' Roses'",
      "'abc\\''",
      "'\\'abc'",
      "'abc' + 'xyz';",
    ];

    for (const expression of validExpressions) {
      expect(hasParseError(expression), expression).toBe(false);
    }
  });

  it('rejects expressions that runtime parser rejects', () => {
    const invalidExpressions = [
      "'abc",
      "'abc\\'",
      "1 ,= 5",
      "1 * 5 , 9",
      '5 ; 9',
      "ds('x').items[0.name + 'abc'",
      "ds('x').items[0[.name",
      "function('a', 'b', 'c').items[0[.name",
      "function('a', 'b', 'c').items[0).name",
      "function('a', 'b', 'c').items[0,].name",
      'true false',
      'true null false',
      'true && || false',
      '{}',
      '{ }',
      '{, }',
      '{  , }',
      "if (2 == 2) 'elo'",
      "123+'abc';;",
      ";123+'abc';",
      "'abc\nxyz'",
    ];

    for (const expression of invalidExpressions) {
      expect(hasParseError(expression), expression).toBe(true);
    }
  });
});
