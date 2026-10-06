import type { OpelPrimitive, OpelRuntime, OpelSchema } from '../types';
import {
  getSchemaTypes,
  isRecord,
  literalEqual,
  matchingPatternProperties,
  patternCovers,
  patternMatches,
  patternsMayOverlap,
  resolveSchemaVariants,
  schemaAllowsType,
  schemaObject,
  schemaRootFor,
  valueType,
} from './schema';

export type SchemaValue = {
  schema: OpelSchema;
  root?: OpelSchema;
  literal?: unknown;
};

type SchemaPair = readonly [OpelSchema, OpelSchema];

/**
 * Directional assignability: every source alternative must fit some target
 * alternative. Unknown schemas stay permissive.
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
  // Re-entering the same source/target pair closes a recursive comparison.
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

/** Checks primitive types and literal domains before objects and array items. */
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

  if (
    !isObjectSchemaCompatible(
      sourceObject,
      targetObject,
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

/** Checks declared members, pattern domains, and extra-property domains. */
function isObjectSchemaCompatible(
  sourceObject: Record<string, unknown>,
  targetObject: Record<string, unknown>,
  sourceRoot: OpelSchema,
  targetRoot: OpelSchema,
  runtime: OpelRuntime,
  seen: SchemaPair[]
): boolean {
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

  // The source must guarantee each required target member.
  for (const name of targetRequired) {
    if (!sourceRequired.has(name)) {
      return false;
    }
  }
  // Explicit properties must satisfy every matching target constraint.
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

  // Check the full source pattern domain, including keys not explicitly named.
  const sourcePatterns = isRecord(sourceObject.patternProperties)
    ? Object.entries(sourceObject.patternProperties)
    : [];
  const targetPatterns = isRecord(targetObject.patternProperties)
    ? Object.entries(targetObject.patternProperties)
    : [];
  for (const [sourcePattern, sourcePatternSchema] of sourcePatterns) {
    for (const [targetName, targetProperty] of Object.entries(
      targetProperties
    )) {
      if (
        patternMatches(sourcePattern, targetName) &&
        !isSchemaCompatible(
          sourcePatternSchema as OpelSchema,
          targetProperty as OpelSchema,
          schemaRootFor(sourcePatternSchema as OpelSchema, sourceRoot),
          targetRoot,
          runtime,
          seen
        )
      ) {
        return false;
      }
    }
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

  // Extra source keys can also overlap named target properties.
  if (
    sourceObject.additionalProperties &&
    sourceObject.additionalProperties !== true &&
    isRecord(targetObject.properties)
  ) {
    for (const [targetName, targetProperty] of Object.entries(
      targetObject.properties
    )) {
      if (
        !(targetName in sourceProperties) &&
        matchingPatternProperties(sourceObject, targetName).length === 0 &&
        !isSchemaCompatible(
          sourceObject.additionalProperties as OpelSchema,
          targetProperty as OpelSchema,
          sourceRoot,
          targetRoot,
          runtime,
          seen
        )
      ) {
        return false;
      }
    }
  }

  // A source with unrestricted extras cannot satisfy a closed or typed target.
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

  return true;
}

/** Known literals use value constraints; other values use inferred schemas. */
export function isValueCompatibleWithSchema(
  value: SchemaValue,
  schema: OpelSchema,
  root: OpelSchema,
  runtime: OpelRuntime
): boolean {
  if (schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  if (value.literal === undefined) {
    return isSchemaCompatible(
      value.schema,
      schema,
      value.root ?? value.schema,
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
          { schema: { type: valueType(item) as OpelPrimitive }, literal: item },
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

/** Checks only the concrete members of a known object literal. */
function isObjectCompatibleWithSchema(
  value: SchemaValue,
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
