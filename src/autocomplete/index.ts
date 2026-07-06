import { syntaxTree } from '@codemirror/language';
import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { OPEL_KEYWORD_COMPLETIONS } from '../syntax/constants';

/**
 * Creates an autocomplete extension for OPEL
 */
export function opelCompletions() {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }

    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);

    // Get all declared variables from declarations in the document.
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
    let charBeforeWord: string | null = null;
    for (let i = word.from - 1; i >= 0; i--) {
      const char = context.state.sliceDoc(i, i + 1);
      if (!/\s/.test(char)) {
        charBeforeWord = char;
        break;
      }
    }
    const isAfterDot =
      charBeforeWord === '.' ||
      nodeBefore.name === 'Dot' ||
      parent?.name === 'Train' ||
      parent?.name === 'FieldAccess' ||
      parent?.name === 'MethodCall';

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
      options: [...OPEL_KEYWORD_COMPLETIONS, ...variableCompletions],
    };
  };
}
