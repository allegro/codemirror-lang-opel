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

const OPEL_METHODS = [
    {
        label: 'format',
        detail: 'Format a value',
        info: 'Format a string or number',
    },
    {
        label: 'hasNoFractionalPart',
        detail: 'Check decimal',
        info: 'Check if number has no fractional part',
    },
    {
        label: 'size',
        detail: 'Get collection size',
        info: 'Get the size of a collection',
    },
    {
        label: 'toString',
        detail: 'Convert to string',
        info: 'Convert value to string representation',
    },
    {
        label: 'replaceFirst',
        detail: 'Replace first occurrence',
        info: 'Replace first occurrence of a pattern',
    },
    {
        label: 'contains',
        detail: 'Check if contains',
        info: 'Check if collection or string contains an element/substring',
    },
    {
        label: 'length',
        detail: 'Get string length',
        info: 'Get the length of a string',
    },
    {
        label: 'addAll',
        detail: 'Add all elements',
        info: 'Add all elements from another collection',
    },
    {
        label: 'startsWith',
        detail: 'Check prefix',
        info: 'Check if string starts with a prefix',
    },
    {
        label: 'get',
        detail: 'Get element',
        info: 'Get element at index',
    },
    {
        label: 'charAt',
        detail: 'Get character',
        info: 'Get character at position',
    },
    {
        label: 'substring',
        detail: 'Extract substring',
        info: 'Extract a portion of a string',
    },
    {
        label: 'trim',
        detail: 'Remove whitespace',
        info: 'Remove leading and trailing whitespace',
    },
    {
        label: 'toLowerCase',
        detail: 'Convert to lowercase',
        info: 'Convert string to lowercase',
    },
    {
        label: 'toUpperCase',
        detail: 'Convert to uppercase',
        info: 'Convert string to uppercase',
    },
    {
        label: 'replace',
        detail: 'Replace all',
        info: 'Replace all occurrences of a pattern',
    },
    {
        label: 'split',
        detail: 'Split string',
        info: 'Split string into array',
    },
    {
        label: 'join',
        detail: 'Join elements',
        info: 'Join collection elements into a string',
    },
    {
        label: 'filter',
        detail: 'Filter elements',
        info: 'Filter collection based on predicate',
    },
    {
        label: 'map',
        detail: 'Transform elements',
        info: 'Transform each element in collection',
    },
    {
        label: 'reduce',
        detail: 'Reduce collection',
        info: 'Reduce collection to single value',
    },
    {
        label: 'find',
        detail: 'Find element',
        info: 'Find first element matching predicate',
    },
    {
        label: 'isEmpty',
        detail: 'Check if empty',
        info: 'Check if collection or string is empty',
    },
];

/**
 * Creates an autocomplete extension for OPEL with support for custom builtin functions
 */
export function opelCompletions(builtinFunctions: string[] = []) {
    // Convert builtin functions to completion items
    const functionCompletions = builtinFunctions.map((name) => ({
        label: name,
        type: 'function',
        apply: `${name}()`,
        detail: 'builtin function',
    }));

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
                const varName = context.state.doc.sliceString(
                    node.from,
                    node.to
                );
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
                options: OPEL_METHODS,
            };
        }

        // Default: suggest keywords, functions, and variables
        return {
            from: word.from,
            options: [
                ...OPEL_KEYWORDS,
                ...functionCompletions,
                ...variableCompletions,
            ],
        };
    };
}
