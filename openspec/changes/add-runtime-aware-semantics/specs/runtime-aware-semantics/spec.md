## Purpose

Provides runtime-aware semantic analysis and lint diagnostics for OPEL while
keeping runtime configuration immutable, validated, and reusable by future
editor features.

## ADDED Requirements

### Requirement: Runtime metadata is a structured immutable contract

The system SHALL accept runtime metadata containing globals, functions,
methods, and named schemas through the OPEL extension options. The public
runtime metadata and its nested schema and callable structures SHALL be
readonly and SHALL expose these behaviors:

- parameters MAY set `optional: true`, and optional parameters SHALL trail
  required parameters;
- runtime entries, schemas/properties, and signatures MAY set
  `deprecated: boolean | string`;
- signatures SHALL contain readonly `parameters` and a readonly `returns`
  schema;
- method receivers SHALL support string, number, integer, boolean, array, and
  object receiver categories.

Runtime symbol names SHALL be authoritative record keys, and a name SHALL NOT
occur in both the runtime globals and runtime functions namespaces.

#### Scenario: Runtime metadata defines globals, functions, methods, and schemas

- **WHEN** a caller configures valid runtime metadata
- **THEN** the analyzer SHALL use the configured globals, functions, methods,
  and schemas for semantic analysis

#### Scenario: A runtime name is present in both value namespaces

- **WHEN** the same name is configured as a runtime global and runtime function
- **THEN** the configuration SHALL produce a `duplicate-symbol` issue
- **AND** the runtime configuration SHALL be disabled

#### Scenario: Runtime metadata is changed after extension creation

- **WHEN** a caller mutates an object used to configure runtime metadata
- **THEN** the active runtime contract SHALL remain unchanged
- **AND** the caller's original object SHALL not be frozen or mutated
- **AND** applying new metadata SHALL require extension reconfiguration

#### Scenario: A callable declares optional and deprecated metadata

- **WHEN** a callable has required parameters followed by optional parameters
  and a deprecated signature
- **THEN** the metadata SHALL be accepted
- **AND** the analyzer SHALL preserve the optional and deprecation semantics

### Requirement: Runtime configuration issues are stable and atomic

The system SHALL validate the reachable runtime configuration and report
runtime configuration issues with a stable code, an escaped JSON Pointer path,
a human-readable message, and `warning` or `error` severity. Supported issue
codes SHALL include `invalid-runtime-entry`, `duplicate-symbol`,
`invalid-schema`, `unresolved-reference`, `invalid-pattern`,
`invalid-signature`, and `invalid-metadata`.

Malformed optional presentation metadata SHALL produce a warning and be
ignored. Any semantic configuration error SHALL disable the entire runtime
configuration rather than partially enabling valid-looking fragments.

At runtime-context creation, the system SHALL deep-clone the caller's runtime
metadata, validate and normalize the clone, and deep-freeze the active
snapshot. `onRuntimeIssues` SHALL be invoked synchronously at most once for
that context creation, and only when at least one issue exists. Reconfiguration
SHALL create a new snapshot and MAY invoke the callback again.

#### Scenario: A reachable schema contains an unresolved reference

- **WHEN** a configured global or callable transitively references a missing
  schema
- **THEN** `onRuntimeIssues` SHALL receive an `unresolved-reference` issue
- **AND** the issue path SHALL identify the escaped configuration location
- **AND** runtime semantics SHALL be disabled

#### Scenario: Optional presentation metadata is malformed

- **WHEN** optional presentation metadata is invalid but semantic metadata is
  valid
- **THEN** the system SHALL report an `invalid-metadata` warning
- **AND** ignore only that presentation metadata
- **AND** keep the semantic runtime configuration enabled

#### Scenario: Runtime configuration has one semantic error

- **WHEN** any semantic runtime configuration error is present
- **THEN** the system SHALL invoke `onRuntimeIssues` synchronously once for the
  runtime context
- **AND** it SHALL not add configuration issues to document diagnostics
- **AND** it SHALL behave as if `runtime` were absent

#### Scenario: The caller mutates runtime metadata after setup

- **WHEN** the caller changes the original runtime object after the runtime
  context is created
- **THEN** active analysis SHALL continue using the cloned frozen snapshot
- **AND** a new callback SHALL not occur until reconfiguration

### Requirement: The analyzer supports the documented schema vocabulary

The system SHALL support boolean schemas, primitive and nullable `type`,
`properties`, `required`, `items`, `additionalProperties`,
`patternProperties`, `const`, `enum`, `oneOf`, `anyOf`, `allOf`,
`definitions`, `$defs`, and `$ref`. Unknown schema keywords SHALL be ignored.
Formats, patterns, numeric ranges, length constraints, collection sizes,
uniqueness, defaults, and examples SHALL not be enforced by static OPEL
analysis. `oneOf` and `anyOf` SHALL both be treated as static unions without
exclusivity checking. `allOf` SHALL be treated as an intersection; contradictory
constraints SHALL produce an impossible schema.

#### Scenario: A schema uses a boolean unconstrained schema

- **WHEN** a value is analyzed against schema `true`
- **THEN** the value SHALL be accepted without a type diagnostic
- **AND** member access SHALL produce an unknown result without an
  unknown-property diagnostic

#### Scenario: A schema uses nullable and primitive types

- **WHEN** a known value is analyzed against a nullable primitive schema
- **THEN** the value SHALL be accepted only when its primitive type or
  explicit nullability matches
- **AND** primitive values SHALL not be coerced

#### Scenario: A schema contains unsupported value-only constraints

- **WHEN** a value violates a format, range, length, uniqueness, default, or
  example keyword
- **THEN** the analyzer SHALL not report a diagnostic solely for that
  constraint

#### Scenario: A schema uses oneOf and anyOf alternatives

- **WHEN** a schema contains `oneOf` or `anyOf` branches
- **THEN** the analyzer SHALL infer a union of the branch schemas
- **AND** it SHALL not report an error merely because multiple branches match

#### Scenario: An allOf composition is contradictory

- **WHEN** `allOf` branches cannot describe any common value
- **THEN** the analyzer SHALL represent the result as impossible
- **AND** a known value against it SHALL produce one type diagnostic
- **AND** dependent diagnostics SHALL be suppressed

### Requirement: Schema references are resolved locally and by exact key

The system SHALL resolve `#/definitions/<name>` and `#/$defs/<name>` within
the containing schema. Any other reference SHALL be resolved by a
case-sensitive exact-key lookup in `runtime.schemas`. Registry keys SHALL be
opaque and MAY contain `/`. The analyzer SHALL not normalize URIs, resolve
registry-key fragments, invoke resolver callbacks, load schemas
asynchronously, or access the network.

Every directly and transitively referenced external schema required by a
reachable runtime entry SHALL be supplied by the caller. Recursive schemas
SHALL be supported without a fixed access-depth limit.

#### Scenario: A local definition is referenced

- **WHEN** a schema references `#/definitions/User`
- **THEN** the analyzer SHALL resolve the definition in that schema

#### Scenario: An external schema is referenced by an exact registry key

- **WHEN** a schema references `catalog/user/1.0`
- **AND** `runtime.schemas` contains that exact key
- **THEN** the analyzer SHALL use the referenced schema

#### Scenario: A recursive schema is accessed repeatedly

- **WHEN** a reachable schema references itself through a property or
  collection item
- **THEN** the analyzer SHALL resolve the recursive graph safely
- **AND** it SHALL not fail because of a fixed nesting-depth limit

### Requirement: Name resolution and expression inference follow OPEL semantics

The analyzer SHALL resolve local declarations and lambda parameters before
runtime globals and functions. Local bindings SHALL shadow runtime symbols.
When runtime metadata is valid, unknown bare symbols and unknown bare function
calls SHALL produce diagnostics when no local binding resolves them. A
shadowing non-callable local SHALL produce a non-callable diagnostic rather
than falling through to a runtime function. Parenthesized calls SHALL resolve
the symbol or property first and suppress dependent call diagnostics after a
root resolution error. Absent or invalid runtime metadata SHALL preserve the
current linter behavior.

Declaration initializers SHALL see earlier declarations and runtime symbols but
not their own new binding. Locally declared lambdas SHALL be callable and
their positional arity SHALL be validated.

The analyzer SHALL infer boolean results for comparisons, equality, and
logical expressions; numeric results for known numeric arithmetic; string
results for known string addition; and the union of both branches for `if`.
Operand-validity diagnostics are outside this requirement.

#### Scenario: A local binding shadows a runtime global

- **WHEN** a local declaration and runtime global have the same name
- **THEN** references in the local scope SHALL resolve to the local binding

#### Scenario: A declaration initializer references its own name

- **WHEN** a declaration initializer references the binding being declared
- **THEN** the initializer SHALL not resolve that new binding

#### Scenario: A runtime function is shadowed by a non-callable local

- **WHEN** a local value shadows a configured runtime function and is called
- **THEN** the analyzer SHALL report that the local value is not callable
- **AND** it SHALL not resolve the runtime function as a fallback

#### Scenario: A known conditional has two branch schemas

- **WHEN** an `if` expression has known result schemas in both branches
- **THEN** the expression schema SHALL be the union of those branch schemas

### Requirement: Values are checked against known schemas without coercion

The analyzer SHALL check known values against `const` and `enum` domains,
structural object schemas, required object properties, and list item schemas.
An integer SHALL be assignable to number, but a number SHALL not be assignable
to integer. Null SHALL match only explicitly nullable schemas. The analyzer
SHALL not apply configurable OPEL runtime conversions when checking primitive
compatibility.

#### Scenario: A literal violates a const constraint

- **WHEN** a known value does not equal a schema's `const` value
- **THEN** the analyzer SHALL report a diagnostic on the incompatible value

#### Scenario: A known object omits a required property

- **WHEN** a known object literal is checked against a schema with a required
  property that is absent
- **THEN** the analyzer SHALL report a diagnostic on the object literal

#### Scenario: A list contains an incompatible known element

- **WHEN** a known list element does not match the schema's `items` schema
- **THEN** the analyzer SHALL report a diagnostic for that element

### Requirement: Object, union, and bracket access is analyzed safely

For a named or patterned object structure with omitted
`additionalProperties`, an undeclared property SHALL produce a warning. With
`additionalProperties: false`, it SHALL produce an error. With
`additionalProperties: true`, it SHALL be allowed with an unknown result. A
schema-valued `additionalProperties` SHALL be allowed and use that schema. A
bare object with no property rules SHALL allow access with an unknown result.

For union receivers, a member supported by every branch SHALL be accepted, a
member supported by only some branches SHALL produce a warning, and a member
supported by no branch SHALL produce an error. Result schemas SHALL come from
supporting branches. Known object literals and direct aliases of known values SHALL support
discriminator narrowing using `const` and `enum`. Runtime globals with union
schemas SHALL continue to use ordinary union rules because their concrete value
is unknown. Flow-sensitive narrowing from conditions is outside this
requirement.

An unconstrained or unknown receiver SHALL allow member access without a
diagnostic and return an unknown schema. Literal string bracket keys SHALL use
normal property rules. Dynamic object keys SHALL not produce
unknown-property errors, except that dynamic access on an explicitly closed
object SHALL warn. Known list indexes SHALL be numeric and list results SHALL
use `items`.

#### Scenario: A union member exists on only one branch

- **WHEN** a member is accessed on a union and only one branch defines it
- **THEN** the analyzer SHALL produce a warning
- **AND** the result schema SHALL include the supporting branch result

#### Scenario: A closed object receives an unknown property

- **WHEN** a property absent from an object schema with
  `additionalProperties: false` is accessed
- **THEN** the analyzer SHALL produce an error on the property access

#### Scenario: A dynamic key accesses a closed object

- **WHEN** an object with `additionalProperties: false` is accessed using a
  non-literal key
- **THEN** the analyzer SHALL produce a warning rather than an unknown-key
  error

#### Scenario: A known list is accessed with a non-numeric index

- **WHEN** a known list is accessed using a non-numeric index
- **THEN** the analyzer SHALL report an invalid list-index diagnostic

#### Scenario: A known value is narrowed through a discriminator alias

- **WHEN** a direct alias of a known object literal has a discriminator value
  constrained by `const` or `enum`
- **THEN** the analyzer SHALL use the narrowed branch for subsequent access
- **AND** a runtime global with the same union schema SHALL not be narrowed
  without a known concrete value

### Requirement: Functions and methods use strict overload resolution

Functions and methods SHALL use the same signature model. Optional parameters
SHALL trail required parameters. Required parameters SHALL be supplied, extra
arguments SHALL be errors, and variadic signatures SHALL not be supported in
this change. Known arguments SHALL be checked against applicable signatures
without coercion, while unknown arguments SHALL preserve otherwise
arity-compatible signatures. Local lambdas and configured runtime callables
SHALL use the same strict fixed-arity rules. One matching signature SHALL
determine the return schema. Multiple matches on a syntactically complete call
SHALL produce a warning and union their return schemas. No matches on a
complete call SHALL produce an error. Incomplete or syntactically invalid
calls SHALL not produce mismatch or ambiguity diagnostics.

Methods SHALL be configurable for string, number, integer, boolean, array, and
object receivers. Integer receivers SHALL inherit number methods, with
integer-specific methods overriding same-named inherited methods. Null SHALL
have no configured methods. Member-call precedence SHALL distinguish property
access, configured method calls, and parenthesized callable properties.

#### Scenario: A literal argument selects one overload

- **WHEN** a complete call has an argument matching exactly one configured
  signature
- **THEN** the analyzer SHALL infer that signature's return schema

#### Scenario: Multiple overloads remain applicable

- **WHEN** a syntactically complete call matches multiple signatures
- **THEN** the analyzer SHALL produce one ambiguity warning
- **AND** the return schema SHALL be the union of matching return schemas

#### Scenario: A call is incomplete

- **WHEN** a call is syntactically incomplete while the user is editing
- **THEN** the analyzer SHALL not report argument mismatch or overload
  ambiguity diagnostics

#### Scenario: A call supplies extra arguments

- **WHEN** a complete local lambda or configured callable receives more
  arguments than its required and optional parameters allow
- **THEN** the analyzer SHALL report an arity diagnostic for the whole call

#### Scenario: A direct method call has no configured method

- **WHEN** a known receiver uses `value.name(...)` and no configured method
  named `name` applies
- **THEN** the analyzer SHALL report an invalid-method diagnostic
- **AND** it SHALL not fall back to a callable `name` property

#### Scenario: A parenthesized property is called

- **WHEN** `(value.name)(...)` is used
- **THEN** the analyzer SHALL resolve `name` as a property first
- **AND** it SHALL validate that the resulting property is callable

### Requirement: Runtime-aware diagnostics preserve useful ranges and compatibility

With valid runtime metadata, the semantic analyzer SHALL own unresolved bare
identifier diagnostics and replace the existing declaration diagnostic at that
range. With absent or invalid runtime metadata, existing declaration
diagnostics SHALL remain unchanged.

Diagnostics SHALL use the smallest useful range: the identifier or literal key
for unknown or deprecated symbols and members; the argument expression for a
proven argument mismatch; the incompatible value expression for a known
`const` or `enum` violation; the whole call for arity mismatch or overload
ambiguity; the member access or method call for an invalid receiver; the
object literal for missing required properties; and the offending key for a
forbidden additional property.

After a root semantic error, diagnostics that depend on unavailable type
information SHALL be suppressed while independent sibling expressions SHALL
continue to be analyzed.

Deprecated symbols, signatures, properties, and methods SHALL produce
warnings. The system SHALL emit one deprecation warning per use and choose the
most specific source in this order: selected signature, property or method,
then top-level symbol.

#### Scenario: Runtime metadata is absent

- **WHEN** no runtime metadata is configured
- **THEN** the linter SHALL preserve the existing declaration diagnostics
- **AND** it SHALL not require runtime configuration

#### Scenario: A deprecated property is used through a deprecated symbol

- **WHEN** both a top-level symbol and a selected property are deprecated
- **THEN** the linter SHALL emit one warning for the use
- **AND** it SHALL use the property deprecation message

#### Scenario: A root access fails to resolve

- **WHEN** a member access has no available receiver schema
- **THEN** dependent member diagnostics SHALL be suppressed
- **AND** independent sibling expressions SHALL still be analyzed

#### Scenario: A bare runtime function is unknown

- **WHEN** valid runtime metadata is configured and `missing()` has no local or
  runtime function binding
- **THEN** the linter SHALL report an unknown-runtime-function diagnostic
- **AND** a bare `missing` reference SHALL report an unknown-symbol diagnostic

#### Scenario: Runtime metadata is absent or invalid for a function call

- **WHEN** runtime metadata is absent or invalid and a function-call name is
  unresolved
- **THEN** the linter SHALL preserve the existing function-call handling
- **AND** it SHALL not apply runtime-aware unknown-function diagnostics

