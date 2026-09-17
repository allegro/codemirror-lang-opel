import type { Diagnostic } from '@codemirror/lint';
import type { SyntaxNode } from '@lezer/common';
import type {
  OpelCallable,
  OpelMethodReceiver,
  OpelPrimitive,
  OpelParameter,
  OpelRuntime,
  OpelSchema,
  OpelSignature,
} from '../types';
import type { RuntimeContext } from '../runtime';
import { OPEL_NODE_NAMES as NODE } from '../syntax/nodes';
import { findSimilarTerms } from './similar-terms';

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
const RECEIVERS: readonly OpelMethodReceiver[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
];

type Value = {
  schema: OpelSchema;
  root?: OpelSchema;
  literal?: unknown;
  callable?: Callable;
  error?: boolean;
  runtime?: boolean;
};
type Callable = OpelCallable & { isLocal?: boolean };
type Environment = Map<string, Value>;

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
  if (node.name === NODE.Expression) {
    return analyzeExpression(node.firstChild ?? node, env, ctx);
  }
  if (node.name === NODE.IfExpression) {
    const branches = node.getChildren(NODE.Expression);
    if (branches.length >= 3) {
      return {
        schema: createUnionSchema([
          analyzeExpression(branches[1], env, ctx).schema,
          analyzeExpression(branches[2], env, ctx).schema,
        ]),
      };
    }
  }
  if (node.name === NODE.FunctionCall) {
    const nameNode = node.getChild(NODE.Identifier);
    const name = nameNode ? ctx.source.slice(nameNode.from, nameNode.to) : '';
    const localBinding = env.get(name);
    const resolvedValue =
      localBinding ??
      (ctx.runtime.globals?.[name] !== undefined
        ? {
            schema: ctx.runtime.globals[name],
            root: ctx.runtime.globals[name],
            runtime: true,
          }
        : undefined) ??
      (ctx.runtime.functions?.[name]
        ? callableValue({ ...ctx.runtime.functions[name], isLocal: false })
        : undefined);
    if (!resolvedValue) {
      addDiagnostic(
        node,
        'error',
        `Unknown function "${name}".`,
        ctx.diagnostics
      );
      return { schema: true, error: true };
    }
    const value = resolvedValue;
    const args = node.getChild(NODE.Args)
      ? node
          .getChild(NODE.Args)!
          .getChildren(NODE.Expression)
          .map((arg) => analyzeExpression(arg, env, ctx))
      : [];
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
    return analyzeCall(
      value.callable,
      args,
      node,
      ctx,
      value.schema,
      node.getChild(NODE.Args)
        ? node.getChild(NODE.Args)!.getChildren(NODE.Expression)
        : []
    );
  }
  if (node.name === NODE.FunctionInstantiation) {
    const params = node.getChild(NODE.LambdaParams);
    const names = params
      ? params.getChild(NODE.SingleParam)?.getChild(NODE.Identifier)
        ? [
            ctx.source.slice(
              params.getChild(NODE.SingleParam)!.getChild(NODE.Identifier)!
                .from,
              params.getChild(NODE.SingleParam)!.getChild(NODE.Identifier)!.to
            ),
          ]
        : (params.getChild(NODE.MultiParam) ?? params)
            .getChildren(NODE.Identifier)
            .map((item) => ctx.source.slice(item.from, item.to))
      : [];
    const body = node.getChild(NODE.FunctionBody);
    const localEnvironment = new Map(env);
    for (const name of names) {
      localEnvironment.set(name, { schema: true });
    }
    const returnValue = body?.firstChild
      ? analyzeExpression(body.firstChild, localEnvironment, ctx)
      : { schema: true };
    return callableValue({
      isLocal: true,
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
  if (node.name === NODE.PostfixExpression) {
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
        const name = nameNode
          ? ctx.source.slice(nameNode.from, nameNode.to)
          : '';
        const callable = resolveMethod(value, name, ctx);
        const args = method.getChild(NODE.Args)
          ? method
              .getChild(NODE.Args)!
              .getChildren(NODE.Expression)
              .map((arg) => analyzeExpression(arg, env, ctx))
          : [];
        if (!callable) {
          addDiagnostic(
            method,
            'error',
            `Invalid method "${name}" on type ${valueDescription(value, ctx)}. Available methods: ${formatNames(availableMethods(value, ctx))}.`,
            ctx.diagnostics
          );
          value = { schema: true, error: true };
        } else {
          value = analyzeCall(
            callable,
            args,
            method,
            ctx,
            value.schema,
            method.getChild(NODE.Args)
              ? method.getChild(NODE.Args)!.getChildren(NODE.Expression)
              : []
          );
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
          const receiverTypes = getSchemaTypes(
            value.schema,
            value.schema,
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
              value = {
                schema:
                  (schemaObject(value.schema)?.items as OpelSchema) ?? true,
                root: schemaRoot(value),
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
        const args = group.getChild(NODE.Args)
          ? group
              .getChild(NODE.Args)!
              .getChildren(NODE.Expression)
              .map((arg) => analyzeExpression(arg, env, ctx))
          : [];
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
          value = analyzeCall(
            value.callable,
            args,
            group,
            ctx,
            value.schema,
            group.getChild(NODE.Args)
              ? group.getChild(NODE.Args)!.getChildren(NODE.Expression)
              : []
          );
        }
      }
    }
    return value;
  }
  if (node.name === NODE.Primary) {
    const postfixExpression = node.getChild(NODE.PostfixExpression);
    if (postfixExpression) {
      return analyzeExpression(postfixExpression, env, ctx);
    }
    const atom = node.getChild(NODE.Atom);
    return atom ? analyzeExpression(atom, env, ctx) : { schema: true };
  }
  if (node.name === NODE.Atom) {
    const named = node.getChild(NODE.NamedValue);
    if (named) {
      const literal = readLiteralValue(named, ctx.source);
      if (literal.hasLiteralValue) {
        return {
          schema: { type: valueType(literal.value) as never },
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
      return { schema: { type: valueType(value) as never }, literal: value };
    }
    const string = node.getChild(NODE.StringLiteral);
    if (string) {
      const value = readLiteralValue(string, ctx.source).value;
      return { schema: { type: 'string' }, literal: value };
    }
    const list = node.getChild(NODE.ListInstantiation);
    if (list) {
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
    const map = node.getChild(NODE.MapInstantiation);
    if (map) {
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
        const keyValue = /^['"].*['"]$/.test(keyText)
          ? keyText.slice(1, -1)
          : readLiteralValue(key, ctx.source).value;
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
        schema: { type: 'object', properties },
        literal:
          Object.keys(literal).length === Object.keys(properties).length
            ? literal
            : undefined,
      };
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
  }
  if (
    node.name === NODE.NamedValue ||
    node.name === NODE.Number ||
    node.name === NODE.StringLiteral
  ) {
    const literal = readLiteralValue(node, ctx.source);
    if (literal.hasLiteralValue) {
      return {
        schema: { type: valueType(literal.value) as never },
        literal: literal.value,
      };
    }
  }
  if (node.name === NODE.BlockExpression) {
    const body = node.getChild(NODE.Body);
    return body ? analyzeScopeBody(body, new Map(env), ctx) : { schema: true };
  }
  if (node.name === NODE.FunctionBody) {
    return node.firstChild
      ? analyzeExpression(node.firstChild, env, ctx)
      : { schema: true };
  }
  if (node.name === NODE.UnaryExpression) {
    return analyzeExpression(node.lastChild ?? node, env, ctx);
  }
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
        ? 'both operands to be numbers or both strings'
        : 'both operands to be numbers';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function schemaObject(value: OpelSchema): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function createUnionSchema(schemas: OpelSchema[]): OpelSchema {
  const flattened: OpelSchema[] = [];
  for (const schema of schemas) {
    const object = schemaObject(schema);
    if (object && Array.isArray(object.oneOf)) {
      flattened.push(...(object.oneOf as OpelSchema[]));
    } else if (schema !== true) {
      flattened.push(schema);
    }
  }
  if (flattened.length === 0) {
    return true;
  }
  if (flattened.length === 1) {
    return flattened[0];
  }
  return { oneOf: flattened };
}

function resolveSchemaReference(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime,
  seen = new Set<string>()
): OpelSchema {
  const object = schemaObject(schema);
  if (!object || typeof object.$ref !== 'string' || seen.has(object.$ref)) {
    return schema;
  }
  const ref = object.$ref;
  seen.add(ref);
  if (ref.startsWith('#/')) {
    const [section, name] = ref.slice(2).split('/');
    const rootObject = schemaObject(root);
    const definitions = rootObject?.[section];
    if (isRecord(definitions) && name in definitions) {
      return resolveSchemaReference(
        definitions[name] as OpelSchema,
        root,
        runtime,
        seen
      );
    }
    return false;
  }
  const external = runtime.schemas?.[ref];
  return external === undefined
    ? false
    : resolveSchemaReference(external, external, runtime, seen);
}

function intersectSchemaTypes(typeSets: string[][]): string[] {
  if (typeSets.length === 0) {
    return [];
  }
  let intersection = new Set(typeSets[0]);
  for (const types of typeSets.slice(1)) {
    const next = new Set<string>();
    for (const left of intersection) {
      for (const right of types) {
        if (left === right) {
          next.add(left);
        } else if (
          (left === 'number' && right === 'integer') ||
          (left === 'integer' && right === 'number')
        ) {
          next.add('integer');
        }
      }
    }
    intersection = next;
  }
  return [...intersection];
}

function resolveSchemaVariants(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): OpelSchema[] {
  const resolved = resolveSchemaReference(schema, root, runtime);
  if (resolved === true || resolved === false) {
    return [resolved];
  }
  const object = schemaObject(resolved);
  if (!object) {
    return [resolved];
  }
  // oneOf/anyOf are static unions here; runtime exclusivity is intentionally not evaluated.
  if (Array.isArray(object.oneOf)) {
    return object.oneOf.flatMap((child) =>
      resolveSchemaVariants(child as OpelSchema, root, runtime)
    );
  }
  if (Array.isArray(object.anyOf)) {
    return object.anyOf.flatMap((child) =>
      resolveSchemaVariants(child as OpelSchema, root, runtime)
    );
  }
  if (Array.isArray(object.allOf)) {
    const branches = object.allOf.flatMap((child) =>
      resolveSchemaVariants(child as OpelSchema, root, runtime)
    );
    const branchTypes = branches.map((branch) =>
      getSchemaTypes(branch, root, runtime)
    );
    if (branchTypes.some((types) => types.includes('never'))) {
      return [false];
    }
    const constrainedTypes = branchTypes.filter((types) => types.length > 0);
    const intersection = intersectSchemaTypes(constrainedTypes);
    if (constrainedTypes.length > 1 && intersection.length === 0) {
      return [false];
    }
    return [
      {
        ...object,
        allOf: branches,
        ...(intersection.length > 0
          ? {
              type:
                intersection.length === 1
                  ? (intersection[0] as OpelPrimitive)
                  : (intersection as OpelPrimitive[]),
            }
          : {}),
      },
    ];
  }
  return [resolved];
}

function getSchemaTypes(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): string[] {
  if (schema === true) {
    return [];
  }
  if (schema === false) {
    return ['never'];
  }
  const types = new Set<string>();
  for (const variant of resolveSchemaVariants(schema, root, runtime)) {
    if (variant === true) {
      continue;
    }
    if (variant === false) {
      types.add('never');
    } else if (variant.type) {
      for (const type of Array.isArray(variant.type)
        ? variant.type
        : [variant.type]) {
        types.add(type as string);
      }
      if (variant.nullable) {
        types.add('null');
      }
    } else if (
      variant.properties ||
      variant.additionalProperties !== undefined ||
      variant.patternProperties
    ) {
      types.add('object');
    } else if (variant.const !== undefined) {
      types.add(valueType(variant.const));
    } else if (variant.enum?.length) {
      for (const value of variant.enum) {
        types.add(valueType(value));
      }
    }
  }
  return [...types];
}

function valueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

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
      .map((branch) => schemaDescription(branch, root, runtime, seen))
      .join(' | ');
  }

  const resolved = branches[0];
  if (resolved === true) {
    return 'unknown';
  }
  if (resolved === false) {
    return 'never';
  }
  const object = schemaObject(resolved);
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

function valueDescription(value: Value, ctx: SemanticContext): string {
  if (value.literal !== undefined) {
    const type = valueType(value.literal);
    if (type === 'object' || type === 'array') {
      return schemaDescription(value.schema, schemaRoot(value), ctx.runtime);
    }
    return type;
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

function availableMethods(receiver: Value, ctx: SemanticContext): string[] {
  const names = new Set<string>();
  for (const type of getSchemaTypes(
    receiver.schema,
    schemaRoot(receiver),
    ctx.runtime
  )) {
    const methods = ctx.runtime.methods?.[type as OpelMethodReceiver];
    if (methods) {
      Object.keys(methods).forEach((name) => names.add(name));
    }
    if (type === 'integer' && ctx.runtime.methods?.number) {
      Object.keys(ctx.runtime.methods.number).forEach((name) =>
        names.add(name)
      );
    }
  }
  return [...names].sort();
}

function formatNames(names: string[]): string {
  return names.length > 0
    ? names.map((name) => `"${name}"`).join(', ')
    : 'none';
}

function schemaAllowsType(
  schema: OpelSchema,
  type: string,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (schema === true) {
    return true;
  }
  return resolveSchemaVariants(schema, root, runtime).some((variant) => {
    if (variant === true) {
      return true;
    }
    if (variant === false) {
      return false;
    }
    const types = getSchemaTypes(variant, root, runtime);
    return (
      types.length === 0 ||
      types.includes(type) ||
      (type === 'integer' && types.includes('number')) ||
      (type === 'null' && variant.nullable === true)
    );
  });
}

function literalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInferredSchemaCompatible(
  sourceSchema: OpelSchema,
  targetSchema: OpelSchema,
  sourceRoot: OpelSchema,
  targetRoot: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (sourceSchema === true) {
    return true;
  }
  if (sourceSchema === false) {
    return false;
  }
  const sourceTypes = getSchemaTypes(sourceSchema, sourceRoot, runtime);
  if (sourceTypes.includes('never')) {
    return false;
  }
  if (sourceTypes.length === 0) {
    return true;
  }
  return sourceTypes.every((sourceType) =>
    resolveSchemaVariants(targetSchema, targetRoot, runtime).some((variant) => {
      if (variant === true) {
        return true;
      }
      return (
        variant !== false &&
        schemaAllowsType(variant, sourceType, targetRoot, runtime)
      );
    })
  );
}

function isValueCompatibleWithSchema(
  value: Value,
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (schema === true || value.error) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  if (value.literal === undefined) {
    return isInferredSchemaCompatible(
      value.schema,
      schema,
      schemaRoot(value),
      root,
      runtime
    );
  }
  for (const variant of resolveSchemaVariants(schema, root, runtime)) {
    if (variant === true) {
      return true;
    }
    if (variant === false) {
      continue;
    }
    if (
      variant.const !== undefined &&
      !literalEqual(value.literal, variant.const)
    ) {
      continue;
    }
    if (
      variant.enum &&
      !variant.enum.some((item) => literalEqual(item, value.literal))
    ) {
      continue;
    }
    const type = valueType(value.literal);
    if (!schemaAllowsType(variant, type, root, runtime)) {
      continue;
    }
    if (
      type === 'object' &&
      !isObjectCompatibleWithSchema(value, variant, root, runtime)
    ) {
      continue;
    }
    if (
      type === 'array' &&
      variant.items &&
      Array.isArray(value.literal) &&
      !value.literal.every((item) =>
        isValueCompatibleWithSchema(
          { schema: { type: valueType(item) as never }, literal: item },
          variant.items as OpelSchema,
          root,
          runtime
        )
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function isObjectCompatibleWithSchema(
  value: Value,
  schema: Record<string, unknown>,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (!isRecord(value.literal)) {
    return true;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const literal = value.literal as Record<string, unknown>;
  if (required.some((name) => !(name in literal))) {
    return false;
  }
  for (const [name, child] of Object.entries(literal)) {
    if (
      name in properties &&
      !isValueCompatibleWithSchema(
        { schema: child as OpelSchema, literal: child },
        properties[name] as OpelSchema,
        root,
        runtime
      )
    ) {
      return false;
    }
    if (!(name in properties) && schema.additionalProperties === false) {
      return false;
    }
  }
  return true;
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

function callableValue(callable: Callable): Value {
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

function analyzeCall(
  callable: Callable,
  args: Value[],
  node: SyntaxNode,
  ctx: SemanticContext,
  root: OpelSchema,
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
          root,
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
        const mismatch = argNodes.find(
          (arg, index) =>
            !isValueCompatibleWithSchema(
              args[index],
              arityCompatible[0].parameters[index].schema,
              root,
              ctx.runtime
            )
        );
        const mismatchIndex = argNodes.findIndex(
          (arg, index) =>
            !isValueCompatibleWithSchema(
              args[index],
              arityCompatible[0].parameters[index].schema,
              root,
              ctx.runtime
            )
        );
        const mismatchValue =
          mismatchIndex >= 0 ? args[mismatchIndex] : undefined;
        const mismatchSchema =
          mismatchIndex >= 0
            ? arityCompatible[0].parameters[mismatchIndex].schema
            : undefined;
        const constraint =
          mismatchValue && mismatchSchema
            ? objectConstraintMessage(mismatchValue, mismatchSchema, ctx)
            : null;
        addDiagnostic(
          constraint ? argNodes[mismatchIndex] : (mismatch ?? node),
          'error',
          constraint ??
            `Type mismatch: argument of type '${mismatchValue ? valueDescription(mismatchValue, ctx) : 'unknown'}' is not assignable to parameter of type '${mismatchSchema ? schemaDescription(mismatchSchema, mismatchSchema, ctx.runtime) : 'unknown'}'.`,
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
  const localBinding = env.get(name);
  if (localBinding) {
    return localBinding;
  }
  const schema = ctx.runtime.globals?.[name];
  if (schema !== undefined) {
    return { schema, runtime: true };
  }
  if (ctx.runtime.functions?.[name]) {
    return callableValue({ ...ctx.runtime.functions[name], isLocal: false });
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

function resolveMethod(
  receiver: Value,
  name: string,
  ctx: SemanticContext
): Callable | null {
  const types = getSchemaTypes(
    receiver.schema,
    schemaRoot(receiver),
    ctx.runtime
  );
  const ordered: OpelMethodReceiver[] = [];
  for (const type of types) {
    if (type === 'integer') {
      ordered.push('integer', 'number');
    } else if (RECEIVERS.includes(type as OpelMethodReceiver)) {
      ordered.push(type as OpelMethodReceiver);
    }
  }
  for (const type of ordered) {
    const callable = ctx.runtime.methods?.[type]?.[name];
    if (callable) {
      return { ...callable, isLocal: false };
    }
  }
  return null;
}

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
  for (const variant of resolveSchemaVariants(
    receiver.schema,
    receiverRoot,
    ctx.runtime
  )) {
    if (variant === true) {
      continue;
    }
    const object = schemaObject(variant);
    if (!object) {
      unsupported++;
      continue;
    }
    const properties = isRecord(object.properties) ? object.properties : {};
    if (name in properties) {
      const schema = properties[name] as OpelSchema;
      const callable = schemaObject(schema)?.callable as Callable | undefined;
      supports.push({
        schema,
        root: receiverRoot,
        ...(callable ? { callable } : {}),
      });
      addDeprecation(
        ctx,
        node,
        schemaObject(schema)?.deprecated as boolean | string | undefined
      );
      continue;
    }
    const pattern =
      isRecord(object.patternProperties) &&
      Object.entries(object.patternProperties).find(([pattern]) => {
        try {
          return new RegExp(pattern).test(name);
        } catch {
          return false;
        }
      });
    if (pattern) {
      supports.push({ schema: pattern[1] as OpelSchema, root: receiverRoot });
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
        supports.push({ schema: true, root: receiverRoot });
      } else {
        if (object.additionalProperties === undefined) {
          unsupported++;
        }
        supports.push({
          schema:
            object.additionalProperties && object.additionalProperties !== true
              ? (object.additionalProperties as OpelSchema)
              : true,
          root: receiverRoot,
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
    schema: createUnionSchema(supports.map((value) => value.schema)),
    root: receiverRoot,
    ...(callable ? { callable } : {}),
  };
}
