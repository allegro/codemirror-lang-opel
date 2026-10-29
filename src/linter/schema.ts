import type { OpelRuntime, OpelSchema } from '../types';

// Runtime schemas are frozen. Track originating documents separately so derived
// properties and union branches retain the roots needed by local references.
const SCHEMA_ROOTS = new WeakMap<object, OpelSchema>();
const SCHEMA_BRANCH_ROOTS = new WeakMap<object, OpelSchema[]>();
// allOf sibling constraints do not participate in branch-specific property checks.
const OWN_SCHEMA_CONSTRAINTS = new WeakSet<object>();

type SchemaResolution = {
  schema: OpelSchema;
  root: OpelSchema;
  references?: string[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function schemaObject(
  value: OpelSchema
): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function rememberSchemaRoot(schema: OpelSchema, root: OpelSchema): void {
  if (isRecord(schema)) {
    SCHEMA_ROOTS.set(schema, root);
  }
}

export function schemaRootFor(
  schema: OpelSchema,
  fallback: OpelSchema
): OpelSchema {
  return isRecord(schema) ? (SCHEMA_ROOTS.get(schema) ?? fallback) : fallback;
}

// Flatten oneOf branches; standalone true (unknown) inputs add no alternatives.
// Each retained branch keeps its own document root.
export function createUnionSchema(
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

function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

// Local references use the originating document; external keys start a new root.
// Repeated reference strings stop this resolution chain.
export function resolveSchemaReference(
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
    if (
      isRecord(definitions) &&
      Object.prototype.hasOwnProperty.call(definitions, name)
    ) {
      const target = definitions[name] as OpelSchema;
      rememberSchemaRoot(target, effectiveRoot);
      return resolveSchemaReference(target, effectiveRoot, runtime, seen);
    }
    return { schema: false, root: effectiveRoot };
  }
  const external =
    runtime.schemas &&
    Object.prototype.hasOwnProperty.call(runtime.schemas, ref)
      ? runtime.schemas[ref]
      : undefined;
  if (external === undefined) {
    return { schema: false, root: effectiveRoot };
  }
  rememberSchemaRoot(external, external);
  const resolved = resolveSchemaReference(external, external, runtime, seen);
  return { ...resolved, references: [ref, ...(resolved.references ?? [])] };
}

// Integer is the overlap of number and integer, not a contradictory type.
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

// Intersect schemas for one property or array item without losing branch roots.
export function combineSchemaValues(
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

type StructuralSchema = { object: Record<string, unknown>; root: OpelSchema };

// Sibling constraints on the allOf owner are not an additional property branch.
function mergeNamedProperties(
  structuralSchemas: StructuralSchema[],
  root: OpelSchema,
  runtime: OpelRuntime
): Record<string, OpelSchema> {
  const properties: Record<string, OpelSchema> = Object.create(null);
  const propertySources = structuralSchemas.filter(
    ({ object }) => !OWN_SCHEMA_CONSTRAINTS.has(object)
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
      const explicit =
        isRecord(object.properties) &&
        Object.prototype.hasOwnProperty.call(object.properties, name)
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
  return properties;
}

// Merge one concrete combination of allOf alternatives.
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

  // Reject contradictory types before merging structural or literal constraints.
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

  // Keep each object branch's root and property restrictions during the merge.
  const structuralSchemas = constrained
    .map((schema) => ({
      object: schemaObject(schema),
      root: schemaRootFor(schema, root),
    }))
    .filter((entry): entry is StructuralSchema => entry.object !== null);
  const properties = mergeNamedProperties(structuralSchemas, root, runtime);
  const required = new Set<string>();
  const patterns: Record<string, OpelSchema> = Object.create(null);
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

  // Intersect item/pattern schemas and collect additional-property constraints.
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

  return mergeLiteralConstraints(
    constrained,
    intersection,
    knownTypeSets.length > 0,
    merged
  )
    ? merged
    : false;
}

// Intersect literal constraints, then remove enum members outside the types.
function mergeLiteralConstraints(
  schemas: OpelSchema[],
  types: string[],
  hasKnownTypes: boolean,
  merged: Record<string, unknown>
): boolean {
  const constValues = schemas
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

  const enumValues = schemas
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
    if (hasKnownTypes) {
      allowed = allowed.filter((value) =>
        types.some(
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
  return true;
}

// ponytail: Cartesian expansion grows with branch combinations; use lazy combinations
// if large runtime schemas make this a measured bottleneck.
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
    return {
      schema,
      root: effectiveRoot,
      references: combination.flatMap((item) => item.references ?? []),
    };
  });
  const possible = merged.filter((item) => item.schema !== false);
  return possible.length > 0 ? possible : [{ schema: false, root }];
}

// oneOf/anyOf are static alternatives; allOf intersects every branch combination.
export function resolveSchemaVariants(
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime,
  seen = new Set<OpelSchema>()
): SchemaResolution[] {
  const resolved = resolveSchemaReference(schema, root, runtime);
  const object = schemaObject(resolved.schema);
  if (!object || resolved.schema === true || resolved.schema === false) {
    return [resolved];
  }
  // Runtime validation rejects composition cycles; guard derived schemas too.
  if (seen.has(resolved.schema)) {
    return [{ schema: false, root: resolved.root }];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(resolved.schema);
  if (Array.isArray(object.oneOf)) {
    const branchRoots = SCHEMA_BRANCH_ROOTS.get(object);
    return withSchemaReferences(
      object.oneOf.flatMap((child, index) =>
        resolveSchemaVariants(
          child as OpelSchema,
          branchRoots?.[index] ?? resolved.root,
          runtime,
          nextSeen
        )
      ),
      resolved.references
    );
  }
  if (Array.isArray(object.anyOf)) {
    const branchRoots = SCHEMA_BRANCH_ROOTS.get(object);
    return withSchemaReferences(
      object.anyOf.flatMap((child, index) =>
        resolveSchemaVariants(
          child as OpelSchema,
          branchRoots?.[index] ?? resolved.root,
          runtime,
          nextSeen
        )
      ),
      resolved.references
    );
  }
  if (Array.isArray(object.allOf)) {
    const branches = object.allOf.map((child) =>
      resolveSchemaVariants(
        child as OpelSchema,
        resolved.root,
        runtime,
        nextSeen
      )
    );
    const ownConstraints = { ...object };
    delete ownConstraints.allOf;
    if (Object.keys(ownConstraints).length > 0) {
      OWN_SCHEMA_CONSTRAINTS.add(ownConstraints);
      branches.push([
        { schema: ownConstraints as OpelSchema, root: resolved.root },
      ]);
    }
    return withSchemaReferences(
      intersectSchemaAlternatives(branches, resolved.root, runtime),
      resolved.references
    );
  }
  return [resolved];
}

// Keep named aliases attached to each alternative after resolving its shape.
function withSchemaReferences(
  variants: SchemaResolution[],
  references: string[] | undefined
): SchemaResolution[] {
  return references?.length
    ? variants.map((variant) => ({
        ...variant,
        references: [...references, ...(variant.references ?? [])],
      }))
    : variants;
}

// [] means unknown; ['never'] means impossible. Unknown must stay permissive.
export function getSchemaTypes(
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

// Integer literals retain their narrower type for overloads and arithmetic.
export function valueType(value: unknown): string {
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

// ponytail: prefix heuristics approximate pattern domains; use a regex-domain
// analyzer only if runtime schemas need more precise compatibility checks.
// Unfamiliar valid patterns are treated as potentially overlapping.
export function patternsMayOverlap(left: string, right: string): boolean {
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

// Only identical, universal, and anchored literal-prefix patterns prove coverage.
export function patternCovers(source: string, target: string): boolean {
  if (source === target || target === '.*' || target === '^.*$') {
    return true;
  }
  const sourcePrefix = source.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  const targetPrefix = target.match(/^\^([A-Za-z0-9_-]+)/)?.[1];
  return (
    !!sourcePrefix && !!targetPrefix && sourcePrefix.startsWith(targetPrefix)
  );
}

// Runtime validation reports invalid patterns; they do not match here.
export function patternMatches(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return false;
  }
}

export function matchingPatternProperties(
  schema: Record<string, unknown>,
  name: string
): OpelSchema[] {
  if (!isRecord(schema.patternProperties)) {
    return [];
  }
  return Object.entries(schema.patternProperties).flatMap(
    ([pattern, value]) => {
      return patternMatches(pattern, name) ? [value as OpelSchema] : [];
    }
  );
}

// Unknown accepts any primitive; integers also satisfy number schemas.
export function schemaAllowsType(
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

// Preserve the existing JSON-serialization comparison for schema literals.
export function literalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
