# @allegro/codemirror-lang-opel

OPEL language support for CodeMirror — syntax highlighting, indentation, folding, autocomplete, and linting.

## Usage

```ts
import { opelExtensions } from '@allegro/codemirror-lang-opel';

const extensions = opelExtensions();
```

## Development

### Prerequisites

Node ≥ 22 and npm ≥ 10.

### Start dev mode

```sh
npm run dev
```

This command:

1. Regenerates the Lezer parser from `src/opel.grammar` once at startup.
2. Starts Storybook at [http://localhost:6006](http://localhost:6006) for an interactive playground.
3. Watches `src/opel.grammar` — any grammar change automatically reruns `generate-parser`, which Vite hot-reloads into the running stories.

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

Stories live in `stories/` and import directly from `src/`, so parser changes are immediately reflected without a separate build step.
Each story category file also generates its own Docs page (`autodocs`), so `OPEL/Basic Expressions`, `OPEL/If Else`, etc. have separate category-level documentation.

| Story group           | What it shows                                 |
| --------------------- | --------------------------------------------- |
| Basic Expressions     | Arithmetic, string concat, comparisons        |
| Variable Declarations | `val` declarations, scope, duplicate warning  |
| If Else               | Conditional expressions, nesting              |
| Linting               | Syntax errors, undeclared variables, warnings |
