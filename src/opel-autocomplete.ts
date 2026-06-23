import { syntaxTree } from '@codemirror/language';
import { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

const OPEL_KEYWORDS = [
  { label: 'val', type: 'keyword', detail: 'variable declaration' },
  { label: 'if', type: 'keyword', detail: 'conditional expression' },
  { label: 'else', type: 'keyword', detail: 'alternative branch' },
  { label: 'true', type: 'keyword', detail: 'boolean literal' },
  { label: 'false', type: 'keyword', detail: 'boolean literal' },
  { label: 'null', type: 'keyword', detail: 'null literal' },
];

/**
 * Creates an autocomplete extension for OPEL
 */
export function opelCompletions() {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\w*/);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }

    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);

    // Get all declared variables in the current scope
    const declaredVariables: string[] = [];
    tree.cursor().iterate((node) => {
      if (node.name === 'VariableName') {
        const varName = context.state.doc.sliceString(node.from, node.to);
        if (!declaredVariables.includes(varName)) {
          declaredVariables.push(varName);
        }
      }
    });

    const variableCompletions = declaredVariables.map((name) => ({
      label: name,
      type: 'variable',
      detail: 'declared variable',
    }));

    // Check context to determine what to suggest
    const parent = nodeBefore.parent;
    const isAfterDot = parent && parent.name === 'Train';

    if (isAfterDot) {
      // After a dot, suggest methods
      return {
        from: word.from,
        options: [],
      };
    }

    // Default: suggest keywords and variables
    return {
      from: word.from,
      options: [...OPEL_KEYWORDS, ...variableCompletions],
    };
  };
}
