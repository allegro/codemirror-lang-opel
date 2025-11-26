import { syntaxTree } from '@codemirror/language';
import { Diagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';

/**
 * Find similar terms based on substring matching of the first 3 characters
 * @param term The term to find suggestions for
 * @param candidates List of possible suggestions
 * @param maxResults Maximum number of suggestions to return (default: 3)
 * @returns Array of similar terms
 */
function findSimilarTerms(
  term: string,
  candidates: string[],
  maxResults: number = 3
): string[] {
  if (term.length < 3) {
    return [];
  }

  const searchTerm = term.toLowerCase().substring(0, 3);
  return candidates
    .filter((candidate) => candidate.toLowerCase().includes(searchTerm))
    .slice(0, maxResults);
}

export function opelLinter(
  { builtinFunctions }: { builtinFunctions: string[] } = {
    builtinFunctions: [],
  }
) {
  return (view: EditorView) => {
    const diagnostics: Diagnostic[] = [];
    const doc = view.state.doc;
    const declaredVariables: string[] = [];

    const tree = syntaxTree(view.state);

    // First pass: collect all declared variables
    tree.cursor().iterate((node) => {
      if (node.name === 'VariableName') {
        const varName = doc.sliceString(node.from, node.to);
        if (declaredVariables.includes(varName)) {
          diagnostics.push({
            from: node.from,
            to: node.to,
            severity: 'warning',
            message: `Variable "${varName}" is already declared`,
          });
        } else {
          declaredVariables.push(varName);
        }
      }
    });

    // Second pass: check for errors
    tree.cursor().iterate((node) => {
      switch (node.name) {
        case '⚠': {
          // Parse error node
          const errorText = doc.sliceString(node.from, node.to);
          const context = doc.sliceString(
            Math.max(0, node.from - 20),
            Math.min(doc.length, node.to + 20)
          );

          // Provide helpful error messages based on context
          let message = 'Syntax error';

          // Check for common syntax errors
          if (context.includes('val') && !context.includes(';')) {
            message =
              'Variable declaration requires a semicolon at the end. Use: val name = value;';
          } else if (
            errorText === ')' ||
            (context.includes('LParen') && !context.includes('RParen'))
          ) {
            message =
              'Unclosed parenthesis. Make sure all opening parentheses have matching closing ones';
          } else if (
            errorText === ']' ||
            (context.includes('LBracket') && !context.includes('RBracket'))
          ) {
            message =
              'Unclosed bracket. Make sure all opening brackets have matching closing ones';
          } else if (
            errorText === '}' ||
            (context.includes('LBrace') && !context.includes('RBrace'))
          ) {
            message =
              'Unclosed brace. Make sure all opening braces have matching closing ones';
          } else {
            message = `Unexpected "${errorText}". Please check your syntax`;
          }

          diagnostics.push({
            from: node.from,
            to: node.to,
            severity: 'error',
            message,
          });
          return;
        }

        case 'FunctionName': {
          const functionName = doc.sliceString(node.from, node.to);
          if (
            !builtinFunctions.includes(functionName) &&
            !declaredVariables.includes(functionName)
          ) {
            const availableFunctions = findSimilarTerms(
              functionName,
              builtinFunctions
            );

            let message = `Unknown function "${functionName}"`;
            if (availableFunctions.length > 0) {
              message += `. Did you mean: ${availableFunctions.join(', ')}?`;
            }

            diagnostics.push({
              from: node.from,
              to: node.to,
              severity: 'error',
              message,
            });
          }
          return;
        }

        case 'MethodName': {
          const methodName = doc.sliceString(node.from, node.to);
          // Check against allowed methods
          const allowedMethods = [
            'format',
            'hasNoFractionalPart',
            'size',
            'toString',
            'replaceFirst',
            'contains',
            'length',
            'addAll',
            'startsWith',
            'get',
            'charAt',
            'substring',
            'trim',
            'toLowerCase',
            'toUpperCase',
            'replace',
            'split',
            'join',
            'filter',
            'map',
            'reduce',
            'find',
            'isEmpty',
          ];

          if (!allowedMethods.includes(methodName)) {
            const suggestions = findSimilarTerms(methodName, allowedMethods);

            let message = `Method "${methodName}" may not be available`;
            if (suggestions.length > 0) {
              message += `. Did you mean: ${suggestions.join(', ')}?`;
            }

            diagnostics.push({
              from: node.from,
              to: node.to,
              severity: 'warning',
              message,
            });
          }
          return;
        }

        case 'Identifier': {
          const identifierName = doc.sliceString(node.from, node.to);

          // Skip reserved keywords and literals
          if (['true', 'false', 'null'].includes(identifierName)) {
            return;
          }

          // Check if identifier is in a context where it should be ignored
          const parent = node.node.parent;
          if (!parent) {
            return;
          }

          const ignoredParents = [
            'FunctionName',
            'MethodName',
            'FieldName',
            'VariableName',
            'FieldAccess',
            'Declaration',
            'LambdaParams',
            'SingleParam',
            'MultiParam',
          ];

          if (ignoredParents.includes(parent.name)) {
            return;
          }

          // Check if it's accessing a property (obj.property)
          const grandParent = parent.parent;
          if (grandParent && grandParent.name === 'FieldAccess') {
            return;
          }

          // Check if variable is declared
          if (!declaredVariables.includes(identifierName)) {
            const similarVars = findSimilarTerms(
              identifierName,
              declaredVariables
            );

            let message = `Variable "${identifierName}" is not declared.`;
            if (similarVars.length > 0) {
              message += ` Did you mean: ${similarVars.join(', ')}?`;
            } else {
              message += ` Declare it with: val ${identifierName} = value;`;
            }

            diagnostics.push({
              from: node.from,
              to: node.to,
              severity: 'error',
              message,
            });
          }
          return;
        }

        case 'Declaration': {
          // Check if declaration is followed by a semicolon
          const nextChar = doc.sliceString(node.to, node.to + 1);
          if (nextChar !== ';' && nextChar !== '' && nextChar.trim() !== '') {
            diagnostics.push({
              from: node.to,
              to: node.to,
              severity: 'error',
              message: 'Variable declaration must end with a semicolon (;)',
            });
          }
          return;
        }

        default:
          return;
      }
    });

    return diagnostics;
  };
}
