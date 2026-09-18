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

const SCHEMA_ROOTS = new WeakMap<object, OpelSchema>();
const SCHEMA_BRANCH_ROOTS = new WeakMap<object, OpelSchema[]>();

/**
 * Returns the schema document used to resolve local references for a value.
 * Derived values keep their originating root; primitive or synthetic values use their own schema.
 * Why: This prevents a property or method access from losing the definitions document that introduced it.
 */
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

/**
 * Runs semantic analysis for each top-level OPEL body and returns document diagnostics.
 * It creates one analysis context, then delegates scope traversal and expression inference to the helpers below.
 * Why: A shared context lets nested helpers report consistent diagnostics and de-duplicate warnings during one analysis pass.
 */
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

/**
 * Analyzes declarations in source order and then analyzes the body's final expression.
 * Each initializer is inferred before its binding is added to the lexical environment.
 * Why: Analyzing initializers before binding them preserves OPEL declaration-order visibility rules.
 */
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

/**
 * Recursively analyzes a syntax node and returns its inferred value, schema, and optional literal.
 * The traversal handles calls, lambdas, postfix access, operators, literals, and nested expressions while emitting semantic diagnostics.
 * Why: Returning a compact Value lets later access, call, and operator checks reuse the same inferred information instead of re-walking syntax.
 */
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

/**
 * Validates every adjacent operand pair against the operator between them.
 * Unknown and impossible schemas are skipped; known invalid pairs receive a diagnostic at the operator.
 * Why: Checking operators statically gives authors the same feedback as the runtime without attempting to evaluate the expression.
 */
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

/**
 * Reports whether two primitive types may be combined by one arithmetic operator.
 * Addition accepts either two numeric values or two strings; the other operators accept numeric values only.
 * Why: Keeping the operator matrix in one helper prevents arithmetic rules from diverging across expression forms.
 */
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

/**
 * Appends a CodeMirror diagnostic using the node range unless an explicit range is supplied.
 * Keeping this operation centralized makes severity and range handling consistent.
 * Why: Centralizing diagnostic creation keeps ranges and severity consistent across the many semantic checks.
 */
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

/**
 * Identifies plain object-like values used by the runtime schema model.
 * Arrays are excluded because schema maps and schema objects are keyed records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Converts a boolean-or-object schema into its object representation when possible.
 * Boolean schemas remain handled explicitly by callers as allow-all or impossible schemas.
 */
function schemaObject(value: OpelSchema): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Records the document root associated with a derived schema object.
 * Boolean schemas have no object identity, so their caller-provided fallback root remains authoritative.
 * Why: Composition can combine children from different external documents; the association keeps each child reference resolvable later.
 */
function rememberSchemaRoot(schema: OpelSchema, root: OpelSchema): void {
  if (isRecord(schema)) {
    SCHEMA_ROOTS.set(schema, root);
  }
}

/**
 * Gets a schema's recorded document root, falling back to the root supplied by the current traversal.
 */
function schemaRootFor(schema: OpelSchema, fallback: OpelSchema): OpelSchema {
  return isRecord(schema) ? (SCHEMA_ROOTS.get(schema) ?? fallback) : fallback;
}

/**
 * Builds the compact union representation used for inferred values.
 * Nested `oneOf` branches are flattened, unknown branches are discarded, and singleton roots are preserved.
 * Why: A normalized union keeps downstream schema traversal small and prevents nested inferred unions from obscuring available members.
 */
function createUnionSchema(
  schemas: OpelSchema[],
  roots: OpelSchema[] = []
): OpelSchema {
  const flattened: OpelSchema[] = [];
  const flattenedRoots: OpelSchema[] = [];
  for (const [index, schema] of schemas.entries()) {
    const fallbackRoot = roots[index] ?? schema;
    const object = schemaObject(schema);
    const branchRoots = object ? SCHEMA_BRANCH_ROOTS.get(object) : undefined;
    if (object && Array.isArray(object.oneOf)) {
      for (const [branchIndex, branch] of object.oneOf.entries()) {
        flattened.push(branch as OpelSchema);
        flattenedRoots.push(
          branchRoots?.[branchIndex] ??
            schemaRootFor(branch as OpelSchema, fallbackRoot)
        );
      }
    } else if (schema !== true) {
      flattened.push(schema);
      flattenedRoots.push(schemaRootFor(schema, fallbackRoot));
    }
  }
  if (flattened.length === 0) {
    return true;
  }
  if (flattened.length === 1) {
    rememberSchemaRoot(flattened[0], flattenedRoots[0]);
    return flattened[0];
  }
  const union = { oneOf: flattened };
  SCHEMA_BRANCH_ROOTS.set(union, flattenedRoots);
  rememberSchemaRoot(union, flattenedRoots[0]);
  return union;
}

/**
 * Decodes one JSON Pointer path segment using the standard `~1` and `~0` escapes.
 * Semantic reference lookup uses this before indexing definitions or `$defs`.
 */
function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

type SchemaResolution = {
  schema: OpelSchema;
  root: OpelSchema;
};

/**
 * Resolves one local or exact external schema reference without eagerly expanding the whole graph.
 * The active-reference set terminates recursive schemas, and external schemas become the root for their own local references.
 * Why: Lazy, cycle-safe resolution avoids expanding recursive runtime schemas and keeps local references tied to the correct document root.
 */
function resolveSchemaReference(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime,
  seen = new Set<string>()
): SchemaResolution {
  const effectiveRoot = schemaRootFor(schema, root);
  const object = schemaObject(schema);
  if (!object || typeof object.$ref !== 'string' || seen.has(object.$ref)) {
    return { schema, root: effectiveRoot };
  }
  const ref = object.$ref;
  seen.add(ref);
  if (ref.startsWith('#/')) {
    const [section, name] = ref.slice(2).split('/').map(decodePointerSegment);
    const rootObject = schemaObject(effectiveRoot);
    const definitions = rootObject?.[section];
    if (isRecord(definitions) && name in definitions) {
      const target = definitions[name] as OpelSchema;
      rememberSchemaRoot(target, effectiveRoot);
      return resolveSchemaReference(target, effectiveRoot, runtime, seen);
    }
    return { schema: false, root: effectiveRoot };
  }
  const external = runtime.schemas?.[ref];
  if (external === undefined) {
    return { schema: false, root: effectiveRoot };
  }
  rememberSchemaRoot(external, external);
  return resolveSchemaReference(external, external, runtime, seen);
}

/**
 * Intersects primitive type sets while treating integer as a subtype of number.
 * An empty result means the constraints cannot describe any value of a known type.
 * Why: The intersection is needed to reject impossible `allOf` combinations while preserving the valid number/integer relationship.
 */
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

/**
 * Combines multiple schemas assigned to the same structural slot, such as a property or array item.
 * Each input is expanded into alternatives first so the result preserves valid union branches and their reference roots.
 */
function combineSchemaValues(
  values: OpelSchema[],
  root: OpelSchema,
  runtime: OpelRuntime
): OpelSchema {
  const variants = values.map((value) =>
    resolveSchemaVariants(value, schemaRootFor(value, root), runtime)
  );
  const combined = intersectSchemaAlternatives(variants, root, runtime);
  const result =
    combined.length === 1
      ? combined[0].schema
      : createUnionSchema(
          combined.map((item) => item.schema),
          combined.map((item) => item.root)
        );
  rememberSchemaRoot(result, combined[0]?.root ?? root);
  return result;
}

/**
 * Merges one concrete all-of combination into a single schema.
 * It intersects types and literals, unions required properties, and applies each branch's property, pattern, and additional-property rules before exposing merged members.
 * Why: Flattening branch properties without their own object constraints can make an otherwise forbidden property appear valid.
 */
function mergeSchemaConstraints(
  schemas: OpelSchema[],
  root: OpelSchema,
  runtime: OpelRuntime
): OpelSchema {
  if (schemas.includes(false)) {
    return false;
  }
  const constrained = schemas.filter((schema) => schema !== true);
  if (constrained.length === 0) {
    return true;
  }

  const typeSets = constrained.map((schema) =>
    getSchemaTypes(schema, root, runtime)
  );
  if (typeSets.some((types) => types.includes('never'))) {
    return false;
  }
  const knownTypeSets = typeSets.filter((types) => types.length > 0);
  const intersection = intersectSchemaTypes(knownTypeSets);
  if (knownTypeSets.length > 1 && intersection.length === 0) {
    return false;
  }

  const merged: Record<string, unknown> = {};
  const nonNullTypes = intersection.filter((type) => type !== 'null');
  if (nonNullTypes.length > 0) {
    merged.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes;
    if (intersection.includes('null')) {
      merged.nullable = true;
    }
  } else if (intersection.includes('null')) {
    merged.type = 'null';
  }

  const structuralSchemas = constrained
    .map((schema) => ({
      object: schemaObject(schema),
      root: schemaRootFor(schema, root),
    }))
    .filter(
      (entry): entry is { object: Record<string, unknown>; root: OpelSchema } =>
        entry.object !== null
    );
  const properties: Record<string, OpelSchema> = {};
  const required = new Set<string>();
  const patterns: Record<string, OpelSchema> = {};
  let hasAdditionalProperties = false;
  let additionalProperties: boolean | OpelSchema = true;
  const itemSchemas: OpelSchema[] = [];

  for (const { object } of structuralSchemas) {
    if (Array.isArray(object.required)) {
      for (const name of object.required) {
        if (typeof name === 'string') {
          required.add(name);
        }
      }
    }
  }

  const propertySources = structuralSchemas.filter(
    ({ object }) =>
      isRecord(object.properties) || isRecord(object.patternProperties)
  );
  const propertyNames = new Set<string>();
  for (const { object } of propertySources) {
    if (isRecord(object.properties)) {
      Object.keys(object.properties).forEach((name) => propertyNames.add(name));
    }
  }
  for (const name of propertyNames) {
    const constraints: OpelSchema[] = [];
    let forbidden = false;
    for (const { object, root: branchRoot } of propertySources) {
      const explicit = isRecord(object.properties)
        ? object.properties[name]
        : undefined;
      const patterns = matchingPatternProperties(object, name);
      if (explicit !== undefined) {
        const child = explicit as OpelSchema;
        rememberSchemaRoot(child, schemaRootFor(child, branchRoot));
        constraints.push(child);
      } else if (patterns.length > 0) {
        for (const pattern of patterns) {
          rememberSchemaRoot(pattern, schemaRootFor(pattern, branchRoot));
          constraints.push(pattern);
        }
      } else if (object.additionalProperties === false) {
        forbidden = true;
        break;
      } else if (
        object.additionalProperties &&
        object.additionalProperties !== true
      ) {
        const extra = object.additionalProperties as OpelSchema;
        rememberSchemaRoot(extra, schemaRootFor(extra, branchRoot));
        constraints.push(extra);
      }
    }
    if (!forbidden && constraints.length > 0) {
      const combined = combineSchemaValues(constraints, root, runtime);
      if (combined !== false) {
        properties[name] = combined;
      }
    }
  }

  for (const { object, root: structuralRoot } of structuralSchemas) {
    if ('items' in object && object.items !== undefined) {
      const items = object.items as OpelSchema;
      rememberSchemaRoot(items, structuralRoot);
      itemSchemas.push(items);
    }
    if (isRecord(object.patternProperties)) {
      for (const [pattern, value] of Object.entries(object.patternProperties)) {
        const child = value as OpelSchema;
        const childRoot = schemaRootFor(child, structuralRoot);
        rememberSchemaRoot(child, childRoot);
        patterns[pattern] = patterns[pattern]
          ? combineSchemaValues([patterns[pattern], child], root, runtime)
          : child;
      }
    }
    if ('additionalProperties' in object) {
      hasAdditionalProperties = true;
      const value = object.additionalProperties;
      if (value === false) {
        additionalProperties = false;
      } else if (value && value !== true && additionalProperties !== false) {
        rememberSchemaRoot(value as OpelSchema, structuralRoot);
        additionalProperties =
          additionalProperties === true
            ? (value as OpelSchema)
            : combineSchemaValues(
                [additionalProperties as OpelSchema, value as OpelSchema],
                root,
                runtime
              );
      }
    }
  }

  if (required.size > 0) {
    merged.required = [...required];
  }
  if (Object.keys(properties).length > 0) {
    merged.properties = properties;
  }
  if (Object.keys(patterns).length > 0) {
    merged.patternProperties = patterns;
  }
  if (hasAdditionalProperties) {
    merged.additionalProperties = additionalProperties;
  }
  if (itemSchemas.length > 0) {
    merged.items = combineSchemaValues(itemSchemas, root, runtime);
  }
  if (
    (required.size > 0 ||
      Object.keys(properties).length > 0 ||
      Object.keys(patterns).length > 0 ||
      hasAdditionalProperties) &&
    !merged.type
  ) {
    merged.type = 'object';
  }
  if (itemSchemas.length > 0 && !merged.type) {
    merged.type = 'array';
  }

  const constValues = constrained
    .map((schema) => schemaObject(schema)?.const)
    .filter((value) => value !== undefined);
  if (
    constValues.length > 1 &&
    !constValues.every((value) => literalEqual(value, constValues[0]))
  ) {
    return false;
  }
  if (constValues.length > 0) {
    merged.const = constValues[0];
  }

  const enumValues = constrained
    .map((schema) => schemaObject(schema)?.enum)
    .filter((value): value is unknown[] => Array.isArray(value));
  if (enumValues.length > 0) {
    let allowed = [...enumValues[0]];
    for (const values of enumValues.slice(1)) {
      allowed = allowed.filter((value) =>
        values.some((candidate) => literalEqual(candidate, value))
      );
    }
    if (constValues.length > 0) {
      allowed = allowed.filter((value) => literalEqual(value, constValues[0]));
    }
    if (allowed.length === 0) {
      return false;
    }
    if (knownTypeSets.length > 0) {
      allowed = allowed.filter((value) =>
        intersection.some(
          (type) =>
            type === valueType(value) ||
            (type === 'number' && valueType(value) === 'integer')
        )
      );
    }
    if (allowed.length === 0) {
      return false;
    }
    if (constValues.length === 0) {
      merged.enum = allowed;
    }
  }

  return merged;
}

/**
 * Computes the Cartesian product of branch alternatives and intersects each combination.
 * Impossible combinations are removed when at least one valid combination remains.
 */
function intersectSchemaAlternatives(
  alternatives: SchemaResolution[][],
  root: OpelSchema,
  runtime: OpelRuntime
): SchemaResolution[] {
  let combinations: SchemaResolution[][] = [[]];
  for (const variants of alternatives) {
    combinations = combinations.flatMap((combination) =>
      variants.map((variant) => [...combination, variant])
    );
  }
  const merged = combinations.map((combination) => {
    const effectiveRoot =
      combination.find((item) => item.schema !== true)?.root ?? root;
    combination.forEach((item) => rememberSchemaRoot(item.schema, item.root));
    const schema = mergeSchemaConstraints(
      combination.map((item) => item.schema),
      effectiveRoot,
      runtime
    );
    rememberSchemaRoot(schema, effectiveRoot);
    return { schema, root: effectiveRoot };
  });
  const possible = merged.filter((item) => item.schema !== false);
  return possible.length > 0 ? possible : [{ schema: false, root }];
}

/**
 * Resolves references and expands schema composition into the variants semantic analysis can inspect.
 * `oneOf` and `anyOf` remain unions; `allOf` is combined branch-by-branch with structural constraints merged.
 * Why: Downstream analysis needs explicit alternatives to distinguish valid union members from contradictory intersections.
 */
function resolveSchemaVariants(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): SchemaResolution[] {
  const resolved = resolveSchemaReference(schema, root, runtime);
  const object = schemaObject(resolved.schema);
  if (!object || resolved.schema === true || resolved.schema === false) {
    return [resolved];
  }
  if (Array.isArray(object.oneOf)) {
    const branchRoots = SCHEMA_BRANCH_ROOTS.get(object);
    return object.oneOf.flatMap((child, index) =>
      resolveSchemaVariants(
        child as OpelSchema,
        branchRoots?.[index] ?? resolved.root,
        runtime
      )
    );
  }
  if (Array.isArray(object.anyOf)) {
    const branchRoots = SCHEMA_BRANCH_ROOTS.get(object);
    return object.anyOf.flatMap((child, index) =>
      resolveSchemaVariants(
        child as OpelSchema,
        branchRoots?.[index] ?? resolved.root,
        runtime
      )
    );
  }
  if (Array.isArray(object.allOf)) {
    const branches = object.allOf.map((child) =>
      resolveSchemaVariants(child as OpelSchema, resolved.root, runtime)
    );
    const ownConstraints = { ...object };
    delete ownConstraints.allOf;
    if (Object.keys(ownConstraints).length > 0) {
      branches.push([
        { schema: ownConstraints as OpelSchema, root: resolved.root },
      ]);
    }
    return intersectSchemaAlternatives(branches, resolved.root, runtime);
  }
  return [resolved];
}

/**
 * Extracts the statically known primitive types represented by a schema.
 * An empty result means the schema is unknown or unconstrained, while `never` marks an impossible schema.
 * Why: The empty set deliberately means unknown rather than impossible, so incomplete or unconstrained metadata does not create false positives.
 */
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
  for (const resolution of resolveSchemaVariants(schema, root, runtime)) {
    const variant = resolution.schema;
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
      variant.required ||
      variant.additionalProperties !== undefined ||
      variant.patternProperties
    ) {
      types.add('object');
    } else if (variant.items !== undefined) {
      types.add('array');
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

/**
 * Maps a runtime literal to the OPEL primitive vocabulary.
 * Integer numbers are kept distinct from other numbers because overloads and arithmetic use that distinction.
 */
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

/**
 * Formats a literal for schema descriptions and diagnostics.
 * Strings use JSON quoting; other values use their normal string representation.
 */
function quoted(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Produces a readable type-like description of a schema for diagnostics displayed to users.
 * It resolves composition, recursively describes properties and items, and stops safely on recursive schemas.
 * Why: Diagnostics need readable types rather than raw schema objects, especially when users must understand why an expression is rejected.
 */
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

/**
 * Describes an inferred value using its literal type when available, otherwise its schema description.
 * Objects and arrays use their schema so their structure is not lost in diagnostics.
 */
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

/**
 * Collects property names exposed by all resolvable schema variants.
 * The names are used to make unknown and partial-union property diagnostics actionable.
 * Why: Listing known members turns an unknown-property error into an actionable diagnostic without changing semantic validity.
 */
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

/**
 * Collects methods registered for every possible receiver type.
 * Integer receivers also inherit methods configured for numbers.
 * Why: Including inherited number methods makes suggestions match the actual receiver dispatch rules for integers.
 */
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

/**
 * Formats a list of candidate names for a diagnostic message.
 * Empty lists are rendered as `none` instead of an empty string.
 */
function formatNames(names: string[]): string {
  return names.length > 0
    ? names.map((name) => `"${name}"`).join(', ')
    : 'none';
}

/**
 * Returns whether two pattern domains have a statically plausible overlap.
 * Exact and simple anchored-prefix cases are decided directly; other valid patterns are treated as potentially overlapping.
 * Why: Regular-expression intersection is undecidable in general, so compatibility stays conservative for unfamiliar patterns.
 */
function patternsMayOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftPrefix = left.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  const rightPrefix = right.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  if (
    leftPrefix &&
    rightPrefix &&
    !leftPrefix.startsWith(rightPrefix) &&
    !rightPrefix.startsWith(leftPrefix)
  ) {
    return false;
  }
  try {
    new RegExp(left);
    new RegExp(right);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns whether the target pattern is known to cover the whole source pattern domain.
 * The check intentionally handles only exact patterns, universal patterns, and anchored literal prefixes.
 */
function patternCovers(source: string, target: string): boolean {
  if (source === target || target === '.*' || target === '^.*$') {
    return true;
  }
  const sourcePrefix = source.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  const targetPrefix = target.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  return (
    !!sourcePrefix && !!targetPrefix && sourcePrefix.startsWith(targetPrefix)
  );
}

/**
 * Finds every pattern-property schema whose regular expression matches a property name.
 * Invalid patterns are ignored here because runtime validation reports them before semantic analysis runs.
 */
function matchingPatternProperties(
  schema: Record<string, unknown>,
  name: string
): OpelSchema[] {
  if (!isRecord(schema.patternProperties)) {
    return [];
  }
  return Object.entries(schema.patternProperties).flatMap(
    ([pattern, value]) => {
      try {
        return new RegExp(pattern).test(name) ? [value as OpelSchema] : [];
      } catch {
        // Invalid patterns are handled by runtime validation.
        return [];
      }
    }
  );
}

/**
 * Checks whether at least one resolved schema variant accepts a primitive type.
 * Integer values may satisfy number schemas, and nullable schemas accept null.
 * Why: This is the shared primitive gate used before deeper constraint checks, including OPEL’s integer-to-number compatibility.
 */
function schemaAllowsType(
  schema: OpelSchema,
  type: string,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (schema === true) {
    return true;
  }
  return resolveSchemaVariants(schema, root, runtime).some((resolution) => {
    const variant = resolution.schema;
    if (variant === true) {
      return true;
    }
    if (variant === false) {
      return false;
    }
    const types = getSchemaTypes(variant, resolution.root, runtime);
    return (
      types.length === 0 ||
      types.includes(type) ||
      (type === 'integer' && types.includes('number')) ||
      (type === 'null' && variant.nullable === true)
    );
  });
}

/**
 * Compares schema literals structurally using their JSON representation.
 * This is sufficient for the JSON-like values supported by runtime metadata.
 */
function literalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type SchemaPair = readonly [OpelSchema, OpelSchema];

/**
 * Checks whether every known value described by a source schema is accepted by a target schema.
 * It compares union alternatives independently and tracks visited schema pairs to terminate recursive graphs.
 * Why: Non-literal values still carry useful schema knowledge, so rejecting incompatible schemas prevents type errors from being hidden just because no literal is present.
 */
function isSchemaCompatible(
  sourceSchema: OpelSchema,
  targetSchema: OpelSchema,
  sourceRoot: OpelSchema,
  targetRoot: OpelSchema,
  runtime: OpelRuntime,
  seen: SchemaPair[] = []
): boolean {
  if (sourceSchema === true || targetSchema === true) {
    return true;
  }
  if (sourceSchema === false || targetSchema === false) {
    return false;
  }
  if (
    seen.some(
      ([source, target]) => source === sourceSchema && target === targetSchema
    )
  ) {
    return true;
  }

  const sourceVariants = resolveSchemaVariants(
    sourceSchema,
    sourceRoot,
    runtime
  );
  const targetVariants = resolveSchemaVariants(
    targetSchema,
    targetRoot,
    runtime
  );
  const nextSeen = [...seen, [sourceSchema, targetSchema] as const];
  return sourceVariants.every((sourceVariant) =>
    targetVariants.some((targetVariant) =>
      isSchemaVariantCompatible(
        sourceVariant.schema,
        targetVariant.schema,
        sourceVariant.root,
        targetVariant.root,
        runtime,
        nextSeen
      )
    )
  );
}

/**
 * Compares one resolved source variant with one resolved target variant.
 * Besides primitive types, it checks constants, enums, object properties, required fields, pattern domains, additional properties, and array items.
 * Why: Comparing known structural constraints catches errors that primitive type comparison alone cannot see.
 */
function isSchemaVariantCompatible(
  sourceSchema: OpelSchema,
  targetSchema: OpelSchema,
  sourceRoot: OpelSchema,
  targetRoot: OpelSchema,
  runtime: OpelRuntime,
  seen: SchemaPair[]
): boolean {
  if (sourceSchema === true || targetSchema === true) {
    return true;
  }
  if (sourceSchema === false || targetSchema === false) {
    return false;
  }

  const sourceTypes = getSchemaTypes(sourceSchema, sourceRoot, runtime).filter(
    (type) => type !== 'never'
  );
  const targetTypes = getSchemaTypes(targetSchema, targetRoot, runtime).filter(
    (type) => type !== 'never'
  );
  if (
    sourceTypes.length > 0 &&
    targetTypes.length > 0 &&
    !sourceTypes.every(
      (type) =>
        targetTypes.includes(type) ||
        (type === 'integer' && targetTypes.includes('number'))
    )
  ) {
    return false;
  }

  const sourceObject = schemaObject(sourceSchema);
  const targetObject = schemaObject(targetSchema);
  if (!sourceObject || !targetObject) {
    return true;
  }

  if (
    (targetObject.const !== undefined || Array.isArray(targetObject.enum)) &&
    sourceObject.const === undefined &&
    !Array.isArray(sourceObject.enum)
  ) {
    return sourceTypes.length === 0;
  }

  if (sourceObject.const !== undefined) {
    return isValueCompatibleWithSchema(
      {
        schema: { type: valueType(sourceObject.const) as OpelPrimitive },
        literal: sourceObject.const,
      },
      targetSchema,
      targetRoot,
      runtime
    );
  }
  if (Array.isArray(sourceObject.enum)) {
    return sourceObject.enum.every((value) =>
      isValueCompatibleWithSchema(
        { schema: { type: valueType(value) as OpelPrimitive }, literal: value },
        targetSchema,
        targetRoot,
        runtime
      )
    );
  }

  const sourceProperties = isRecord(sourceObject.properties)
    ? sourceObject.properties
    : {};
  const targetProperties = isRecord(targetObject.properties)
    ? targetObject.properties
    : {};
  const sourceRequired = new Set(
    Array.isArray(sourceObject.required)
      ? sourceObject.required.filter(
          (name): name is string => typeof name === 'string'
        )
      : []
  );
  const targetRequired = Array.isArray(targetObject.required)
    ? targetObject.required.filter(
        (name): name is string => typeof name === 'string'
      )
    : [];

  for (const name of targetRequired) {
    if (!sourceRequired.has(name)) {
      return false;
    }
  }
  for (const [name, sourceProperty] of Object.entries(sourceProperties)) {
    const targetPropertiesForName = [
      ...(name in targetProperties
        ? [targetProperties[name] as OpelSchema]
        : []),
      ...matchingPatternProperties(targetObject, name),
    ];
    if (targetPropertiesForName.length > 0) {
      if (
        !targetPropertiesForName.every((targetProperty) =>
          isSchemaCompatible(
            sourceProperty as OpelSchema,
            targetProperty,
            schemaRootFor(sourceProperty as OpelSchema, sourceRoot),
            targetRoot,
            runtime,
            seen
          )
        )
      ) {
        return false;
      }
    } else if (targetObject.additionalProperties === false) {
      return false;
    } else if (
      targetObject.additionalProperties &&
      targetObject.additionalProperties !== true &&
      !isSchemaCompatible(
        sourceProperty as OpelSchema,
        targetObject.additionalProperties as OpelSchema,
        sourceRoot,
        targetRoot,
        runtime,
        seen
      )
    ) {
      return false;
    }
  }

  const sourcePatterns = isRecord(sourceObject.patternProperties)
    ? Object.entries(sourceObject.patternProperties)
    : [];
  const targetPatterns = isRecord(targetObject.patternProperties)
    ? Object.entries(targetObject.patternProperties)
    : [];
  for (const [sourcePattern, sourcePatternSchema] of sourcePatterns) {
    const overlappingTargets = targetPatterns.filter(([targetPattern]) =>
      patternsMayOverlap(sourcePattern, targetPattern)
    );
    for (const [, targetPatternSchema] of overlappingTargets) {
      if (
        !isSchemaCompatible(
          sourcePatternSchema as OpelSchema,
          targetPatternSchema as OpelSchema,
          schemaRootFor(sourcePatternSchema as OpelSchema, sourceRoot),
          targetRoot,
          runtime,
          seen
        )
      ) {
        return false;
      }
    }
    const coveredByTargetPattern = overlappingTargets.some(([targetPattern]) =>
      patternCovers(sourcePattern, targetPattern)
    );
    if (
      !coveredByTargetPattern &&
      targetObject.additionalProperties === false
    ) {
      return false;
    }
    if (
      !coveredByTargetPattern &&
      targetObject.additionalProperties &&
      targetObject.additionalProperties !== true &&
      !isSchemaCompatible(
        sourcePatternSchema as OpelSchema,
        targetObject.additionalProperties as OpelSchema,
        schemaRootFor(sourcePatternSchema as OpelSchema, sourceRoot),
        targetRoot,
        runtime,
        seen
      )
    ) {
      return false;
    }
  }

  if (
    targetObject.additionalProperties === false &&
    sourceObject.additionalProperties !== false
  ) {
    return false;
  }
  if (
    targetObject.additionalProperties &&
    targetObject.additionalProperties !== true &&
    (sourceObject.additionalProperties === undefined ||
      sourceObject.additionalProperties === true)
  ) {
    return false;
  }

  if (
    targetObject.additionalProperties &&
    targetObject.additionalProperties !== true &&
    sourceObject.additionalProperties &&
    sourceObject.additionalProperties !== true &&
    !isSchemaCompatible(
      sourceObject.additionalProperties as OpelSchema,
      targetObject.additionalProperties as OpelSchema,
      sourceRoot,
      targetRoot,
      runtime,
      seen
    )
  ) {
    return false;
  }

  const sourceItems = sourceObject.items as OpelSchema | undefined;
  const targetItems = targetObject.items as OpelSchema | undefined;
  return !sourceItems || !targetItems
    ? true
    : isSchemaCompatible(
        sourceItems,
        targetItems,
        sourceRoot,
        targetRoot,
        runtime,
        seen
      );
}

/**
 * Adapts schema-to-schema compatibility to the non-literal argument path.
 * Literal-only checks are intentionally handled by `isValueCompatibleWithSchema` instead.
 */
function isInferredSchemaCompatible(
  sourceSchema: OpelSchema,
  targetSchema: OpelSchema,
  sourceRoot: OpelSchema,
  targetRoot: OpelSchema,
  runtime: OpelRuntime
): boolean {
  return isSchemaCompatible(
    sourceSchema,
    targetSchema,
    sourceRoot,
    targetRoot,
    runtime
  );
}

/**
 * Determines whether an inferred argument can satisfy a parameter schema.
 * Concrete literals get exact const, enum, object, and item checks; non-literals use recursive schema compatibility.
 * Why: Literal and non-literal values need different checks: literals can prove exact constraints, while schemas can only prove compatibility.
 */
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
  for (const resolution of resolveSchemaVariants(schema, root, runtime)) {
    const variant = resolution.schema;
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
    if (!schemaAllowsType(variant, type, resolution.root, runtime)) {
      continue;
    }
    if (
      type === 'object' &&
      !isObjectCompatibleWithSchema(value, variant, resolution.root, runtime)
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
          resolution.root,
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

/**
 * Checks a known object literal against required properties, declared property schemas, and closed-object rules.
 * Unknown object values are left permissive because their runtime members are not statically available.
 * Why: The permissive fallback avoids claiming an unknown object is invalid while still enforcing constraints on object literals whose members are known.
 */
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
    const propertySchemas = [
      ...(name in properties ? [properties[name] as OpelSchema] : []),
      ...matchingPatternProperties(schema, name),
    ];
    if (
      !propertySchemas.every((propertySchema) =>
        isValueCompatibleWithSchema(
          { schema: child as OpelSchema, literal: child },
          propertySchema,
          root,
          runtime
        )
      )
    ) {
      return false;
    }
    if (propertySchemas.length === 0 && schema.additionalProperties === false) {
      return false;
    }
    if (
      propertySchemas.length === 0 &&
      schema.additionalProperties &&
      schema.additionalProperties !== true &&
      !isValueCompatibleWithSchema(
        { schema: child as OpelSchema, literal: child },
        schema.additionalProperties as OpelSchema,
        root,
        runtime
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Parses literal syntax nodes into JavaScript values used by semantic checks.
 * It handles strings, numbers, and the OPEL boolean and null literals.
 */
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

/**
 * Returns all direct children that represent expression nodes in the grammar.
 * Keeping the node-name set here avoids repeating the grammar traversal list.
 */
function expressionChildren(node: SyntaxNode): SyntaxNode[] {
  return [...EXPRESSION_NODES].flatMap((name) => node.getChildren(name));
}

/**
 * Emits a deprecation warning once for a particular source range and message.
 * The set prevents repeated warnings when the same member is inspected by multiple semantic passes.
 * Why: Member resolution can encounter the same deprecated declaration through multiple paths, but authors should see one warning per use.
 */
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

/**
 * Wraps a callable in the generic inferred-value shape.
 * Callables start with an unknown schema because invoking them is what determines their return schema.
 */
function callableValue(callable: Callable): Value {
  return { schema: true, callable };
}

/**
 * Builds a focused diagnostic for known object-literal constraint failures.
 * It reports the first missing required property or the first extra property on a closed object.
 */
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

/**
 * Summarizes the accepted argument counts across callable signatures.
 * Required and optional trailing parameters become a compact range for arity diagnostics.
 */
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

/**
 * Filters callable signatures by arity and recursive argument-schema compatibility, then infers the return value.
 * Complete calls report mismatch or ambiguity diagnostics; incomplete calls remain permissive while the user is typing.
 * Why: Filtering signatures before selecting a return schema prevents invalid overloads from contaminating inference and diagnostics.
 */
function analyzeCall(
  callable: Callable,
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
        const mismatch = argNodes.find(
          (arg, index) =>
            !isValueCompatibleWithSchema(
              args[index],
              arityCompatible[0].parameters[index].schema,
              arityCompatible[0].parameters[index].schema,
              ctx.runtime
            )
        );
        const mismatchIndex = argNodes.findIndex(
          (arg, index) =>
            !isValueCompatibleWithSchema(
              args[index],
              arityCompatible[0].parameters[index].schema,
              arityCompatible[0].parameters[index].schema,
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

/**
 * Creates an unknown-symbol diagnostic and optionally suggests nearby local or runtime names.
 * Candidate names are collected from the current environment and configured runtime entries.
 */
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

/**
 * Resolves an identifier in lexical scope before checking runtime globals and functions.
 * Unresolved names produce one semantic diagnostic unless declaration-order analysis already owns that source position.
 * Why: Local-first lookup preserves shadowing and prevents a runtime global or function from masking an editor declaration.
 */
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
    return { schema, root: schema, runtime: true };
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

/**
 * Finds a method by the receiver's possible primitive types in receiver precedence order.
 * Integer receivers try integer methods first and then inherit number methods.
 * Why: The ordered lookup mirrors runtime dispatch, including the intentional integer-to-number method inheritance.
 */
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

/**
 * Resolves a property across all receiver schema variants while preserving the reference root.
 * It combines direct, pattern, and additional properties and reports absent or partial union members.
 * Why: Analyzing every variant is necessary to distinguish a property that is absent from one union member from one absent everywhere.
 */
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
      const callable = schemaObject(schema)?.callable as Callable | undefined;
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
