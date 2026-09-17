> **TDD policy:** The first implementation step is to author the complete
> library API and behavior test suite for this feature. Those tests are expected
> to fail initially. Do not implement feature behavior while authoring that
> suite. After the suite exists, each implementation task follows red-green-
> refactor: run the focused failing test, make the smallest change that passes,
> refactor if appropriate, and run the focused test plus the relevant regression
> suite. Documentation-only tasks are exempt.

## 1. Complete behavior/API test suite (write red first)

- [ ] 1.1 Add shared runtime metadata fixtures and compile-time/API tests covering readonly types, optional parameters, deprecation metadata, receiver categories, and signature return schemas; verify the new tests fail because the API is not implemented
- [ ] 1.2 Add runtime configuration tests covering duplicate symbols, every stable issue code, escaped JSON Pointer paths, warning-vs-error severity, callback timing/count, clone-and-freeze behavior, atomic invalidation, and absent/invalid-runtime compatibility; verify the tests fail for feature absence
- [ ] 1.3 Add schema tests covering boolean schemas, primitive/nullability rules, const/enum, required properties, items, additionalProperties, patternProperties, ignored value-only keywords, local references, exact external keys, recursive schemas, oneOf/anyOf unions, and contradictory allOf intersections; verify the tests fail
- [ ] 1.4 Add scope and inference tests covering local shadowing, initializer visibility, lambda scopes, strict local-lambda arity, literal results, comparisons, arithmetic/string inference, conditionals, and unknown results; verify the tests fail
- [ ] 1.5 Add object/union/access tests covering structured-object warnings, closed-object errors, open objects, literal and dynamic bracket access, list indexes, partial union members, discriminator narrowing for known values/direct aliases, and no narrowing for runtime globals; verify the tests fail
- [ ] 1.6 Add callable/method tests covering strict fixed arity, optional trailing parameters, no variadics, unknown arguments, overload selection/ambiguity, integer-to-number receiver inheritance, null receivers, direct method precedence, and parenthesized callable properties; verify the tests fail
- [ ] 1.7 Add diagnostic tests covering unknown symbols/functions, invalid methods, mismatches, ranges, severities, deprecation precedence, one-warning-per-use, dependent-cascade suppression, sibling analysis, and incomplete-call suppression; verify the tests fail
- [ ] 1.8 Add integration and packaged-API tests proving runtime-aware behavior is exposed through linting only, autocomplete remains unchanged, exported types are packaged, and absent/invalid runtime behavior is preserved; verify the new tests fail while the existing suite remains the compatibility baseline

## 2. Public API and runtime snapshot

- [ ] 2.1 Define and export readonly runtime, schema, callable, signature, parameter, method-receiver, and runtime-issue types; make the type/API tests from 1.1 pass with `npm run typecheck`
- [ ] 2.2 Replace `runtimeGlobals` with the structured `runtime` option and wire `onRuntimeIssues`; make the compatibility tests from 1.2 pass
- [ ] 2.3 Implement deep cloning, validation-context creation, normalization hooks, and deep-freezing of the internal runtime snapshot; make the mutation, callback-count, and reconfiguration tests from 1.2 pass
- [ ] 2.4 Update README examples and migration guidance for the structured runtime API; verify documentation examples match the exported types

## 3. Runtime metadata validation

- [ ] 3.1 Implement validation of runtime entries, duplicate namespaces, signatures, optional-parameter ordering, method receivers, and deprecation metadata; make the corresponding tests from 1.2 pass
- [ ] 3.2 Implement escaped JSON Pointer issue paths, stable issue codes, severity, and synchronous callback delivery; make the issue-reporting tests from 1.2 pass
- [ ] 3.3 Enforce atomic invalidation and no-runtime fallback for semantic configuration errors; make the compatibility tests from 1.2 pass

## 4. Schema normalization and resolution

- [ ] 4.1 Normalize boolean, primitive, nullable, object, list, const, enum, required-property, union, and intersection schemas; make the schema tests from 1.3 pass
- [ ] 4.2 Implement local `#/definitions/...` and `#/$defs/...` resolution plus case-sensitive exact-key external lookup; make the reference tests from 1.3 pass
- [ ] 4.3 Implement lazy cycle-safe schema nodes and reachable-entry validation; make recursive and unreachable-entry tests from 1.3 pass
- [ ] 4.4 Implement static oneOf/anyOf unions and contradictory allOf impossible schemas; make the composition tests from 1.3 pass

## 5. Semantic analysis

- [ ] 5.1 Implement lexical environments for programs, blocks, declarations, and lambdas; make scope and strict local-lambda tests from 1.4 pass
- [ ] 5.2 Implement expression schema inference for literals, comparisons, equality, logical expressions, arithmetic, strings, conditionals, objects, and lists; make inference tests from 1.4 pass
- [ ] 5.3 Implement strict compatibility for const, enum, primitive, nullable, structural object, required-property, and list-item schemas without runtime coercion; make compatibility tests from 1.3 and 1.4 pass
- [ ] 5.4 Implement structured-object, union, discriminator, unknown-receiver, and bracket-access semantics; make access and narrowing tests from 1.5 pass
- [ ] 5.5 Implement strict function/method applicability, overload return unions, receiver inheritance, and syntax-driven member-call precedence; make callable tests from 1.6 pass

## 6. Diagnostics and linter integration

- [ ] 6.1 Integrate the semantic analyzer with `opelLinter` while preserving parse, delimiter, declaration, duplicate, and lambda diagnostics; make integration tests from 1.8 and existing tests pass
- [ ] 6.2 Emit unknown, mismatch, arity, ambiguity, invalid-receiver, invalid-method, required-property, additional-property, and deprecation diagnostics at specified ranges and severities; make diagnostic tests from 1.7 pass
- [ ] 6.3 Implement strict unknown-symbol/function resolution, dependent-cascade suppression, deprecation precedence, and incomplete-call suppression; make the remaining tests from 1.7 pass
- [ ] 6.4 Ensure runtime-aware behavior is used by linting only and does not change autocomplete; make no-autocomplete-regression tests from 1.8 pass

## 7. Final verification and packaged API

- [ ] 7.1 Run the complete suite and verify `npm test`
- [ ] 7.2 Verify public types and generated package output with `npm run typecheck` and `npm run build`
- [ ] 7.3 Verify the packaged API and extension behavior with `npm run smoke:package`
