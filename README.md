# @allegro/codemirror-lang-opel

OPEL language support for CodeMirror — syntax highlighting, indentation, folding, autocomplete, and linting.

## Installation

```sh
npm install @allegro/codemirror-lang-opel
```

## Usage

### Quick start

```ts
import { opelExtensions } from '@allegro/codemirror-lang-opel';

const extensions = opelExtensions();
```

### With `EditorView`

```ts
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { opelExtensions } from '@allegro/codemirror-lang-opel';

const state = EditorState.create({
  doc: 'if (true) { val x = 1 }',
  extensions: opelExtensions({
    enableLinter: true,
    includeLintGutter: true,
    warnOnLambdaDefinitions: true,
    runtime: {
      globals: { ctx: true, env: true },
    },
  }),
});

new EditorView({
  state,
  parent: document.querySelector('#editor')!,
});
```

Available options:

- `enableLinter` (default: `true`)
- `includeLintGutter` (default: `true`)
- `warnOnLambdaDefinitions` (default: `true`) — emits a linter warning for each lambda definition.
- `runtime` (default: absent) — validated runtime globals, functions, methods, and schemas used by linting.

`runtimeGlobals` was removed. Migrate each name to `runtime.globals`, for example `{ runtime: { globals: { ctx: true } } }`.

### Runtime metadata

Runtime functions and methods are declared with callable signatures. Use `schema: true` for an unconstrained value and `optional: true` for an optional trailing parameter:

```ts
import { opelExtensions } from '@allegro/codemirror-lang-opel';
import type { OpelRuntime } from '@allegro/codemirror-lang-opel';

const runtime = {
  functions: {
    readSetting: {
      signatures: [
        {
          parameters: [
            { name: 'name', schema: { type: 'string' } },
            { name: 'fallback', schema: true, optional: true },
          ],
          returns: { type: 'string' },
        },
      ],
    },
    now: {
      signatures: [{ parameters: [], returns: { $ref: 'CalendarInstant' } }],
    },
  },
  schemas: {
    CalendarInstant: {},
  },
  methods: {
    string: {
      length: {
        signatures: [{ parameters: [], returns: { type: 'integer' } }],
      },
    },
    CalendarInstant: {
      plusDays: {
        signatures: [
          {
            parameters: [{ name: 'days', schema: { type: 'integer' } }],
            returns: { $ref: 'CalendarInstant' },
          },
        ],
      },
      formatIso: {
        signatures: [
          {
            parameters: [{ name: 'pattern', schema: { type: 'string' } }],
            returns: { type: 'string' },
          },
        ],
      },
    },
  },
} satisfies OpelRuntime;

const extensions = opelExtensions({
  runtime,
  onRuntimeIssues: (issues) => console.error(issues),
});
```

The named receiver above makes these expressions type-check:

```text
now().plusDays(1).formatIso('yyyy-MM-dd')
'hello'.length()
readSetting('theme', 'dark')
```

A method receiver can be a primitive type such as `string` or `integer`, or the exact name of a schema in `runtime.schemas`. Returning the same `$ref` preserves the named type for chained calls.

## Development

### Prerequisites

Node ≥ 22 and npm ≥ 10.

### Start dev mode

```sh
npm run dev
```

This command:

1. Regenerates the Lezer parser from `src/grammar/opel.grammar` once at startup.
2. Starts Storybook at [http://localhost:6006](http://localhost:6006) for an interactive playground.
3. Watches `src/grammar/opel.grammar` — any grammar change automatically reruns `generate-parser`, which Vite hot-reloads into the running stories.

### Grammar-only watcher

```sh
npm run generate-parser:watch
```

### Build

```sh
npm run build
```

Runs parser generation, TypeScript type-check, and Rollup bundling. Output goes to `dist/`.

### Stories

Stories live in `examples/storybook/stories/` and import directly from `src/`, so parser changes are immediately reflected without a separate build step.
Each story category file also generates its own Docs page (`autodocs`), so `OPEL/Basic Expressions`, `OPEL/If Else`, etc. have separate category-level documentation.

| Story group           | What it shows                                 |
| --------------------- | --------------------------------------------- |
| Basic Expressions     | Arithmetic, string concat, comparisons        |
| Variable Declarations | `val` declarations, scope, duplicate warning  |
| If Else               | Conditional expressions, nesting              |
| Linting               | Syntax errors, undeclared variables, warnings |
