## Context

The current public configuration is defined by `OpelOptions` and exposes a
flat `runtimeGlobals` list. The linter performs syntax and declaration checks
directly while walking the Lezer tree; it has no schema model or expression
type information. `opelExtensions` passes the same options to the language and
linter, and autocomplete currently provides only static OPEL completions.

Issue #9 is a cross-cutting semantic change. Runtime-aware autocomplete is
deliberately excluded, but the semantic representation must be reusable by a
later autocomplete change.

## Goals / Non-Goals

**Goals:**

- Provide a readonly public runtime contract with stable configuration issues.
- Validate runtime metadata atomically before enabling runtime semantics.
- Normalize the supported schema vocabulary into a cycle-safe internal model.
- Resolve names, schemas, properties, methods, and overloads for linting.
- Run semantic analysis with an empty runtime when metadata is absent or invalid.
- Keep diagnostic wording internal while making issue codes and paths stable.

**Non-Goals:**

- Runtime-aware autocomplete.
- Complete JSON Schema compliance or instance validation.
- Network, asynchronous, or callback-based schema loading.
- Runtime OPEL evaluation.
- Flow-sensitive narrowing from `if` conditions.
- Runtime evaluation and coercion beyond static operand validation.
- Heuristic overload ranking.
- Mutable runtime configuration.

## Decisions

### Clone, validate, normalize, and freeze the public contract

Define exported readonly types for schemas, runtime entries, callables,
signatures, parameters, method receivers, and runtime issues. Parameters expose
`optional?: boolean`; runtime entries, schemas/properties, and signatures expose
`deprecated?: boolean | string`; signatures contain readonly parameters and a
readonly returns schema.

At runtime-context creation, deep-clone caller metadata, validate and normalize
the clone, then deep-freeze the internal snapshot. If validation produces any
semantic error, return an empty runtime context and keep semantic analysis
enabled. Report configuration issues synchronously once per context creation,
never on each lint pass.

This avoids partially trusted configuration, keeps caller-owned objects
unmodified, and makes extension reconfiguration the explicit way to change
runtime behavior.

### Separate validation, normalization, analysis, and diagnostics

Use separate internal responsibilities:

1. Validate and normalize configured metadata.
2. Resolve schemas through a lazy graph with cycle detection.
3. Analyze expressions with lexical environments and inferred result schemas.
4. Convert semantic findings into CodeMirror diagnostics.

This separation keeps schema mechanics independent from AST traversal and
allows future consumers, including autocomplete, to reuse the normalized
semantic context without reusing linter-specific diagnostic code.

### Use a lazy cycle-safe schema graph

Represent local and external references as graph nodes rather than eagerly
expanding schemas. Resolve local definition paths and exact external registry
keys only for entries reachable from configured globals, functions, and
methods. Track active resolution nodes so recursive schemas terminate safely.

Treat `oneOf` and `anyOf` as static unions without exclusivity checking. Treat
`allOf` as an intersection; contradictory branches become an impossible
schema. Unknown schema keywords are ignored and unsupported value-only
constraints are not added to the graph's static compatibility checks.

### Model results as unknown, known, or unions

Expression analysis should preserve enough information for downstream member
and call checks without pretending to execute OPEL. Use explicit unknown
results, concrete primitive/literal results, object/list results, and unions.
Unknown receivers allow access without false-positive property errors. Union
member access combines supporting branches and records whether support is
complete, partial, or absent.

### Resolve lexical scope before runtime symbols

Build lexical environments matching the existing declaration and lambda
behavior. Resolve local bindings first, then runtime globals/functions. Keep
declaration initializer visibility and shadowing rules explicit so a local
non-callable binding cannot accidentally fall through to a runtime callable.
Report unresolved bare symbols and bare function calls using syntax-aware
diagnostics; parenthesized calls resolve the symbol or property first and
suppress dependent cascades. With absent or invalid runtime metadata, resolve
only local names and analyze against an empty runtime.

### Use strict applicability for overloads

Filter signatures by strict fixed arity and known argument compatibility without
coercion. Required parameters must be supplied, optional parameters must trail
required parameters, and extra or variadic arguments are unsupported. Unknown
arguments remain applicable when arity permits. Local lambdas and configured
callables use the same rules. Return one schema for a single match and a union
plus warning for multiple complete-call matches. Incomplete or parse-error
calls stop before mismatch and ambiguity reporting.

### Keep runtime issues outside document diagnostics

Call `onRuntimeIssues` synchronously at most once per runtime-context creation,
and only when configuration issues exist. Runtime configuration issues never
enter CodeMirror's document diagnostic array. Document diagnostics use
existing CodeMirror shapes and focused source ranges; exact message text
remains private API.

### Build the complete behavior suite before implementation

The first implementation step is to write the complete library API and
behavior test suite for this feature, using the resolved ambiguity decisions.
Those tests should initially fail because the feature is not implemented. No
feature implementation should be mixed into that first test-authoring step.

After the suite exists, implementation SHALL follow test-driven development:
make the smallest production change needed to turn the next focused tests
green, then refactor while keeping the focused test and relevant regression
suite green. Documentation-only tasks may be completed without a failing test.

### Treat removal of `runtimeGlobals` as an explicit migration

Replace the old option rather than silently merging it with the new contract.
Update README examples and add packaged API/type tests. The runtime-aware
analyzer is used by linting only in this change; autocomplete remains
unchanged and does not consume runtime metadata.

## Risks / Trade-offs

- **[Schema vocabulary is intentionally incomplete]** → Document the supported
  subset and test that unsupported value-only keywords are ignored.
- **[Union analysis can produce warnings for valid branch-specific access]**
  → Distinguish complete, partial, and absent member support and suppress only
  dependent cascades.
- **[Atomic invalidation hides otherwise valid runtime entries]** → Report all
  configuration issues with stable paths while continuing document analysis
  against an empty runtime.
- **[Removing `runtimeGlobals` is breaking]** → Mark the API change clearly,
  update migration documentation, and add tests for empty-runtime behavior.
- **[Lezer syntax may be incomplete during editing]** → Avoid mismatch and
  ambiguity diagnostics for incomplete or syntactically invalid calls.
- **[Large semantic scope increases regression risk]** → Keep the existing
  linter checks, add focused unit tests by semantic subsystem, and run
  typecheck, build, and packaged smoke tests before release.

## Migration Plan

1. Add the readonly runtime API and internal analyzer without changing parser
   behavior.
2. Replace `runtimeGlobals` in examples and documentation with the structured
   `runtime` option.
3. Add runtime-aware linter tests and empty-runtime behavior tests.
4. Run unit, typecheck, build, and packaged API verification.
5. Release the breaking option change with migration notes.

