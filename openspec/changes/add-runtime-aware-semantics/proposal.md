## Why

The current linter understands syntax and local declarations, but it cannot
reason about runtime globals, functions, methods, schemas, overloads, or
deprecated APIs. Issue #9 introduces a shared runtime-aware semantic layer so
OPEL diagnostics can reflect the runtime contract while leaving autocomplete
for a later change built on the same analyzer.

## What Changes

- **BREAKING** Replace the flat `runtimeGlobals` option with a structured,
  readonly `runtime` contract.
- Export runtime, schema, callable, signature, parameter, method-receiver, and
  runtime-issue types.
- Validate reachable runtime metadata and report stable issue codes with
  escaped JSON Pointer paths through `onRuntimeIssues`.
- Support the editor-focused schema vocabulary, local references, exact-key
  external references, and recursive schemas.
- Add lexical name resolution and schema inference for supported OPEL
  expressions.
- Add object, union, bracket-access, lambda, function, method, and overload
  semantics.
- Add runtime-aware diagnostics with documented severity, range, deprecation,
  and cascade-suppression behavior.
- Run semantic analysis against an empty runtime when runtime metadata is
  absent or invalid, while preserving declaration-order and duplicate checks.
- Document the runtime API, supported vocabulary, issue contract, and
  migration from `runtimeGlobals`.

## Capabilities

### New Capabilities

- `runtime-aware-semantics`: Runtime metadata, schema analysis, and
  runtime-aware OPEL lint diagnostics.

### Modified Capabilities

None.

## Impact

- Public options and exported types in `src/types.ts` and `src/index.ts`.
- Extension and linter integration in `src/extensions/index.ts` and
  `src/linter/index.ts`.
- New runtime metadata, schema, and semantic-analysis modules.
- Existing linter behavior and tests for declarations and diagnostics.
- New focused unit, typecheck, build, packaged-API, and documentation tests.
- README API examples and migration guidance.

