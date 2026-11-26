import type { Diagnostic } from '@codemirror/lint';
import type { SyntaxNode } from '@lezer/common';
import type {
  OpelCallable,
  OpelMethodReceiver,
  OpelPrimitiveMethodReceiver,
  OpelPrimitive,
  OpelParameter,
  OpelRuntime,
  OpelSchema,
  OpelSignature,
} from '../types';
import type { RuntimeContext } from '../runtime';
import { PRIMITIVE_METHOD_RECEIVERS } from '../method-receivers';
import { OPEL_NODE_NAMES as NODE } from '../syntax/nodes';
import { findSimilarTerms } from './similar-terms';
import type { SchemaValue } from './schema-compatibility';
import { isValueCompatibleWithSchema as isSchemaValueCompatible } from './schema-compatibility';
import {
  isRecord,
  schemaObject,
  schemaRootFor,
  createUnionSchema,
  combineSchemaValues,
  resolveSchemaVariants,
  getSchemaTypes,
  schemaAllowsType,
  valueType,
  matchingPatternProperties,
  literalEqual,
} from './schema';

const EXPRESSION_NODES = new Set<string>([
  NODE.Expression,
  NODE.OrExpression,
  NODE.AndExpression,
  NODE.EqualityExpression,
  NODE.RelationalExpression,
  NODE.AdditiveExpression,
  NODE.MultiplyExpression,
  NODE.UnaryExpression,
  NODE.Primary,
  NODE.Atom,
  NODE.PostfixExpression,
]);

// Unknown and impossible values use ANY_VALUE_SCHEMA and NO_VALUES_SCHEMA.
// Undefined literals are unavailable; errors suppress dependent diagnostics.
type StablePath = { root: string; segments: string[] };
type Value = SchemaValue & {
  callable?: OpelCallable;
  error?: boolean;
  path?: StablePath;
  pathParent?: Value;
  condition?: ConditionResult;
  numericText?: string;
};

type NarrowedValue = { schema: OpelSchema; root: OpelSchema };
// Schema refinements keyed by the stable paths they apply to.
type PathNarrowings = Map<string, NarrowedValue>;
type ConditionResult = {
  canBeTrue: boolean;
  canBeFalse: boolean;
  whenTrue: PathNarrowings;
  whenFalse: PathNarrowings;
};

type Binding = {
  name: string;
  from: number;
  to: number;
  kind: 'val' | 'lambda parameter';
  value: Value;
  used: boolean;
};

type Environment = Map<string, Binding>;
// Each analysis uses fresh environments, so branch refinements stay editor-local.
const ENVIRONMENT_NARROWINGS = new WeakMap<Environment, PathNarrowings>();

// Boolean schemas: true accepts any value; false accepts no values.
const ANY_VALUE_SCHEMA = true;
const NO_VALUES_SCHEMA = false;

function createEnvironment(
  bindings?: Iterable<readonly [string, Binding]>,
  narrowings: PathNarrowings = new Map()
): Environment {
  const environment = new Map(bindings) as Environment;
  ENVIRONMENT_NARROWINGS.set(environment, narrowings);
  return environment;
}

function environmentNarrowings(env: Environment): PathNarrowings {
  let narrowings = ENVIRONMENT_NARROWINGS.get(env);
  if (!narrowings) {
    narrowings = new Map();
    ENVIRONMENT_NARROWINGS.set(env, narrowings);
  }
  return narrowings;
}

function cloneEnvironment(
  env: Environment,
  narrowings = environmentNarrowings(env)
) {
  return createEnvironment(env, narrowings);
}

function stablePathKey(path: StablePath): string {
  return JSON.stringify([path.root, ...path.segments]);
}

// Derived values resolve local references against the document that introduced them.
function schemaRootForValue(value: Value): OpelSchema {
  return value.root ?? value.schema;
}

type SemanticContext = {
  source: string;
  runtime: OpelRuntime;
  diagnostics: Diagnostic[];
  deprecated: Set<string>;
  suppressUnknownIdentifierAt: ReadonlySet<number>;
};

function isImpossibleValue(value: Value, ctx: SemanticContext): boolean {
  const types = getSchemaTypes(
    value.schema,
    schemaRootForValue(value),
    ctx.runtime
  );
  return types.length > 0 && types.every((type) => type === 'never');
}

type SemanticAnalysisOptions = {
  suppressUnknownIdentifierAt?: ReadonlySet<number>;
};

export function analyzeRuntimeSemantics(
  tree: SyntaxNode,
  source: string,
  context: RuntimeContext,
  options: SemanticAnalysisOptions = {}
): Diagnostic[] {
  const ctx: SemanticContext = {
    source,
    runtime: context.runtime,
    diagnostics: [],
    deprecated: new Set(),
    suppressUnknownIdentifierAt:
      options.suppressUnknownIdentifierAt ?? new Set(),
  };
  const body = tree.getChild(NODE.Body);
  if (body) {
    analyzeScopeBody(body, createEnvironment(), ctx);
  }
  return ctx.diagnostics;
}

// Infer each initializer before inserting its binding; declarations are visible in source order.
function analyzeScopeBody(
  body: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const bindings: Binding[] = [];
  const declarations = body.getChild(NODE.Declarations);
  if (declarations) {
    for (const declaration of declarations.getChildren(NODE.Declaration)) {
      const nameNode = declaration
        .getChild(NODE.VariableName)
        ?.getChild(NODE.Identifier);
      const expression = declaration.getChild(NODE.Expression);
      let value = expression
        ? analyzeExpression(expression, env, ctx)
        : { schema: ANY_VALUE_SCHEMA };
      if (nameNode) {
        const name = ctx.source.slice(nameNode.from, nameNode.to);
        value = value.path
          ? value
          : {
              ...value,
              path: { root: `binding:${nameNode.from}`, segments: [] },
            };
        const isRuntimeGlobal = Object.prototype.hasOwnProperty.call(
          ctx.runtime.globals ?? {},
          name
        );
        const isRuntimeFunction = Object.prototype.hasOwnProperty.call(
          ctx.runtime.functions ?? {},
          name
        );
        if (!env.has(name) && (isRuntimeGlobal || isRuntimeFunction)) {
          addDiagnostic(
            nameNode,
            'error',
            isRuntimeFunction
              ? `Cannot redeclare runtime global function '${name}'`
              : `Cannot redeclare runtime global '${name}'`,
            ctx.diagnostics
          );
        }
        const binding: Binding = {
          name,
          from: nameNode.from,
          to: nameNode.to,
          kind: 'val',
          value,
          used: false,
        };
        bindings.push(binding);
        env.set(name, binding);
      }
    }
  }
  const expression = body.getChild(NODE.Expression);
  const result = expression
    ? analyzeExpression(expression, env, ctx)
    : { schema: ANY_VALUE_SCHEMA };
  addUnusedBindingDiagnostics(bindings, ctx);
  return result;
}

function addUnusedBindingDiagnostics(
  bindings: Binding[],
  ctx: SemanticContext
): void {
  for (const binding of bindings) {
    if (!binding.used) {
      ctx.diagnostics.push({
        from: binding.from,
        to: binding.to,
        severity: 'warning',
        message: `Variable "${binding.name}" is declared but never used.`,
      });
    }
  }
}

function analyzeExpression(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  switch (node.name) {
    case NODE.Expression:
      return analyzeExpression(node.firstChild ?? node, env, ctx);
    case NODE.IfExpression:
      return analyzeConditional(node, env, ctx);
    case NODE.FunctionCall:
      return analyzeFunctionCall(node, env, ctx);
    case NODE.FunctionInstantiation:
      return analyzeLambda(node, env, ctx);
    case NODE.PostfixExpression:
      return analyzePostfixExpression(node, env, ctx);
    case NODE.Primary: {
      const postfixExpression = node.getChild(NODE.PostfixExpression);
      if (postfixExpression) {
        return analyzeExpression(postfixExpression, env, ctx);
      }
      const atom = node.getChild(NODE.Atom);
      return atom
        ? analyzeExpression(atom, env, ctx)
        : { schema: ANY_VALUE_SCHEMA };
    }
    case NODE.Atom:
      return analyzeAtom(node, env, ctx);
    case NODE.NamedValue:
    case NODE.Number:
    case NODE.StringLiteral: {
      const literal = readLiteralValue(node, ctx.source);
      if (literal.hasLiteralValue) {
        return {
          schema: { type: valueType(literal.value) as OpelPrimitive },
          literal: literal.value,
          ...(node.name === NODE.Number
            ? { numericText: ctx.source.slice(node.from, node.to) }
            : {}),
        };
      }
      break;
    }
    case NODE.BlockExpression: {
      const body = node.getChild(NODE.Body);
      return body
        ? analyzeScopeBody(body, cloneEnvironment(env), ctx)
        : { schema: ANY_VALUE_SCHEMA };
    }
    case NODE.FunctionBody:
      return node.firstChild
        ? analyzeExpression(node.firstChild, env, ctx)
        : { schema: ANY_VALUE_SCHEMA };
    case NODE.UnaryExpression:
      return analyzeUnary(node, env, ctx);
  }
  return analyzeOperators(node, env, ctx);
}

function analyzeUnary(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const operand: Value = node.lastChild
    ? analyzeExpression(node.lastChild, env, ctx)
    : { schema: ANY_VALUE_SCHEMA };
  const operator = node.firstChild?.name;
  if (operator !== NODE.Not && operator !== NODE.Minus) {
    return operand;
  }
  let literal: unknown;
  let schema: OpelSchema = true;
  if (operator === NODE.Not) {
    schema = { type: 'boolean' };
    if (typeof operand.literal === 'boolean') {
      literal = !operand.literal;
    }
    return {
      schema,
      literal,
      error: operand.error,
      ...(operand.condition
        ? { condition: invertCondition(operand.condition) }
        : {}),
    };
  } else if (typeof operand.literal === 'number') {
    literal = -operand.literal;
    schema = { type: valueType(literal) as OpelPrimitive };
    return {
      schema,
      literal,
      error: operand.error,
      numericText: operand.numericText ? `-${operand.numericText}` : undefined,
    };
  } else {
    const types = getSchemaTypes(
      operand.schema,
      schemaRootForValue(operand),
      ctx.runtime
    );
    if (
      types.length > 0 &&
      types.every((type) => type === 'integer' || type === 'number')
    ) {
      schema = {
        type: types.every((type) => type === 'integer') ? 'integer' : 'number',
      };
    }
  }
  return { schema, literal, error: operand.error };
}

function analyzeConditional(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  // The expressions are condition, then-branch, and else-branch; while editing,
  // the unfinished expression may not contain the else-branch yet.
  const expressions = node.getChildren(NODE.Expression);
  if (expressions.length >= 2) {
    const condition = analyzeCondition(expressions[0], env, ctx);
    const values: Value[] = [];
    if (condition.canBeTrue) {
      values.push(
        analyzeExpression(
          expressions[1],
          cloneEnvironment(env, condition.whenTrue),
          ctx
        )
      );
    }
    if (expressions[2] && condition.canBeFalse) {
      values.push(
        analyzeExpression(
          expressions[2],
          cloneEnvironment(env, condition.whenFalse),
          ctx
        )
      );
    }
    return values.length === 0
      ? { schema: NO_VALUES_SCHEMA }
      : {
          schema: createUnionSchema(
            values.map((value) => value.schema),
            values.map(schemaRootForValue)
          ),
        };
  }
  return analyzeOperators(node, env, ctx);
}

type Narrowing = { schema: OpelSchema; root: OpelSchema; possible: boolean };

function copyNarrowings(narrowings: PathNarrowings): PathNarrowings {
  return new Map(narrowings);
}

// Keep only paths narrowed on every route, combining their possible schemas.
function joinNarrowings(paths: PathNarrowings[]): PathNarrowings {
  if (paths.length === 0) {
    return new Map();
  }
  const joined = new Map<string, NarrowedValue>();
  for (const [key, first] of paths[0]) {
    const values = paths.slice(1).map((narrowings) => narrowings.get(key));
    if (values.some((value) => value === undefined)) {
      continue;
    }
    const present = [first, ...values] as NarrowedValue[];
    joined.set(key, {
      schema: createUnionSchema(
        present.map((value) => value.schema),
        present.map((value) => value.root)
      ),
      root: present[0].root,
    });
  }
  return joined;
}

function conditionFromValue(value: Value, env: Environment): ConditionResult {
  if (value.condition) {
    return value.condition;
  }
  const narrowings = copyNarrowings(environmentNarrowings(env));
  if (value.literal === true) {
    return {
      canBeTrue: true,
      canBeFalse: false,
      whenTrue: narrowings,
      whenFalse: narrowings,
    };
  }
  if (value.literal === false) {
    return {
      canBeTrue: false,
      canBeFalse: true,
      whenTrue: narrowings,
      whenFalse: narrowings,
    };
  }
  return {
    canBeTrue: true,
    canBeFalse: true,
    whenTrue: narrowings,
    whenFalse: narrowings,
  };
}

function analyzeCondition(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): ConditionResult {
  return conditionFromValue(analyzeExpression(node, env, ctx), env);
}

function invertCondition(condition: ConditionResult): ConditionResult {
  return {
    canBeTrue: condition.canBeFalse,
    canBeFalse: condition.canBeTrue,
    whenTrue: condition.whenFalse,
    whenFalse: condition.whenTrue,
  };
}

function joinedOutcome(
  paths: {
    reachable: boolean;
    narrowings: PathNarrowings;
  }[]
): {
  reachable: boolean;
  narrowings: PathNarrowings;
} {
  const reachable = paths.filter((path) => path.reachable);
  return {
    reachable: reachable.length > 0,
    narrowings: joinNarrowings(reachable.map((path) => path.narrowings)),
  };
}

function combineAnd(
  left: ConditionResult,
  right: ConditionResult
): ConditionResult {
  const whenFalse = joinedOutcome([
    { reachable: left.canBeFalse, narrowings: left.whenFalse },
    {
      reachable: left.canBeTrue && right.canBeFalse,
      narrowings: right.whenFalse,
    },
  ]);
  return {
    canBeTrue: left.canBeTrue && right.canBeTrue,
    canBeFalse: whenFalse.reachable,
    whenTrue: right.whenTrue,
    whenFalse: whenFalse.narrowings,
  };
}

function combineOr(
  left: ConditionResult,
  right: ConditionResult
): ConditionResult {
  const whenTrue = joinedOutcome([
    { reachable: left.canBeTrue, narrowings: left.whenTrue },
    {
      reachable: left.canBeFalse && right.canBeTrue,
      narrowings: right.whenTrue,
    },
  ]);
  return {
    canBeTrue: whenTrue.reachable,
    canBeFalse: left.canBeFalse && right.canBeFalse,
    whenTrue: whenTrue.narrowings,
    whenFalse: right.whenFalse,
  };
}

function filterNull(
  value: Value,
  wantNull: boolean,
  ctx: SemanticContext
): Narrowing {
  const root = schemaRootForValue(value);
  const kept: {
    schema: OpelSchema;
    root: OpelSchema;
    references?: string[];
  }[] = [];
  for (const variant of resolveSchemaVariants(
    value.schema,
    root,
    ctx.runtime
  )) {
    if (variant.schema === true) {
      kept.push(variant);
      continue;
    }
    if (variant.schema === false) {
      continue;
    }
    const types = getSchemaTypes(variant.schema, variant.root, ctx.runtime);
    if (types.length === 0) {
      kept.push(variant);
      continue;
    }
    const hasNull = types.includes('null');
    const nonNullTypes = types.filter((type) => type !== 'null');
    if (wantNull) {
      if (hasNull) {
        kept.push({
          schema: { type: 'null' },
          root: variant.root,
          references: variant.references,
        });
      }
    } else if (nonNullTypes.length > 0) {
      if (!hasNull) {
        kept.push(variant);
      } else {
        const object = schemaObject(variant.schema);
        if (!object) {
          kept.push(variant);
          continue;
        }
        const narrowed = { ...object };
        delete narrowed.nullable;
        if (object.type !== undefined) {
          narrowed.type = nonNullTypes as OpelPrimitive[];
        }
        if (Array.isArray(object.enum)) {
          narrowed.enum = object.enum.filter((item) => item !== null);
        }
        kept.push({
          schema: narrowed as OpelSchema,
          root: variant.root,
          references: variant.references,
        });
      }
    }
  }
  const schema =
    kept.length === 0
      ? false
      : createUnionSchema(
          kept.map((variant) => variant.schema),
          kept.map((variant) => variant.root),
          kept.map((variant) => variant.references)
        );
  return { schema, root: kept[0]?.root ?? root, possible: schema !== false };
}

// OPEL compares parsed BigDecimals with scale-sensitive equals.
function decimalLiteralParts(source: string): {
  scale: number;
  unscaled: string;
} {
  const minusSigns = source.match(/^-+/)?.[0].length ?? 0;
  const negative = minusSigns % 2 === 1;
  const unsigned = source.slice(minusSigns);
  const point = unsigned.indexOf('.');
  const scale = point < 0 ? 0 : unsigned.length - point - 1;
  const digits = unsigned.replace('.', '').replace(/^0+(?=\d)/, '');
  const normalized = digits || '0';
  return {
    scale,
    unscaled:
      normalized === '0' ? normalized : `${negative ? '-' : ''}${normalized}`,
  };
}

function scalarComparison(
  candidate: unknown,
  other: unknown,
  candidateNumericText?: string,
  otherNumericText?: string
): boolean | undefined {
  if (candidate === null || other === null) {
    return candidate === other;
  }
  if (typeof candidate === 'number' || typeof other === 'number') {
    if (
      typeof candidate !== 'number' ||
      typeof other !== 'number' ||
      candidateNumericText === undefined ||
      otherNumericText === undefined
    ) {
      return undefined;
    }
    const left = decimalLiteralParts(candidateNumericText);
    const right = decimalLiteralParts(otherNumericText);
    return left.scale === right.scale && left.unscaled === right.unscaled;
  }
  const candidateType = valueType(candidate);
  const otherType = valueType(other);
  if (candidateType !== otherType) {
    return undefined;
  }
  return literalEqual(candidate, other);
}

function propertyComparisonPossibilities(
  schema: OpelSchema,
  root: OpelSchema,
  candidate: string | boolean,
  ctx: SemanticContext
): { equal: boolean; unequal: boolean } {
  let equal = false;
  let unequal = false;
  let unknown = false;
  for (const variant of resolveSchemaVariants(schema, root, ctx.runtime)) {
    if (variant.schema === false) {
      continue;
    }
    const object = schemaObject(variant.schema);
    if (variant.schema === true || !object) {
      unknown = true;
      continue;
    }
    const values =
      object.const !== undefined
        ? [object.const]
        : Array.isArray(object.enum)
          ? object.enum
          : null;
    if (!values) {
      unknown = true;
      continue;
    }
    for (const value of values) {
      const comparison = scalarComparison(candidate, value);
      if (comparison === true) {
        equal = true;
      } else if (comparison === false) {
        unequal = true;
      } else {
        unknown = true;
      }
    }
    if (
      getSchemaTypes(variant.schema, variant.root, ctx.runtime).includes('null')
    ) {
      unequal = true;
    }
  }
  return { equal: equal || unknown, unequal: unequal || unknown };
}

function filterDiscriminator(
  value: Value,
  property: string,
  candidate: string | boolean,
  wantEqual: boolean,
  ctx: SemanticContext
): Narrowing {
  const root = schemaRootForValue(value);
  const kept: {
    schema: OpelSchema;
    root: OpelSchema;
    references?: string[];
  }[] = [];
  for (const variant of resolveSchemaVariants(
    value.schema,
    root,
    ctx.runtime
  )) {
    if (variant.schema === true) {
      kept.push(variant);
      continue;
    }
    if (variant.schema === false) {
      continue;
    }
    const object = schemaObject(variant.schema);
    if (!object) {
      kept.push(variant);
      continue;
    }
    const properties = isRecord(object.properties) ? object.properties : {};
    const hasProperty = Object.prototype.hasOwnProperty.call(
      properties,
      property
    );
    const propertySchemas = [
      ...(hasProperty ? [properties[property] as OpelSchema] : []),
      ...matchingPatternProperties(object, property),
    ];
    if (
      propertySchemas.length === 0 &&
      object.additionalProperties &&
      object.additionalProperties !== true
    ) {
      propertySchemas.push(object.additionalProperties as OpelSchema);
    }
    const propertySchema =
      propertySchemas.length === 1
        ? propertySchemas[0]
        : propertySchemas.length > 1
          ? combineSchemaValues(propertySchemas, variant.root, ctx.runtime)
          : undefined;
    const required = Array.isArray(object.required)
      ? object.required.includes(property)
      : false;
    let possibilities =
      propertySchema !== undefined
        ? propertyComparisonPossibilities(
            propertySchema,
            schemaRootFor(propertySchema, variant.root),
            candidate,
            ctx
          )
        : object.additionalProperties === false
          ? { equal: false, unequal: true }
          : { equal: true, unequal: true };
    if (!required) {
      possibilities = { ...possibilities, unequal: true };
    }
    if (wantEqual ? possibilities.equal : possibilities.unequal) {
      kept.push(variant);
    }
  }
  const schema =
    kept.length === 0
      ? false
      : createUnionSchema(
          kept.map((variant) => variant.schema),
          kept.map((variant) => variant.root),
          kept.map((variant) => variant.references)
        );
  return { schema, root: kept[0]?.root ?? root, possible: schema !== false };
}

function narrowingsForValue(
  env: Environment,
  value: Value,
  narrowing: Narrowing
): PathNarrowings {
  const narrowings = copyNarrowings(environmentNarrowings(env));
  if (value.path && narrowing.possible) {
    narrowings.set(stablePathKey(value.path), {
      schema: narrowing.schema,
      root: narrowing.root,
    });
  }
  return narrowings;
}

function comparisonCondition(
  operator: string,
  left: Value,
  right: Value,
  env: Environment,
  ctx: SemanticContext
): ConditionResult {
  const base = copyNarrowings(environmentNarrowings(env));
  const equality = operator === NODE.EqualityOp;
  const nullValue =
    left.literal === null && right.literal === null
      ? left.path
        ? left
        : right.path
          ? right
          : right
      : left.literal === null
        ? right
        : right.literal === null
          ? left
          : null;
  if (nullValue) {
    const isEquality = equality;
    const nullBranch = filterNull(nullValue, true, ctx);
    const nonNullBranch = filterNull(nullValue, false, ctx);
    const trueNarrowing = isEquality ? nullBranch : nonNullBranch;
    const falseNarrowing = isEquality ? nonNullBranch : nullBranch;
    return {
      canBeTrue: trueNarrowing.possible,
      canBeFalse: falseNarrowing.possible,
      whenTrue: narrowingsForValue(env, nullValue, trueNarrowing),
      whenFalse: narrowingsForValue(env, nullValue, falseNarrowing),
    };
  }

  const pathValue = left.pathParent ? left : right.pathParent ? right : null;
  const candidateValue = pathValue === left ? right : left;
  const candidate = candidateValue.literal;
  // Numeric schema values lose their source scale, so they cannot narrow safely.
  if (
    pathValue &&
    pathValue.pathParent &&
    (typeof candidate === 'string' || typeof candidate === 'boolean')
  ) {
    const parent = pathValue.pathParent;
    const segments = pathValue.path?.segments ?? [];
    const property = segments[segments.length - 1];
    if (property !== undefined) {
      const equalBranch = filterDiscriminator(
        parent,
        property,
        candidate,
        true,
        ctx
      );
      const unequalBranch = filterDiscriminator(
        parent,
        property,
        candidate,
        false,
        ctx
      );
      const trueNarrowing = equality ? equalBranch : unequalBranch;
      const falseNarrowing = equality ? unequalBranch : equalBranch;
      return {
        canBeTrue: trueNarrowing.possible,
        canBeFalse: falseNarrowing.possible,
        whenTrue: narrowingsForValue(env, parent, trueNarrowing),
        whenFalse: narrowingsForValue(env, parent, falseNarrowing),
      };
    }
  }

  if (left.literal !== undefined && right.literal !== undefined) {
    const comparison = scalarComparison(
      left.literal,
      right.literal,
      left.numericText,
      right.numericText
    );
    if (comparison !== undefined) {
      const result = equality ? comparison : !comparison;
      return {
        canBeTrue: result,
        canBeFalse: !result,
        whenTrue: base,
        whenFalse: base,
      };
    }
  }
  return {
    canBeTrue: true,
    canBeFalse: true,
    whenTrue: base,
    whenFalse: base,
  };
}

function analyzeFunctionCall(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const nameNode = node.getChild(NODE.Identifier);
  const name = nameNode ? ctx.source.slice(nameNode.from, nameNode.to) : '';
  const value = lookupIdentifier(name, env, ctx);
  if (!value) {
    addDiagnostic(
      node,
      'error',
      `Unknown function "${name}".`,
      ctx.diagnostics
    );
    return { schema: ANY_VALUE_SCHEMA, error: true };
  }
  const argNodes = node.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
  const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
  if (!value.callable) {
    if (isKnownNonCallable(value, ctx)) {
      addDiagnostic(
        node,
        'error',
        `Symbol "${name}" is not callable.`,
        ctx.diagnostics
      );
      return { schema: ANY_VALUE_SCHEMA, error: true };
    }
    return { schema: ANY_VALUE_SCHEMA };
  }

  return analyzeCall(value.callable, args, node, ctx, argNodes);
}

// Parameters remain unknown; calls check arity but do not specialize the body.
function analyzeLambda(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const params = node.getChild(NODE.LambdaParams);
  const singleParam = params
    ?.getChild(NODE.SingleParam)
    ?.getChild(NODE.Identifier);
  const paramNodes = singleParam
    ? [singleParam]
    : ((params?.getChild(NODE.MultiParam) ?? params)?.getChildren(
        NODE.Identifier
      ) ?? []);
  const names = paramNodes.map((param) =>
    ctx.source.slice(param.from, param.to)
  );
  const body = node.getChild(NODE.FunctionBody);
  const localEnvironment = cloneEnvironment(env);
  const bindings = paramNodes.map(
    (param, index): Binding => ({
      name: names[index],
      from: param.from,
      to: param.to,
      kind: 'lambda parameter',
      value: {
        schema: ANY_VALUE_SCHEMA,
        path: { root: `binding:${param.from}`, segments: [] },
      },
      used: false,
    })
  );
  for (const binding of bindings) {
    localEnvironment.set(binding.name, binding);
  }
  const returnValue = body?.firstChild
    ? analyzeExpression(body.firstChild, localEnvironment, ctx)
    : { schema: ANY_VALUE_SCHEMA };
  addUnusedBindingDiagnostics(bindings, ctx);
  return callableValue({
    signatures: [
      {
        parameters: names.map(
          (name): OpelParameter => ({ name, schema: ANY_VALUE_SCHEMA })
        ),
        returns: returnValue.schema,
      },
    ],
  });
}

function analyzePostfixExpression(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const primaries = node.getChildren(NODE.Primary);
  let value = primaries[0]
    ? analyzeExpression(primaries[0], env, ctx)
    : { schema: ANY_VALUE_SCHEMA };
  for (const postfix of node.getChildren(NODE.Postfix)) {
    const method = postfix.getChild(NODE.MethodCall);
    const field = postfix.getChild(NODE.FieldAccess);
    const group = postfix.getChild(NODE.CallGroup);
    if (method) {
      const nameNode = method.getChild(NODE.Identifier);
      const name = nameNode ? ctx.source.slice(nameNode.from, nameNode.to) : '';
      const argNodes =
        method.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
      const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
      value = analyzeMethodCall(value, name, args, method, ctx, argNodes);
    } else if (field) {
      const dot = field.getChild(NODE.Identifier);
      if (dot) {
        value = resolvePropertyAccess(
          value,
          ctx.source.slice(dot.from, dot.to),
          field,
          env,
          ctx,
          ctx.source.slice(dot.from, dot.to)
        );
      } else {
        const expression = field.getChild(NODE.Expression);
        const key = expression
          ? analyzeExpression(expression, env, ctx)
          : { schema: ANY_VALUE_SCHEMA };
        const receiverRoot = schemaRootForValue(value);
        const receiverTypes = getSchemaTypes(
          value.schema,
          receiverRoot,
          ctx.runtime
        );
        if (receiverTypes.includes('array')) {
          if (
            key.literal !== undefined &&
            (!Number.isInteger(key.literal) || (key.literal as number) < 0)
          ) {
            addDiagnostic(
              field,
              'error',
              `Invalid list index: list index must be an integer; received '${valueDescription(key, ctx)}'.`,
              ctx.diagnostics
            );
          } else {
            const itemValues = resolveSchemaVariants(
              value.schema,
              receiverRoot,
              ctx.runtime
            ).flatMap((resolution) => {
              const types = getSchemaTypes(
                resolution.schema,
                resolution.root,
                ctx.runtime
              );
              if (types.length > 0 && !types.includes('array')) {
                return [];
              }
              const items = schemaObject(resolution.schema)?.items as
                | OpelSchema
                | undefined;
              return items !== undefined
                ? [
                    {
                      schema: items,
                      root: schemaRootFor(items, resolution.root),
                    },
                  ]
                : [{ schema: ANY_VALUE_SCHEMA, root: resolution.root }];
            });
            const itemSchema = createUnionSchema(
              itemValues.map((item) => item.schema),
              itemValues.map((item) => item.root)
            );
            value = {
              schema: itemSchema,
              root: itemValues[0]?.root ?? receiverRoot,
            };
          }
        } else if (
          key.literal !== undefined &&
          typeof key.literal === 'string'
        ) {
          value = resolvePropertyAccess(
            value,
            key.literal,
            field,
            env,
            ctx,
            expression ? staticStringKey(expression, ctx.source) : undefined
          );
        } else if (
          receiverTypes.includes('object') &&
          schemaObject(value.schema)?.additionalProperties === false
        ) {
          addDiagnostic(
            field,
            'warning',
            `Dynamic property access is discouraged on closed object type ${schemaDescription(value.schema, schemaRootForValue(value), ctx.runtime)}; use a known property name.`,
            ctx.diagnostics
          );
        } else if (isImpossibleValue(value, ctx)) {
          value = { schema: NO_VALUES_SCHEMA, root: receiverRoot };
        } else {
          value = { schema: ANY_VALUE_SCHEMA };
        }
      }
    } else if (group) {
      const argNodes =
        group.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
      const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
      if (!value.callable) {
        if (isKnownNonCallable(value, ctx)) {
          addDiagnostic(
            group,
            'error',
            `This expression is not callable. Type '${valueDescription(value, ctx)}' has no call signatures.`,
            ctx.diagnostics
          );
          value = { schema: ANY_VALUE_SCHEMA, error: true };
        } else {
          value = { schema: ANY_VALUE_SCHEMA };
        }
      } else {
        value = analyzeCall(value.callable, args, group, ctx, argNodes);
      }
    }
  }
  return value;
}

function analyzeAtom(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const conditional = node.getChild(NODE.IfExpression);
  if (conditional) {
    return analyzeExpression(conditional, env, ctx);
  }
  const named = node.getChild(NODE.NamedValue);
  if (named) {
    const literal = readLiteralValue(named, ctx.source);
    if (literal.hasLiteralValue) {
      return {
        schema: { type: valueType(literal.value) as OpelPrimitive },
        literal: literal.value,
      };
    }
    const identifier = named.getChild(NODE.Identifier);
    const name = identifier
      ? ctx.source.slice(identifier.from, identifier.to)
      : '';
    const value = resolveIdentifier(name, identifier ?? named, env, ctx);
    let memberUse = false;
    let ancestor = named.parent;
    while (ancestor && ancestor.name !== NODE.Expression) {
      if (
        ancestor.name === NODE.FieldAccess ||
        ancestor.name === NODE.MethodCall
      ) {
        memberUse = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!memberUse) {
      addDeprecation(
        ctx,
        identifier ?? named,
        schemaObject(value.schema)?.deprecated as boolean | string | undefined
      );
    }
    return value;
  }
  const number = node.getChild(NODE.Number);
  if (number) {
    const value = readLiteralValue(number, ctx.source).value;
    return {
      schema: { type: valueType(value) as OpelPrimitive },
      literal: value,
      numericText: ctx.source.slice(number.from, number.to),
    };
  }
  const string = node.getChild(NODE.StringLiteral);
  if (string) {
    const value = readLiteralValue(string, ctx.source).value;
    return { schema: { type: 'string' }, literal: value };
  }
  const list = node.getChild(NODE.ListInstantiation);
  if (list) {
    return analyzeList(list, env, ctx);
  }
  const map = node.getChild(NODE.MapInstantiation);
  if (map) {
    return analyzeMap(map, env, ctx);
  }
  const parenthesized = node.getChild(NODE.ParenthesizedExpression);
  if (parenthesized) {
    const expression = parenthesized.getChild(NODE.Expression);
    return expression
      ? analyzeExpression(expression, env, ctx)
      : { schema: ANY_VALUE_SCHEMA };
  }
  const functionCall = node.getChild(NODE.FunctionCall);
  if (functionCall) {
    return analyzeExpression(functionCall, env, ctx);
  }
  const lambda = node.getChild(NODE.FunctionInstantiation);
  if (lambda) {
    return analyzeExpression(lambda, env, ctx);
  }
  return analyzeOperators(node, env, ctx);
}

function analyzeList(
  list: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const args = list.getChild(NODE.Args);
  const values = args
    ? args
        .getChildren(NODE.Expression)
        .map((arg) => analyzeExpression(arg, env, ctx))
    : [];
  return {
    schema: {
      type: 'array',
      items: createUnionSchema(
        values.map((value) => value.schema),
        values.map(schemaRootForValue)
      ),
    },
    literal: values.every((value) => value.literal !== undefined)
      ? values.map((value) => value.literal)
      : undefined,
  };
}

type MapKeyNames = {
  // Available only when the entire key domain is a finite set of strings.
  names: Set<string> | undefined;
  // Undefined allows any string; a set may coexist with non-string keys.
  possibleNames: Set<string> | undefined;
};

function mapKeyNames(key: Value, ctx: SemanticContext): MapKeyNames {
  if (typeof key.literal === 'string') {
    const names = new Set([key.literal]);
    return { names, possibleNames: names };
  }
  if (key.literal !== undefined) {
    return { names: undefined, possibleNames: new Set() };
  }
  const names = new Set<string>();
  let finiteStringNames = true;
  let allowsAnyString = false;
  for (const variant of resolveSchemaVariants(
    key.schema,
    schemaRootForValue(key),
    ctx.runtime
  )) {
    if (variant.schema === false) {
      continue;
    }
    const object = schemaObject(variant.schema);
    const constant = object?.const;
    const enumValues = object?.enum;
    const candidates =
      constant !== undefined
        ? [constant]
        : Array.isArray(enumValues)
          ? enumValues
          : undefined;
    const allowsString = schemaAllowsType(
      variant.schema,
      'string',
      variant.root,
      ctx.runtime
    );
    if (!candidates) {
      finiteStringNames = false;
      allowsAnyString ||= allowsString;
      continue;
    }
    const matchesEnum =
      constant === undefined ||
      !Array.isArray(enumValues) ||
      enumValues.some((value) => literalEqual(value, constant));
    for (const name of candidates) {
      if (typeof name !== 'string') {
        finiteStringNames = false;
        continue;
      }
      if (allowsString && matchesEnum) {
        names.add(name);
      }
    }
  }
  return {
    names: finiteStringNames && names.size > 0 ? names : undefined,
    // Prepare overlap checks once, including string choices in mixed domains.
    // An undefined set allows any string, regardless of alternative order.
    possibleNames: allowsAnyString ? undefined : names,
  };
}

function analyzeMap(
  map: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const entries: (MapKeyNames & {
    value: Value;
    identity: Value | string | undefined;
  })[] = [];
  const lastEntryByIdentity = new Map<Value | string, number>();
  const pairs = map.getChild(NODE.Pairs);
  for (const pair of pairs ? pairs.getChildren(NODE.Pair) : []) {
    const key = pair.firstChild;
    const valueNode = pair.getChild(NODE.Expression);
    if (!key || !valueNode) {
      continue;
    }
    const keyValue = analyzeExpression(key, env, ctx);
    const value = analyzeExpression(valueNode, env, ctx);
    const propertyRoot = schemaRootForValue(value);
    const propertySchema = createUnionSchema(
      [value.callable ? { callable: value.callable } : value.schema],
      [propertyRoot]
    );
    const identifier = key
      .getChild(NODE.Atom)
      ?.getChild(NODE.NamedValue)
      ?.getChild(NODE.Identifier);
    const name = identifier
      ? ctx.source.slice(identifier.from, identifier.to)
      : undefined;
    const identity =
      name === undefined ? undefined : (env.get(name)?.value ?? name);
    if (identity !== undefined) {
      lastEntryByIdentity.set(identity, entries.length);
    }
    entries.push({
      value: { ...value, schema: propertySchema, root: propertyRoot },
      ...mapKeyNames(keyValue, ctx),
      identity,
    });
  }
  // Analyze overwritten entries too, then omit them from the resulting shape.
  const remaining = entries.filter(
    (entry, index) =>
      entry.identity === undefined ||
      lastEntryByIdentity.get(entry.identity) === index
  );
  const properties: Record<string, OpelSchema> = Object.create(null);
  const required: string[] = [];
  const names = new Set(
    remaining.flatMap((entry) => (entry.names ? [...entry.names] : []))
  );
  for (const name of names) {
    const values: Value[] = [];
    let guaranteed = false;
    for (const entry of remaining) {
      if (entry.names?.size === 1 && entry.names.has(name)) {
        values.length = 0;
        values.push(entry.value);
        guaranteed = true;
      } else if (
        entry.possibleNames === undefined ||
        entry.possibleNames.has(name)
      ) {
        values.push(entry.value);
      }
    }
    properties[name] = createUnionSchema(
      values.map((value) => value.schema),
      values.map(schemaRootForValue)
    );
    if (guaranteed) {
      required.push(name);
    }
  }
  const additionalValues = remaining
    .filter((entry) => entry.names === undefined)
    .map((entry) => entry.value);
  const literal: Record<string, unknown> = Object.create(null);
  let hasLiteral = true;
  for (const entry of remaining) {
    const name =
      entry.names?.size === 1 ? entry.names.values().next().value : undefined;
    if (name === undefined || entry.value.literal === undefined) {
      hasLiteral = false;
    } else {
      literal[name] = entry.value.literal;
    }
  }
  return {
    schema: {
      type: 'object',
      properties,
      required,
      additionalProperties:
        additionalValues.length === 0
          ? false
          : createUnionSchema(
              additionalValues.map((value) => value.schema),
              additionalValues.map(schemaRootForValue)
            ),
    },
    literal: hasLiteral ? literal : undefined,
  };
}

// Wrapper nodes forward their operand; actual operators infer a result without evaluation.
function analyzeOperators(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const parts = expressionChildren(node);
  if (
    node.name === NODE.AndExpression &&
    node.getChildren(NODE.LogicalAnd).length > 0
  ) {
    return analyzeLogicalOperator(parts, env, ctx, 'and');
  }
  if (
    node.name === NODE.OrExpression &&
    node.getChildren(NODE.LogicalOr).length > 0
  ) {
    return analyzeLogicalOperator(parts, env, ctx, 'or');
  }
  if (parts.length > 0) {
    const values = parts.map((part) => analyzeExpression(part, env, ctx));
    const isBooleanExpression =
      (node.name === NODE.OrExpression &&
        node.getChildren(NODE.LogicalOr).length > 0) ||
      (node.name === NODE.AndExpression &&
        node.getChildren(NODE.LogicalAnd).length > 0) ||
      (node.name === NODE.EqualityExpression &&
        (node.getChildren(NODE.EqualityOp).length > 0 ||
          node.getChildren(NODE.InequalityOp).length > 0)) ||
      (node.name === NODE.RelationalExpression &&
        [
          NODE.GreaterThan,
          NODE.GreaterThanOrEqual,
          NODE.LessThan,
          NODE.LessThanOrEqual,
        ].some((name) => node.getChildren(name).length > 0));
    if (isBooleanExpression) {
      const equalityOperators = [
        ...node.getChildren(NODE.EqualityOp),
        ...node.getChildren(NODE.InequalityOp),
      ].sort((left, right) => left.from - right.from);
      const condition =
        node.name === NODE.EqualityExpression &&
        equalityOperators.length === 1 &&
        values.length === 2
          ? comparisonCondition(
              equalityOperators[0].name,
              values[0],
              values[1],
              env,
              ctx
            )
          : undefined;
      return {
        schema: { type: 'boolean' },
        ...(condition ? { condition } : {}),
      };
    }
    if (
      node.name === NODE.AdditiveExpression ||
      node.name === NODE.MultiplyExpression
    ) {
      if (validateArithmeticOperands(node, values, ctx)) {
        return { schema: ANY_VALUE_SCHEMA, error: true };
      }
    }
    if (
      node.name === NODE.AdditiveExpression &&
      node.getChildren(NODE.Plus).length > 0
    ) {
      const operandTypes = values.map((value) =>
        getSchemaTypes(value.schema, schemaRootForValue(value), ctx.runtime)
      );
      if (operandTypes.some((types) => types.length === 0)) {
        return { schema: true };
      }
      if (operandTypes.every((types) => types.includes('string'))) {
        return { schema: { type: 'string' } };
      }
    }
    if (
      (node.name === NODE.AdditiveExpression &&
        (node.getChildren(NODE.Plus).length > 0 ||
          node.getChildren(NODE.Minus).length > 0)) ||
      (node.name === NODE.MultiplyExpression &&
        (node.getChildren(NODE.Multiply).length > 0 ||
          node.getChildren(NODE.Divide).length > 0))
    ) {
      return { schema: { type: 'number' } };
    }
    return values[values.length - 1];
  }
  return { schema: ANY_VALUE_SCHEMA };
}

function analyzeLogicalOperator(
  parts: SyntaxNode[],
  env: Environment,
  ctx: SemanticContext,
  operator: 'and' | 'or'
): Value {
  const first = parts[0]
    ? analyzeExpression(parts[0], env, ctx)
    : { schema: ANY_VALUE_SCHEMA };
  let condition = conditionFromValue(first, env);
  for (const part of parts.slice(1)) {
    const reachable =
      operator === 'and' ? condition.canBeTrue : condition.canBeFalse;
    if (!reachable) {
      break;
    }
    const narrowings =
      operator === 'and' ? condition.whenTrue : condition.whenFalse;
    const childEnv = cloneEnvironment(env, narrowings);
    const child = conditionFromValue(
      analyzeExpression(part, childEnv, ctx),
      childEnv
    );
    condition =
      operator === 'and'
        ? combineAnd(condition, child)
        : combineOr(condition, child);
  }
  return { schema: { type: 'boolean' }, condition };
}

// Every pair of known union alternatives must accept the operator; unknown types stay permissive.
function validateArithmeticOperands(
  node: SyntaxNode,
  values: Value[],
  ctx: SemanticContext
): boolean {
  const operators = [
    ...node.getChildren(NODE.Plus),
    ...node.getChildren(NODE.Minus),
    ...node.getChildren(NODE.Multiply),
    ...node.getChildren(NODE.Divide),
  ].sort((left, right) => left.from - right.from);
  let invalid = false;

  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index];
    const left = values[index];
    const right = values[index + 1];
    if (!left || !right) {
      continue;
    }

    const leftTypes = getSchemaTypes(
      left.schema,
      schemaRootForValue(left),
      ctx.runtime
    );
    const rightTypes = getSchemaTypes(
      right.schema,
      schemaRootForValue(right),
      ctx.runtime
    );
    const knownLeftTypes = leftTypes.filter((type) => type !== 'never');
    const knownRightTypes = rightTypes.filter((type) => type !== 'never');
    if (
      knownLeftTypes.length === 0 ||
      knownRightTypes.length === 0 ||
      knownLeftTypes.every((leftType) =>
        knownRightTypes.every((rightType) =>
          isValidArithmeticPair(operator.name, leftType, rightType)
        )
      )
    ) {
      continue;
    }

    const operatorText = ctx.source.slice(operator.from, operator.to);
    const expected =
      operatorText === '+'
        ? 'both sides to be numbers or both strings (hint: use toString() on one side if needed)'
        : 'both sides to be numbers';
    addDiagnostic(
      operator,
      'error',
      `Operator '${operatorText}' cannot be applied to types '${valueDescription(left, ctx)}' and '${valueDescription(right, ctx)}'. Expected ${expected}.`,
      ctx.diagnostics
    );
    invalid = true;
  }

  return invalid;
}

function isValidArithmeticPair(
  operatorName: string,
  leftType: string,
  rightType: string
): boolean {
  const numeric = (type: string) => type === 'number' || type === 'integer';
  if (operatorName === NODE.Plus) {
    return (
      (numeric(leftType) && numeric(rightType)) ||
      (leftType === 'string' && rightType === 'string')
    );
  }
  return numeric(leftType) && numeric(rightType);
}

function addDiagnostic(
  node: SyntaxNode,
  severity: Diagnostic['severity'],
  message: string,
  diagnostics: Diagnostic[],
  from = node.from,
  to = node.to
) {
  diagnostics.push({ from, to, severity, message });
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

// Diagnostic descriptions are presentation only, not a schema normalization step.
function schemaDescription(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime,
  seen = new Set<OpelSchema>()
): string {
  if (schema === true) {
    return 'unknown';
  }
  if (schema === false) {
    return 'never';
  }
  if (seen.has(schema)) {
    return 'recursive type';
  }
  seen.add(schema);

  const branches = resolveSchemaVariants(schema, root, runtime);
  if (branches.length > 1) {
    return branches
      .map((branch) =>
        schemaDescription(branch.schema, branch.root, runtime, seen)
      )
      .join(' | ');
  }

  const resolved = branches[0];
  if (resolved.schema === true) {
    return 'unknown';
  }
  if (resolved.schema === false) {
    return 'never';
  }
  const object = schemaObject(resolved.schema);
  if (!object) {
    return 'unknown';
  }
  if (object.const !== undefined) {
    return quoted(object.const);
  }
  if (Array.isArray(object.enum)) {
    return object.enum.map(quoted).join(' | ');
  }

  const typeNames = Array.isArray(object.type)
    ? object.type.map(String)
    : object.type
      ? [String(object.type)]
      : [];
  if (object.nullable) {
    typeNames.push('null');
  }
  if (typeNames.length === 1 && typeNames[0] === 'array') {
    const item = object.items
      ? schemaDescription(
          object.items as OpelSchema,
          object.items as OpelSchema,
          runtime
        )
      : 'unknown';
    return `${item}[]`;
  }
  if (typeNames.length > 0 && !typeNames.includes('object')) {
    return typeNames.join(' | ');
  }

  const properties = isRecord(object.properties) ? object.properties : {};
  const required = new Set(
    Array.isArray(object.required)
      ? object.required.filter(
          (name): name is string => typeof name === 'string'
        )
      : []
  );
  const propertyText = Object.entries(properties)
    .map(
      ([name, value]) =>
        `${name}${required.has(name) ? '' : '?'}: ${schemaDescription(value as OpelSchema, value as OpelSchema, runtime)}`
    )
    .join('; ');
  if (
    propertyText ||
    typeNames.includes('object') ||
    object.additionalProperties !== undefined ||
    object.patternProperties
  ) {
    return `{ ${propertyText || '[key: string]: unknown'} }`;
  }
  return 'unknown';
}

// Bound literal suggestions while retaining the full count of accepted values.
function expectedParameterDescription(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): string {
  const values: unknown[] = [];
  for (const branch of resolveSchemaVariants(schema, root, runtime)) {
    const object = schemaObject(branch.schema);
    if (!object) {
      return `parameter of type '${schemaDescription(schema, root, runtime)}'`;
    }
    if (object.const !== undefined) {
      values.push(object.const);
    } else if (Array.isArray(object.enum)) {
      values.push(...object.enum);
    } else {
      return `parameter of type '${schemaDescription(schema, root, runtime)}'`;
    }
  }
  const uniqueValues = values.filter(
    (value, index) =>
      values.findIndex((candidate) => literalEqual(candidate, value)) === index
  );
  if (uniqueValues.length < 2) {
    return `parameter of type '${schemaDescription(schema, root, runtime)}'`;
  }
  const shownValues = uniqueValues.slice(0, 3).map(quoted).join(', ');
  const remaining = uniqueValues.length - 3;
  return `any of the available values (${uniqueValues.length}): ${shownValues}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
}

function argumentDescription(
  value: Value | undefined,
  ctx: SemanticContext
): string {
  if (!value) {
    return "argument of type 'unknown'";
  }
  if (value.literal !== undefined) {
    const type = valueType(value.literal);
    if (type !== 'object' && type !== 'array') {
      return `argument ${quoted(value.literal)}`;
    }
  }
  return `argument of type '${valueDescription(value, ctx)}'`;
}

function valueDescription(value: Value, ctx: SemanticContext): string {
  if (value.literal !== undefined) {
    const type = valueType(value.literal);
    if (type === 'object' || type === 'array') {
      return schemaDescription(
        value.schema,
        schemaRootForValue(value),
        ctx.runtime
      );
    }
    return type;
  }
  const namedReceiver = namedMethodReceivers(
    value.schema,
    schemaRootForValue(value),
    ctx.runtime
  )[0];
  if (namedReceiver) {
    return namedReceiver;
  }
  return schemaDescription(
    value.schema,
    schemaRootForValue(value),
    ctx.runtime
  );
}

function availableProperties(
  schema: OpelSchema,
  ctx: SemanticContext,
  root: OpelSchema = schema
): string[] {
  const names = new Set<string>();
  for (const variant of resolveSchemaVariants(schema, root, ctx.runtime)) {
    const properties = schemaObject(variant.schema)?.properties;
    if (isRecord(properties)) {
      Object.keys(properties).forEach((name) => names.add(name));
    }
  }
  return [...names].sort();
}

function schemaDisplayName(
  schema: OpelSchema,
  runtime: OpelRuntime
): string | undefined {
  const reference = schemaObject(schema)?.$ref;
  return typeof reference === 'string' &&
    runtime.schemas &&
    Object.prototype.hasOwnProperty.call(runtime.schemas, reference)
    ? reference
    : undefined;
}

// Use the same receiver kinds as dispatch, including integer-to-number inheritance.
function availableMethods(receiver: Value, ctx: SemanticContext): string[] {
  const names = new Set<string>();
  for (const type of methodReceivers(receiver, ctx.runtime)) {
    const methods =
      ctx.runtime.methods &&
      Object.prototype.hasOwnProperty.call(ctx.runtime.methods, type)
        ? ctx.runtime.methods[type]
        : undefined;
    if (methods) {
      Object.keys(methods).forEach((name) => names.add(name));
    }
  }
  return [...names].sort();
}

function formatNames(names: string[]): string {
  return names.length > 0
    ? names.map((name) => `"${name}"`).join(', ')
    : 'none';
}

function formatAvailableProperties(names: string[]): string {
  if (names.length === 0) {
    return 'No properties are available.';
  }
  const shown = names.slice(0, 5);
  const remaining = names.length - shown.length;
  const more = remaining > 0 ? ` (+${remaining} more)` : '';
  return `Available properties: ${formatNames(shown)}${more}.`;
}

function propertySuggestion(name: string, names: string[]): string | null {
  const normalizedName = name.toLowerCase();
  const matches = names
    .filter((candidate) => {
      const normalizedCandidate = candidate.toLowerCase();
      return (
        normalizedCandidate !== normalizedName &&
        (normalizedName.startsWith(normalizedCandidate) ||
          normalizedCandidate.startsWith(normalizedName))
      );
    })
    .slice(0, 3);
  if (matches.length === 1) {
    return `Did you mean "${matches[0]}"?`;
  }
  return matches.length > 1
    ? `Similar properties: ${formatNames(matches)}.`
    : null;
}

function formatPropertyHint(name: string, names: string[]): string {
  const suggestion = propertySuggestion(name, names);
  const prefix = suggestion ? `${suggestion} ` : '';
  return `${prefix}${formatAvailableProperties(names)}`;
}

function readLiteralValue(
  node: SyntaxNode,
  source: string
): { hasLiteralValue: boolean; value?: unknown } {
  if (node.name === NODE.StringLiteral) {
    const text = source.slice(node.from, node.to);
    const escapes: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    return {
      hasLiteralValue: true,
      value: text
        .slice(1, -1)
        .replace(/\\([\\'"nrt])/g, (_, char: string) => escapes[char] ?? char),
    };
  }
  if (node.name === NODE.Number) {
    const value = Number(source.slice(node.from, node.to));
    return { hasLiteralValue: true, value };
  }
  if (node.name === NODE.NamedValue) {
    const value = source.slice(node.from, node.to);
    if (value === 'true') {
      return { hasLiteralValue: true, value: true };
    }
    if (value === 'false') {
      return { hasLiteralValue: true, value: false };
    }
    if (value === 'null') {
      return { hasLiteralValue: true, value: null };
    }
  }
  return { hasLiteralValue: false };
}

function staticStringKey(node: SyntaxNode, source: string): string | undefined {
  let current = node;
  while (true) {
    if (current.name === NODE.StringLiteral) {
      const literal = readLiteralValue(current, source);
      return typeof literal.value === 'string' ? literal.value : undefined;
    }
    if (current.name === NODE.ParenthesizedExpression) {
      const expression = current.getChild(NODE.Expression);
      if (expression) {
        current = expression;
        continue;
      }
    }
    if (
      EXPRESSION_NODES.has(current.name) &&
      current.firstChild &&
      current.lastChild &&
      current.firstChild.from === current.lastChild.from &&
      current.firstChild.to === current.lastChild.to
    ) {
      current = current.firstChild;
      continue;
    }
    return undefined;
  }
}

function expressionChildren(node: SyntaxNode): SyntaxNode[] {
  return [...EXPRESSION_NODES].flatMap((name) => node.getChildren(name));
}

// Deduplicate by source range and metadata value within this analysis pass.
function addDeprecation(
  ctx: SemanticContext,
  node: SyntaxNode,
  value: boolean | string | undefined
) {
  if (!value) {
    return;
  }
  const key = `${node.from}:${node.to}:${String(value)}`;
  if (ctx.deprecated.has(key)) {
    return;
  }
  ctx.deprecated.add(key);
  addDiagnostic(
    node,
    'warning',
    typeof value === 'string' ? value : 'Deprecated.',
    ctx.diagnostics
  );
}

function callableValue(callable: OpelCallable): Value {
  return { schema: ANY_VALUE_SCHEMA, callable };
}

function isKnownNonCallable(value: Value, ctx: SemanticContext): boolean {
  if (value.error) {
    return false;
  }
  const variants = resolveSchemaVariants(
    value.schema,
    schemaRootForValue(value),
    ctx.runtime
  );
  return (
    variants.length > 0 &&
    variants.every(
      (variant) =>
        !schemaObject(variant.schema)?.callable &&
        getSchemaTypes(variant.schema, variant.root, ctx.runtime).length > 0
    )
  );
}

function objectConstraintMessage(
  value: Value,
  schema: OpelSchema,
  ctx: SemanticContext
): string | null {
  if (!isRecord(value.literal) || !schemaObject(schema)) {
    return null;
  }
  const object = schemaObject(schema)!;
  const required = Array.isArray(object.required) ? object.required : [];
  const missing = required.find(
    (name) => !Object.prototype.hasOwnProperty.call(value.literal, name)
  );
  if (missing) {
    return `Property "${missing}" is missing from type ${valueDescription(value, ctx)}.`;
  }
  if (object.additionalProperties === false && isRecord(object.properties)) {
    const extra = Object.keys(value.literal as Record<string, unknown>).find(
      (name) => !Object.prototype.hasOwnProperty.call(object.properties, name)
    );
    if (extra) {
      return `Object literal may only specify known properties, and "${extra}" does not exist in type ${schemaDescription(schema, schema, ctx.runtime)}.`;
    }
  }
  return null;
}

function expectedArity(signatures: readonly OpelSignature[]): string {
  const ranges = signatures.map((signature) => {
    const required = signature.parameters.filter(
      (parameter) => !parameter.optional
    ).length;
    return `${required}-${signature.parameters.length}`;
  });
  const uniqueRanges = [...new Set(ranges)];
  if (uniqueRanges.length === 1) {
    const [required, maximum] = uniqueRanges[0].split('-').map(Number);
    return required === maximum
      ? `Expected ${required} argument${required === 1 ? '' : 's'}`
      : `Expected between ${required} and ${maximum} arguments`;
  }
  return `Expected one of ${uniqueRanges.map((range) => range.replace('-', ' to ')).join(', ')} arguments`;
}

function matchCallSignatures(
  callable: OpelCallable,
  args: Value[],
  ctx: SemanticContext
) {
  const arityCompatible = callable.signatures.filter((signature) => {
    const required = signature.parameters.filter(
      (parameter) => !parameter.optional
    ).length;
    return (
      args.length >= required && args.length <= signature.parameters.length
    );
  });
  const signatures = arityCompatible.filter((signature) =>
    signature.parameters.every(
      (parameter, index) =>
        !args[index] ||
        isCompatibleOrAlreadyErrored(
          args[index],
          parameter.schema,
          parameter.schema,
          ctx.runtime
        )
    )
  );
  return { arityCompatible, signatures };
}

// Filter by arity, then argument compatibility. Report mismatches only for complete calls.
function analyzeCall(
  callable: OpelCallable,
  args: Value[],
  node: SyntaxNode,
  ctx: SemanticContext,
  argNodes: SyntaxNode[] = []
): Value {
  const { arityCompatible, signatures } = matchCallSignatures(
    callable,
    args,
    ctx
  );
  if (node.getChild(NODE.RParen) && !node.type.isError) {
    if (signatures.length === 0) {
      if (arityCompatible.length === 0) {
        addDiagnostic(
          node,
          'error',
          `Call arity mismatch. ${expectedArity(callable.signatures)}, but got ${args.length}.`,
          ctx.diagnostics
        );
      } else {
        const mismatchDetails = arityCompatible.map((signature) => {
          const mismatchIndex = argNodes.findIndex(
            (arg, index) =>
              !isCompatibleOrAlreadyErrored(
                args[index],
                signature.parameters[index].schema,
                signature.parameters[index].schema,
                ctx.runtime
              )
          );
          return { signature, mismatchIndex };
        });
        const mismatchIndex = mismatchDetails[0]?.mismatchIndex ?? -1;
        const mismatchValue =
          mismatchIndex >= 0 ? args[mismatchIndex] : undefined;
        const mismatchSchema =
          mismatchIndex >= 0 &&
          mismatchDetails.every(
            (details) => details.mismatchIndex === mismatchIndex
          )
            ? createUnionSchema(
                mismatchDetails.map(
                  ({ signature }) => signature.parameters[mismatchIndex].schema
                )
              )
            : undefined;
        const constraint =
          mismatchValue && mismatchSchema
            ? objectConstraintMessage(mismatchValue, mismatchSchema, ctx)
            : null;
        const expectedParameter = mismatchSchema
          ? expectedParameterDescription(
              mismatchSchema,
              mismatchSchema,
              ctx.runtime
            )
          : arityCompatible
              .map(
                (signature) =>
                  `(${signature.parameters
                    .map((parameter) =>
                      schemaDescription(
                        parameter.schema,
                        parameter.schema,
                        ctx.runtime
                      )
                    )
                    .join(', ')})`
              )
              .join(' or ');
        const mismatchNode =
          mismatchIndex >= 0 ? argNodes[mismatchIndex] : undefined;
        addDiagnostic(
          mismatchNode ?? node,
          'error',
          constraint ??
            (mismatchSchema
              ? `Type mismatch: ${argumentDescription(mismatchValue, ctx)} is not assignable to ${expectedParameter}.`
              : `Type mismatch: ${argumentDescription(mismatchValue, ctx)} does not match any call signature. Expected one of ${expectedParameter}.`),
          ctx.diagnostics
        );
      }
      return { schema: ANY_VALUE_SCHEMA, error: true };
    }
    if (signatures.length > 1) {
      addDiagnostic(
        node,
        'warning',
        `Multiple function signatures could match this call: ${signatures.map((signature) => `(${signature.parameters.map((parameter) => schemaDescription(parameter.schema, parameter.schema, ctx.runtime)).join(', ')})`).join(' and ')}.`,
        ctx.diagnostics
      );
    }
  }
  const signature = signatures[0];
  if (!signature) {
    return { schema: ANY_VALUE_SCHEMA };
  }
  addDeprecation(ctx, node, signature.deprecated ?? callable.deprecated);
  const resultSchema =
    signatures.length === 1
      ? signature.returns
      : createUnionSchema(
          signatures.map((item) => item.returns),
          signatures.map((item) => schemaRootFor(item.returns, item.returns))
        );
  return {
    schema: resultSchema,
    root: schemaRootFor(resultSchema, resultSchema),
  };
}

function unknownRuntimeSymbolMessage(
  name: string,
  env: Environment,
  ctx: SemanticContext
): string {
  const candidates = [
    ...new Set([
      ...env.keys(),
      ...Object.keys(ctx.runtime.globals ?? {}),
      ...Object.keys(ctx.runtime.functions ?? {}),
    ]),
  ];
  const similarNames = findSimilarTerms(name, candidates);
  const message = [`Unknown symbol "${name}".`];
  if (similarNames.length > 0) {
    message.push(`Did you mean: ${similarNames.join(', ')}?`);
  }
  return message.join(' ');
}

function resolveIdentifier(
  name: string,
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const value = lookupIdentifier(name, env, ctx);
  if (value) {
    return value;
  }
  if (!ctx.suppressUnknownIdentifierAt.has(node.from)) {
    addDiagnostic(
      node,
      'error',
      unknownRuntimeSymbolMessage(name, env, ctx),
      ctx.diagnostics
    );
  }
  return { schema: ANY_VALUE_SCHEMA, error: true };
}

function namedMethodReceivers(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): OpelMethodReceiver[] {
  return [
    ...new Set(
      resolveSchemaVariants(schema, root, runtime).flatMap(
        (variant) => variant.references ?? []
      )
    ),
  ].filter(
    (reference) =>
      !PRIMITIVE_METHOD_RECEIVERS.includes(
        reference as OpelPrimitiveMethodReceiver
      )
  );
}

function methodReceivers(
  receiver: Value,
  runtime: OpelRuntime
): OpelMethodReceiver[] {
  const root = schemaRootForValue(receiver);
  const ordered = namedMethodReceivers(receiver.schema, root, runtime);
  for (const type of getSchemaTypes(receiver.schema, root, runtime)) {
    if (type === 'integer') {
      ordered.push('integer', 'number');
    } else if (
      PRIMITIVE_METHOD_RECEIVERS.includes(type as OpelPrimitiveMethodReceiver)
    ) {
      ordered.push(type);
    }
  }
  return [...new Set(ordered)];
}

// Undefined means unknown; null means no registration supports this alternative.
function resolveMethods(
  receiver: Value,
  name: string,
  ctx: SemanticContext
): (OpelCallable | null | undefined)[] {
  return resolveSchemaVariants(
    receiver.schema,
    schemaRootForValue(receiver),
    ctx.runtime
  )
    .flatMap((variant) => {
      const named = (variant.references ?? []).filter(
        (reference) =>
          !PRIMITIVE_METHOD_RECEIVERS.includes(
            reference as OpelPrimitiveMethodReceiver
          )
      );
      const types = getSchemaTypes(variant.schema, variant.root, ctx.runtime);
      return (types.length > 0 ? types : ['unknown'])
        .filter((type) => type !== 'never')
        .map((type) => {
          const receivers = [
            ...new Set([
              ...named,
              ...(type === 'integer'
                ? ['integer', 'number']
                : PRIMITIVE_METHOD_RECEIVERS.includes(
                      type as OpelPrimitiveMethodReceiver
                    )
                  ? [type]
                  : []),
            ]),
          ];
          let callable: OpelCallable | null | undefined =
            variant.schema === true ||
            (type === 'unknown' && named.length === 0)
              ? undefined
              : null;
          for (const receiver of receivers) {
            const registrations = Object.prototype.hasOwnProperty.call(
              ctx.runtime.methods ?? {},
              receiver
            )
              ? ctx.runtime.methods?.[receiver]
              : undefined;
            if (
              registrations &&
              Object.prototype.hasOwnProperty.call(registrations, name)
            ) {
              callable = registrations[name];
              break;
            }
          }
          return { key: JSON.stringify([...receivers, type]), callable };
        });
    })
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ callable }) => callable);
}

function analyzeMethodCall(
  receiver: Value,
  name: string,
  args: Value[],
  node: SyntaxNode,
  ctx: SemanticContext,
  argNodes: SyntaxNode[]
): Value {
  if (receiver.error) {
    return { schema: ANY_VALUE_SCHEMA };
  }
  if (isImpossibleValue(receiver, ctx)) {
    return { schema: NO_VALUES_SCHEMA, root: schemaRootForValue(receiver) };
  }
  const alternatives = resolveMethods(receiver, name, ctx);
  if (alternatives.length === 0) {
    return { schema: ANY_VALUE_SCHEMA };
  }
  const complete = node.getChild(NODE.RParen) && !node.type.isError;
  // Receiver alternatives dispatch independently; they are not ordinary overloads.
  const supported = alternatives.filter(
    (callable) =>
      callable === undefined ||
      (callable !== null &&
        (!complete ||
          matchCallSignatures(callable, args, ctx).signatures.length > 0))
  );
  if (supported.length === 0) {
    const callables = alternatives.flatMap((callable) =>
      callable ? [callable] : []
    );
    if (callables.length > 0) {
      return analyzeCall(
        { signatures: callables.flatMap((callable) => callable.signatures) },
        args,
        node,
        ctx,
        argNodes
      );
    }
    const description =
      alternatives.length === 1
        ? `type ${valueDescription(receiver, ctx)}`
        : 'every receiver variant';
    addDiagnostic(
      node,
      'error',
      `Invalid method "${name}" on ${description}. Available methods: ${formatNames(availableMethods(receiver, ctx))}.`,
      ctx.diagnostics
    );
    return { schema: ANY_VALUE_SCHEMA, error: true };
  }
  if (supported.length < alternatives.length) {
    addDiagnostic(
      node,
      'warning',
      `Method "${name}" can only be called on some receiver variants with these arguments.`,
      ctx.diagnostics
    );
  }
  const callables = [
    ...new Set(supported.flatMap((callable) => (callable ? [callable] : []))),
  ];
  const methodContext = { ...ctx, diagnostics: [] as Diagnostic[] };
  const results = callables.map((callable) => {
    const result = analyzeCall(callable, args, node, methodContext, argNodes);
    addDeprecation(methodContext, node, callable.deprecated);
    return result;
  });
  for (const diagnostic of methodContext.diagnostics) {
    if (
      !ctx.diagnostics.some(
        (existing) =>
          existing.from === diagnostic.from &&
          existing.to === diagnostic.to &&
          existing.severity === diagnostic.severity &&
          existing.message === diagnostic.message
      )
    ) {
      ctx.diagnostics.push(diagnostic);
    }
  }
  const resultValues = results.map((result) => ({
    schema: result.schema,
    root: schemaRootForValue(result),
  }));
  if (supported.includes(undefined)) {
    // An unknown receiver alternative may return any schema, so keep that result in the join.
    resultValues.push({ schema: ANY_VALUE_SCHEMA, root: receiver.schema });
  }
  return {
    schema: createUnionSchema(
      resultValues.map((result) => result.schema),
      resultValues.map((result) => result.root)
    ),
  };
}

// Distinguish explicit property support from permissive inference fallbacks.
function resolvePropertyAccess(
  receiver: Value,
  name: string,
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext,
  stableName?: string
): Value {
  if (receiver.error || receiver.schema === true) {
    return withPropertyPath(
      receiver,
      { schema: ANY_VALUE_SCHEMA },
      stableName,
      env
    );
  }
  if (isImpossibleValue(receiver, ctx)) {
    return withPropertyPath(
      receiver,
      { schema: NO_VALUES_SCHEMA, root: schemaRootForValue(receiver) },
      stableName,
      env
    );
  }
  const supports: Value[] = [];
  let hasExplicitSupport = false;
  let hasUnknownVariant = false;
  let unsupported = 0;
  const receiverRoot = schemaRootForValue(receiver);
  const variants = resolveSchemaVariants(
    receiver.schema,
    receiverRoot,
    ctx.runtime
  );
  for (const resolution of variants) {
    const variant = resolution.schema;
    if (variant === true) {
      hasUnknownVariant = true;
      continue;
    }
    if (variant === false) {
      continue;
    }
    const types = getSchemaTypes(variant, resolution.root, ctx.runtime);
    if (types.some((type) => type !== 'object' && type !== 'never')) {
      unsupported++;
    }
    if (types.length > 0 && !types.includes('object')) {
      continue;
    }
    const object = schemaObject(variant);
    if (!object) {
      unsupported++;
      continue;
    }
    const properties = isRecord(object.properties) ? object.properties : {};
    const hasProperty = Object.prototype.hasOwnProperty.call(properties, name);
    const propertySchemas = [
      ...(hasProperty ? [properties[name] as OpelSchema] : []),
      ...matchingPatternProperties(object, name),
    ];
    if (propertySchemas.length > 0) {
      hasExplicitSupport = true;
      const schema =
        propertySchemas.length === 1
          ? propertySchemas[0]
          : combineSchemaValues(propertySchemas, resolution.root, ctx.runtime);
      const propertyRoot = schemaRootFor(schema, resolution.root);
      const callable = schemaObject(schema)?.callable as
        | OpelCallable
        | undefined;
      supports.push({
        schema,
        root: propertyRoot,
        ...(callable ? { callable } : {}),
      });
      addDeprecation(
        ctx,
        node,
        hasProperty
          ? (schemaObject(properties[name] as OpelSchema)?.deprecated as
              | boolean
              | string
              | undefined)
          : undefined
      );
      continue;
    }
    if (object.additionalProperties === false) {
      unsupported++;
    } else {
      const hasPropertyRules =
        isRecord(object.properties) ||
        isRecord(object.patternProperties) ||
        object.additionalProperties !== undefined;
      if (!hasPropertyRules) {
        supports.push({ schema: ANY_VALUE_SCHEMA, root: resolution.root });
      } else {
        if (object.additionalProperties === undefined) {
          unsupported++;
        } else {
          hasExplicitSupport = true;
        }
        const schema =
          object.additionalProperties && object.additionalProperties !== true
            ? (object.additionalProperties as OpelSchema)
            : true;
        supports.push({
          schema,
          root: schemaRootFor(schema, resolution.root),
        });
      }
    }
  }
  if (hasUnknownVariant) {
    return { schema: ANY_VALUE_SCHEMA };
  }
  if (unsupported > 0) {
    const schemaName = schemaDisplayName(receiver.schema, ctx.runtime);
    const properties = availableProperties(
      receiver.schema,
      ctx,
      schemaRootForValue(receiver)
    );
    const propertyHint = formatPropertyHint(name, properties);
    const message = hasExplicitSupport
      ? `Property "${name}" is only defined for some variants${schemaName ? ` of schema "${schemaName}"` : ''}.`
      : `Property "${name}" is not defined${schemaName ? ` in schema "${schemaName}"` : ''}.`;
    addDiagnostic(
      node,
      supports.length === 0 ? 'error' : 'warning',
      `${message} ${propertyHint}`,
      ctx.diagnostics
    );
  }
  const callable = supports.length === 1 ? supports[0].callable : undefined;
  return withPropertyPath(
    receiver,
    {
      schema: createUnionSchema(
        supports.map((value) => value.schema),
        supports.map((value) => schemaRootForValue(value))
      ),
      root: supports[0]?.root ?? receiverRoot,
      ...(callable ? { callable } : {}),
    },
    stableName,
    env
  );
}

function withPropertyPath(
  receiver: Value,
  property: Value,
  name: string | undefined,
  env: Environment
): Value {
  if (name === undefined || !receiver.path) {
    return property;
  }
  return applyPathNarrowing(env, {
    ...property,
    path: {
      root: receiver.path.root,
      segments: [...receiver.path.segments, name],
    },
    pathParent: receiver,
  });
}

function applyPathNarrowing(env: Environment, value: Value): Value {
  if (!value.path) {
    return value;
  }
  const narrowing = environmentNarrowings(env).get(stablePathKey(value.path));
  return narrowing ? { ...value, ...narrowing } : value;
}

// Local shadowing applies equally to bare calls and identifier expressions.
function lookupIdentifier(
  name: string,
  env: Environment,
  ctx: SemanticContext
): Value | undefined {
  const localBinding = env.get(name);
  if (localBinding) {
    localBinding.used = true;
    const value = applyPathNarrowing(env, localBinding.value);
    return value;
  }
  const globals = ctx.runtime.globals;
  if (globals && Object.prototype.hasOwnProperty.call(globals, name)) {
    const schema = globals[name];
    return applyPathNarrowing(env, {
      schema,
      root: schema,
      path: { root: `global:${name}`, segments: [] },
    });
  }
  const functions = ctx.runtime.functions;
  return functions && Object.prototype.hasOwnProperty.call(functions, name)
    ? callableValue(functions[name])
    : undefined;
}

// A failed expression must not produce another argument-type error.
function isCompatibleOrAlreadyErrored(
  value: Value,
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  return (
    value.error === true ||
    isSchemaValueCompatible(value, schema, root, runtime)
  );
}
