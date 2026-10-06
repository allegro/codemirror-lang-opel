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
  resolveSchemaReference,
  combineSchemaValues,
  resolveSchemaVariants,
  getSchemaTypes,
  valueType,
  matchingPatternProperties,
  literalEqual,
} from './schema';

const EXPRESSION_NODES = new Set([
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

// Unknown and impossible use schema true/false; undefined literal means unavailable.
// Error marks an already-reported failure for dependent diagnostic suppression.
type Value = SchemaValue & { callable?: OpelCallable; error?: boolean };

type Environment = Map<string, Value>;

// Derived values resolve local references against the document that introduced them.
function schemaRoot(value: Value): OpelSchema {
  return value.root ?? value.schema;
}

type SemanticContext = {
  source: string;
  runtime: OpelRuntime;
  diagnostics: Diagnostic[];
  deprecated: Set<string>;
  suppressUnknownIdentifierAt: ReadonlySet<number>;
};

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
  tree.cursor().iterate((node) => {
    if (node.name === NODE.Body && node.node.parent?.name !== NODE.Body) {
      analyzeScopeBody(node.node, new Map(), ctx);
    }
  });
  return ctx.diagnostics;
}

// Infer each initializer before inserting its binding; declarations are visible in source order.
function analyzeScopeBody(
  body: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const declarations = body.getChild(NODE.Declarations);
  if (declarations) {
    for (const declaration of declarations.getChildren(NODE.Declaration)) {
      const nameNode = declaration
        .getChild(NODE.VariableName)
        ?.getChild(NODE.Identifier);
      const expression = declaration.getChild(NODE.Expression);
      const value = expression
        ? analyzeExpression(expression, env, ctx)
        : { schema: true };
      if (nameNode) {
        env.set(ctx.source.slice(nameNode.from, nameNode.to), value);
      }
    }
  }
  const expression = body.getChild(NODE.Expression);
  return expression
    ? analyzeExpression(expression, env, ctx)
    : { schema: true };
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
      return atom ? analyzeExpression(atom, env, ctx) : { schema: true };
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
        };
      }
      break;
    }
    case NODE.BlockExpression: {
      const body = node.getChild(NODE.Body);
      return body
        ? analyzeScopeBody(body, new Map(env), ctx)
        : { schema: true };
    }
    case NODE.FunctionBody:
      return node.firstChild
        ? analyzeExpression(node.firstChild, env, ctx)
        : { schema: true };
    case NODE.UnaryExpression:
      return analyzeExpression(node.lastChild ?? node, env, ctx);
  }
  return analyzeOperators(node, env, ctx);
}

// Both branches are checked, without condition-based narrowing.
function analyzeConditional(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const branches = node.getChildren(NODE.Expression);
  if (branches.length >= 3) {
    analyzeExpression(branches[0], env, ctx);
    return {
      schema: createUnionSchema([
        analyzeExpression(branches[1], env, ctx).schema,
        analyzeExpression(branches[2], env, ctx).schema,
      ]),
    };
  }
  return analyzeOperators(node, env, ctx);
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
    return { schema: true, error: true };
  }
  const argNodes = node.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
  const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
  if (!value.callable) {
    if (!value.error) {
      addDiagnostic(
        node,
        'error',
        `Symbol "${name}" is not callable.`,
        ctx.diagnostics
      );
    }
    return { schema: true, error: true };
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
  const localEnvironment = new Map(env);
  for (const name of names) {
    localEnvironment.set(name, { schema: true });
  }
  const returnValue = body?.firstChild
    ? analyzeExpression(body.firstChild, localEnvironment, ctx)
    : { schema: true };
  return callableValue({
    signatures: [
      {
        parameters: names.map(
          (name): OpelParameter => ({ name, schema: true })
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
    : { schema: true };
  for (const postfix of node.getChildren(NODE.Postfix)) {
    const method = postfix.getChild(NODE.MethodCall);
    const field = postfix.getChild(NODE.FieldAccess);
    const group = postfix.getChild(NODE.CallGroup);
    if (method) {
      const nameNode = method.getChild(NODE.Identifier);
      const name = nameNode ? ctx.source.slice(nameNode.from, nameNode.to) : '';
      const callable = resolveMethod(value, name, ctx);
      const argNodes =
        method.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
      const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
      if (!callable) {
        addDiagnostic(
          method,
          'error',
          `Invalid method "${name}" on type ${valueDescription(value, ctx)}. Available methods: ${formatNames(availableMethods(value, ctx))}.`,
          ctx.diagnostics
        );
        value = { schema: true, error: true };
      } else {
        value = analyzeCall(callable, args, method, ctx, argNodes);
        addDeprecation(ctx, method, callable.deprecated);
      }
    } else if (field) {
      const dot = field.getChild(NODE.Identifier);
      if (dot) {
        value = resolvePropertyAccess(
          value,
          ctx.source.slice(dot.from, dot.to),
          field,
          ctx
        );
      } else {
        const expression = field.getChild(NODE.Expression);
        const key = expression
          ? analyzeExpression(expression, env, ctx)
          : { schema: true };
        const receiverRoot = schemaRoot(value);
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
              const items = schemaObject(resolution.schema)?.items as
                | OpelSchema
                | undefined;
              return items === undefined
                ? []
                : [
                    {
                      schema: items,
                      root: schemaRootFor(items, resolution.root),
                    },
                  ];
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
          value = resolvePropertyAccess(value, key.literal, field, ctx);
        } else if (
          receiverTypes.includes('object') &&
          schemaObject(value.schema)?.additionalProperties === false
        ) {
          addDiagnostic(
            field,
            'warning',
            `Dynamic property access is discouraged on closed object type ${schemaDescription(value.schema, schemaRoot(value), ctx.runtime)}; use a known property name.`,
            ctx.diagnostics
          );
        } else {
          value = { schema: true };
        }
      }
    } else if (group) {
      const argNodes =
        group.getChild(NODE.Args)?.getChildren(NODE.Expression) ?? [];
      const args = argNodes.map((arg) => analyzeExpression(arg, env, ctx));
      if (!value.callable) {
        if (!value.error) {
          addDiagnostic(
            group,
            'error',
            `This expression is not callable. Type '${valueDescription(value, ctx)}' has no call signatures.`,
            ctx.diagnostics
          );
        }
        value = { schema: true, error: true };
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
      : { schema: true };
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
      items: createUnionSchema(values.map((value) => value.schema)),
    },
    literal: values.every((value) => value.literal !== undefined)
      ? values.map((value) => value.literal)
      : undefined,
  };
}

function analyzeMap(
  map: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const literal: Record<string, unknown> = {};
  const properties: Record<string, OpelSchema> = {};
  const pairs = map.getChild(NODE.Pairs);
  for (const pair of pairs ? pairs.getChildren(NODE.Pair) : []) {
    const key = pair.firstChild;
    const valueNode = pair.getChild(NODE.Expression);
    if (!key || !valueNode) {
      continue;
    }
    const keyText = ctx.source.slice(key.from, key.to);
    const atom = key.getChild(NODE.Atom);
    const literalKey = readLiteralValue(
      atom?.getChild(NODE.StringLiteral) ?? key,
      ctx.source
    );
    const keyValue = literalKey.hasLiteralValue
      ? literalKey.value
      : atom?.getChild(NODE.NamedValue)?.getChild(NODE.Identifier)
        ? keyText
        : undefined;
    if (typeof keyValue === 'string') {
      const value = analyzeExpression(valueNode, env, ctx);
      properties[keyValue] = value.callable
        ? { callable: value.callable }
        : value.schema;
      if (value.literal !== undefined) {
        literal[keyValue] = value.literal;
      }
    }
  }
  return {
    schema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    literal:
      Object.keys(literal).length === Object.keys(properties).length
        ? literal
        : undefined,
  };
}

// Wrapper nodes forward their operand; actual operators infer a result without evaluation.
function analyzeOperators(
  node: SyntaxNode,
  env: Environment,
  ctx: SemanticContext
): Value {
  const parts = expressionChildren(node);
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
      return { schema: { type: 'boolean' } };
    }
    if (
      node.name === NODE.AdditiveExpression ||
      node.name === NODE.MultiplyExpression
    ) {
      if (validateArithmeticOperands(node, values, ctx)) {
        return { schema: true, error: true };
      }
    }
    if (
      node.name === NODE.AdditiveExpression &&
      node.getChildren(NODE.Plus).length > 0 &&
      values.every((value) =>
        getSchemaTypes(value.schema, schemaRoot(value), ctx.runtime).includes(
          'string'
        )
      )
    ) {
      return { schema: { type: 'string' } };
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
  return { schema: true };
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
      schemaRoot(left),
      ctx.runtime
    );
    const rightTypes = getSchemaTypes(
      right.schema,
      schemaRoot(right),
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
      return schemaDescription(value.schema, schemaRoot(value), ctx.runtime);
    }
    return type;
  }
  const namedReceiver = namedMethodReceivers(
    value.schema,
    schemaRoot(value),
    ctx.runtime
  )[0];
  if (namedReceiver) {
    return namedReceiver;
  }
  return schemaDescription(value.schema, schemaRoot(value), ctx.runtime);
}

function availableProperties(
  schema: OpelSchema,
  ctx: SemanticContext,
  root: OpelSchema = schema
): string[] {
  const names = new Set<string>();
  for (const variant of resolveSchemaVariants(schema, root, ctx.runtime)) {
    const properties = schemaObject(variant)?.properties;
    if (isRecord(properties)) {
      Object.keys(properties).forEach((name) => names.add(name));
    }
  }
  return [...names].sort();
}

// Use the same receiver kinds as dispatch, including integer-to-number inheritance.
function availableMethods(receiver: Value, ctx: SemanticContext): string[] {
  const names = new Set<string>();
  for (const type of methodReceivers(receiver, ctx.runtime)) {
    const methods = ctx.runtime.methods?.[type];
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
  return { schema: true, callable };
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
    (name) => !(name in (value.literal as Record<string, unknown>))
  );
  if (missing) {
    return `Property "${missing}" is missing from type ${valueDescription(value, ctx)}.`;
  }
  if (object.additionalProperties === false && isRecord(object.properties)) {
    const extra = Object.keys(value.literal as Record<string, unknown>).find(
      (name) => !(name in (object.properties as Record<string, unknown>))
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

// Filter by arity, then argument compatibility. Report mismatches only for complete calls.
function analyzeCall(
  callable: OpelCallable,
  args: Value[],
  node: SyntaxNode,
  ctx: SemanticContext,
  argNodes: SyntaxNode[] = []
): Value {
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
        isValueCompatibleWithSchema(
          args[index],
          parameter.schema,
          parameter.schema,
          ctx.runtime
        )
    )
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
              !isValueCompatibleWithSchema(
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
      return { schema: true, error: true };
    }
    if (signatures.length > 1) {
      addDiagnostic(
        node,
        'warning',
        `Call is ambiguous; matches ${signatures.map((signature) => `(${signature.parameters.map((parameter) => schemaDescription(parameter.schema, parameter.schema, ctx.runtime)).join(', ')})`).join(' and ')}.`,
        ctx.diagnostics
      );
    }
  }
  const signature = signatures[0];
  if (!signature) {
    return { schema: true };
  }
  addDeprecation(ctx, node, signature.deprecated ?? callable.deprecated);
  const resultSchema =
    signatures.length === 1
      ? signature.returns
      : createUnionSchema(signatures.map((item) => item.returns));
  return { schema: resultSchema, root: resultSchema };
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
  return { schema: true, error: true };
}

function namedMethodReceivers(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime,
  seen = new Set<OpelSchema>()
): OpelMethodReceiver[] {
  if (!isRecord(schema) || seen.has(schema)) {
    return [];
  }
  seen.add(schema);
  if (typeof schema.$ref === 'string') {
    if (schema.$ref.startsWith('#/')) {
      const resolved = resolveSchemaReference(schema, root, runtime);
      return resolved.schema === schema
        ? []
        : namedMethodReceivers(resolved.schema, resolved.root, runtime, seen);
    }
    const target = runtime.schemas?.[schema.$ref];
    if (
      target === undefined ||
      PRIMITIVE_METHOD_RECEIVERS.includes(
        schema.$ref as OpelPrimitiveMethodReceiver
      )
    ) {
      return [];
    }
    return [
      schema.$ref,
      ...namedMethodReceivers(target, target, runtime, seen),
    ];
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      return schema[key].flatMap((child) =>
        namedMethodReceivers(child, root, runtime, seen)
      );
    }
  }
  return [];
}

function methodReceivers(
  receiver: Value,
  runtime: OpelRuntime
): OpelMethodReceiver[] {
  const root = schemaRoot(receiver);
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

// Named schemas and aliases precede primitives; select the first registration.
function resolveMethod(
  receiver: Value,
  name: string,
  ctx: SemanticContext
): OpelCallable | null {
  for (const type of methodReceivers(receiver, ctx.runtime)) {
    const callable = ctx.runtime.methods?.[type]?.[name];
    if (callable) {
      return callable;
    }
  }
  return null;
}

// Track supporting and unsupported branches separately to distinguish partial access from absence.
function resolvePropertyAccess(
  receiver: Value,
  name: string,
  node: SyntaxNode,
  ctx: SemanticContext
): Value {
  if (receiver.error || receiver.schema === true) {
    return { schema: true };
  }
  const supports: Value[] = [];
  let unsupported = 0;
  const receiverRoot = schemaRoot(receiver);
  for (const resolution of resolveSchemaVariants(
    receiver.schema,
    receiverRoot,
    ctx.runtime
  )) {
    const variant = resolution.schema;
    if (variant === true) {
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
    const propertySchemas = [
      ...(name in properties ? [properties[name] as OpelSchema] : []),
      ...matchingPatternProperties(object, name),
    ];
    if (propertySchemas.length > 0) {
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
        name in properties
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
        supports.push({ schema: true, root: resolution.root });
      } else {
        if (object.additionalProperties === undefined) {
          unsupported++;
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
  if (supports.length === 0 && unsupported > 0) {
    addDiagnostic(
      node,
      'error',
      `Unknown property "${name}" on type ${schemaDescription(receiver.schema, schemaRoot(receiver), ctx.runtime)}. Available properties: ${formatNames(availableProperties(receiver.schema, ctx, schemaRoot(receiver)))}.`,
      ctx.diagnostics
    );
  } else if (unsupported > 0) {
    addDiagnostic(
      node,
      'warning',
      `Be careful: property "${name}" is not available on every member of type ${schemaDescription(receiver.schema, schemaRoot(receiver), ctx.runtime)}. Available properties: ${formatNames(availableProperties(receiver.schema, ctx, schemaRoot(receiver)))}.`,
      ctx.diagnostics
    );
  }
  const callable = supports.length === 1 ? supports[0].callable : undefined;
  return {
    schema: createUnionSchema(
      supports.map((value) => value.schema),
      supports.map((value) => schemaRoot(value))
    ),
    root: supports[0]?.root ?? receiverRoot,
    ...(callable ? { callable } : {}),
  };
}

// Local shadowing applies equally to bare calls and identifier expressions.
function lookupIdentifier(
  name: string,
  env: Environment,
  ctx: SemanticContext
): Value | undefined {
  const localBinding = env.get(name);
  if (localBinding) {
    return localBinding;
  }
  const schema = ctx.runtime.globals?.[name];
  if (schema !== undefined) {
    return { schema, root: schema };
  }
  const callable = ctx.runtime.functions?.[name];
  return callable ? callableValue(callable) : undefined;
}

// A failed expression must not produce another argument-type error.
function isValueCompatibleWithSchema(
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
