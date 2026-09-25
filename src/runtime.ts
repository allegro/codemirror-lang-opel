import { PRIMITIVE_METHOD_RECEIVERS } from './method-receivers';
import type {
  OpelMethodReceiver,
  OpelPrimitiveMethodReceiver,
  OpelRuntime,
  OpelRuntimeIssue,
  OpelSchema,
} from './types';

const EMPTY_RUNTIME: OpelRuntime = Object.freeze({});

export interface RuntimeContext {
  readonly runtime: OpelRuntime;
}

const PRESENTATION_KEYS = new Set(['title', 'description']);
const ISSUE_CODES = new Set([
  'invalid-runtime-entry',
  'duplicate-symbol',
  'invalid-schema',
  'unresolved-reference',
  'invalid-pattern',
  'invalid-signature',
  'invalid-metadata',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
  }
  return value;
}

function pointerSegment(value: string | number): string {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function issue(
  code: OpelRuntimeIssue['code'],
  path: string,
  message: string,
  severity: OpelRuntimeIssue['severity'] = 'error'
): OpelRuntimeIssue {
  return { code, path, message, severity };
}

function addMetadataIssues(
  value: Record<string, unknown>,
  path: string,
  issues: OpelRuntimeIssue[]
) {
  for (const key of PRESENTATION_KEYS) {
    if (key in value && typeof value[key] !== 'string') {
      issues.push(
        issue(
          'invalid-metadata',
          `${path}/${key}`,
          `${key} must be a string`,
          'warning'
        )
      );
      delete value[key];
    }
  }
  if (
    'deprecated' in value &&
    typeof value.deprecated !== 'boolean' &&
    typeof value.deprecated !== 'string'
  ) {
    issues.push(
      issue(
        'invalid-metadata',
        `${path}/deprecated`,
        'deprecated must be a boolean or string',
        'warning'
      )
    );
    delete value.deprecated;
  }
}

function validateSchema(
  schema: unknown,
  path: string,
  root: Record<string, unknown>,
  schemas: Record<string, unknown>,
  issues: OpelRuntimeIssue[],
  active = new Set<unknown>()
): void {
  if (schema === true) {
    return;
  }
  if (schema === false) {
    return;
  }
  if (!isRecord(schema)) {
    issues.push(
      issue('invalid-schema', path, 'schema must be a boolean or object')
    );
    return;
  }
  // A schema graph may be recursive; active nodes stop validation without imposing a depth limit.
  if (active.has(schema)) {
    return;
  }
  active.add(schema);
  addMetadataIssues(schema, path, issues);

  if ('$ref' in schema) {
    if (typeof schema.$ref !== 'string') {
      issues.push(
        issue('invalid-schema', `${path}/$ref`, '$ref must be a string')
      );
    } else if (schema.$ref.startsWith('#/')) {
      const parts = schema.$ref.slice(2).split('/').map(unescapePointer);
      const definitions =
        parts[0] === 'definitions'
          ? root.definitions
          : parts[0] === '$defs'
            ? root.$defs
            : undefined;
      const target = isRecord(definitions) ? definitions[parts[1]] : undefined;
      if (parts.length !== 2 || target === undefined) {
        issues.push(
          issue(
            'unresolved-reference',
            `${path}/$ref`,
            `unresolved reference ${schema.$ref}`
          )
        );
      } else {
        validateSchema(target, `${path}/$ref`, root, schemas, issues, active);
      }
    } else if (!(schema.$ref in schemas)) {
      issues.push(
        issue(
          'unresolved-reference',
          `${path}/$ref`,
          `unresolved reference ${schema.$ref}`
        )
      );
    } else {
      validateSchema(
        schemas[schema.$ref],
        `${path}/$ref`,
        schemas[schema.$ref] as Record<string, unknown>,
        schemas,
        issues,
        active
      );
    }
  }

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.some(
        (type) =>
          typeof type !== 'string' ||
          ![
            'string',
            'number',
            'integer',
            'boolean',
            'array',
            'object',
            'null',
          ].includes(type)
      )
    ) {
      issues.push(
        issue(
          'invalid-schema',
          `${path}/type`,
          'type contains an unsupported value'
        )
      );
    }
  }
  for (const key of [
    'properties',
    'patternProperties',
    'definitions',
    '$defs',
  ]) {
    if (key in schema && !isRecord(schema[key])) {
      issues.push(
        issue('invalid-schema', `${path}/${key}`, `${key} must be an object`)
      );
    }
  }
  if (
    'required' in schema &&
    (!Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== 'string'))
  ) {
    issues.push(
      issue(
        'invalid-schema',
        `${path}/required`,
        'required must be an array of strings'
      )
    );
  }
  if (isRecord(schema.patternProperties)) {
    for (const pattern of Object.keys(schema.patternProperties)) {
      try {
        new RegExp(pattern);
      } catch {
        issues.push(
          issue(
            'invalid-pattern',
            `${path}/patternProperties/${pointerSegment(pattern)}`,
            `invalid pattern ${pattern}`
          )
        );
      }
    }
  }

  for (const key of [
    'properties',
    'patternProperties',
    'definitions',
    '$defs',
  ]) {
    if (isRecord(schema[key])) {
      for (const [name, child] of Object.entries(schema[key])) {
        validateSchema(
          child,
          `${path}/${key}/${pointerSegment(name)}`,
          root,
          schemas,
          issues,
          active
        );
      }
    }
  }
  for (const key of ['items', 'additionalProperties']) {
    if (!(key in schema)) {
      continue;
    }
    const value = schema[key];
    if (!isRecord(value) && typeof value !== 'boolean') {
      issues.push(
        issue(
          'invalid-schema',
          `${path}/${key}`,
          `${key} must be a boolean or schema object`
        )
      );
      continue;
    }
    validateSchema(value, `${path}/${key}`, root, schemas, issues, active);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (key in schema && !Array.isArray(schema[key])) {
      issues.push(
        issue('invalid-schema', `${path}/${key}`, `${key} must be an array`)
      );
    }
    if (Array.isArray(schema[key])) {
      schema[key].forEach((child, index) =>
        validateSchema(
          child,
          `${path}/${key}/${index}`,
          root,
          schemas,
          issues,
          active
        )
      );
    }
  }
}

function validateCallable(
  value: unknown,
  path: string,
  schemas: Record<string, unknown>,
  issues: OpelRuntimeIssue[]
) {
  if (!isRecord(value) || !Array.isArray(value.signatures)) {
    issues.push(
      issue('invalid-runtime-entry', path, 'callable must contain signatures')
    );
    return;
  }
  addMetadataIssues(value, path, issues);
  value.signatures.forEach((signature, index) => {
    const signaturePath = `${path}/signatures/${index}`;
    if (
      !isRecord(signature) ||
      !Array.isArray(signature.parameters) ||
      !('returns' in (signature ?? {}))
    ) {
      issues.push(
        issue(
          'invalid-signature',
          signaturePath,
          'signature must contain parameters and returns'
        )
      );
      return;
    }
    addMetadataIssues(signature, signaturePath, issues);
    let optional = false;
    signature.parameters.forEach((parameter, parameterIndex) => {
      const parameterPath = `${signaturePath}/parameters/${parameterIndex}`;
      if (!isRecord(parameter) || !('schema' in parameter)) {
        issues.push(
          issue(
            'invalid-signature',
            parameterPath,
            'parameter must contain schema'
          )
        );
        return;
      }
      if ('optional' in parameter && typeof parameter.optional !== 'boolean') {
        issues.push(
          issue(
            'invalid-signature',
            `${parameterPath}/optional`,
            'optional must be a boolean'
          )
        );
      }
      if (parameter.optional) {
        optional = true;
      } else if (optional) {
        issues.push(
          issue(
            'invalid-signature',
            parameterPath,
            'required parameters must precede optional parameters'
          )
        );
      }
      validateSchema(
        parameter.schema,
        `${parameterPath}/schema`,
        parameter.schema as Record<string, unknown>,
        schemas,
        issues
      );
    });
    validateSchema(
      signature.returns,
      `${signaturePath}/returns`,
      signature.returns as Record<string, unknown>,
      schemas,
      issues
    );
  });
}

/**
 * Clones and validates caller metadata before exposing an immutable runtime snapshot.
 * Only `undefined` means no runtime; every other root must be cloneable and object-shaped.
 * Why: Treating invalid roots as an empty runtime keeps linting safe without silently accepting malformed configuration.
 */
export function createRuntimeContext(
  input: OpelRuntime | undefined,
  onIssues?: (issues: readonly OpelRuntimeIssue[]) => void
): RuntimeContext {
  if (input === undefined) {
    return { runtime: EMPTY_RUNTIME };
  }
  const issues: OpelRuntimeIssue[] = [];
  let runtime: unknown;
  try {
    runtime = structuredClone(input);
  } catch {
    issues.push(
      issue('invalid-runtime-entry', '/', 'runtime must be a cloneable object')
    );
    onIssues?.(issues);
    return { runtime: EMPTY_RUNTIME };
  }
  if (!isRecord(runtime)) {
    issues.push(
      issue('invalid-runtime-entry', '/', 'runtime must be an object')
    );
    onIssues?.(issues);
    return { runtime: EMPTY_RUNTIME };
  }

  const globals = isRecord(runtime.globals) ? runtime.globals : {};
  const functions = isRecord(runtime.functions) ? runtime.functions : {};
  const schemas = isRecord(runtime.schemas) ? runtime.schemas : {};
  const methods = isRecord(runtime.methods) ? runtime.methods : {};
  if ('globals' in runtime && !isRecord(runtime.globals)) {
    issues.push(
      issue('invalid-runtime-entry', '/globals', 'globals must be an object')
    );
  }
  if ('functions' in runtime && !isRecord(runtime.functions)) {
    issues.push(
      issue(
        'invalid-runtime-entry',
        '/functions',
        'functions must be an object'
      )
    );
  }
  if ('schemas' in runtime && !isRecord(runtime.schemas)) {
    issues.push(
      issue('invalid-runtime-entry', '/schemas', 'schemas must be an object')
    );
  }
  if ('methods' in runtime && !isRecord(runtime.methods)) {
    issues.push(
      issue('invalid-runtime-entry', '/methods', 'methods must be an object')
    );
  }

  for (const name of Object.keys(globals)) {
    validateSchema(
      globals[name],
      `/globals/${pointerSegment(name)}`,
      globals[name] as Record<string, unknown>,
      schemas,
      issues
    );
  }
  for (const name of Object.keys(functions)) {
    validateCallable(
      functions[name],
      `/functions/${pointerSegment(name)}`,
      schemas,
      issues
    );
  }
  for (const receiver of Object.keys(methods)) {
    if (
      !PRIMITIVE_METHOD_RECEIVERS.includes(
        receiver as OpelPrimitiveMethodReceiver
      ) &&
      !Object.prototype.hasOwnProperty.call(schemas, receiver)
    ) {
      issues.push(
        issue(
          'unresolved-reference',
          `/methods/${pointerSegment(receiver)}`,
          `unresolved method receiver "${receiver}"`
        )
      );
    }
    if (!isRecord(methods[receiver])) {
      issues.push(
        issue(
          'invalid-runtime-entry',
          `/methods/${pointerSegment(receiver)}`,
          'methods must be an object'
        )
      );
      continue;
    }
    for (const name of Object.keys(
      methods[receiver] as Record<string, unknown>
    )) {
      validateCallable(
        (methods[receiver] as Record<string, unknown>)[name],
        `/methods/${pointerSegment(receiver)}/${pointerSegment(name)}`,
        schemas,
        issues
      );
    }
  }
  for (const name of Object.keys(globals)) {
    if (name in functions) {
      issues.push(
        issue(
          'duplicate-symbol',
          `/globals/${pointerSegment(name)}`,
          `symbol ${name} exists as both global and function`
        )
      );
    }
  }

  const semanticErrors = issues.some((entry) => entry.severity === 'error');
  if (issues.length > 0) {
    onIssues?.(issues);
  }
  return {
    runtime: semanticErrors ? EMPTY_RUNTIME : freeze(runtime as OpelRuntime),
  };
}

export function isRuntimeSchema(schema: unknown): schema is OpelSchema {
  return schema === true || schema === false || isRecord(schema);
}

export function receiverForTypes(
  types: readonly string[]
): OpelMethodReceiver[] {
  return types.filter((type): type is OpelMethodReceiver =>
    PRIMITIVE_METHOD_RECEIVERS.includes(type as OpelPrimitiveMethodReceiver)
  );
}

export const runtimeIssueCodes = ISSUE_CODES;
