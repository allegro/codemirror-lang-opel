import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import type { OpelOptions } from '../types';
import { analyzeDelimiters, unsupportedLogicalKeywordNear } from './delimiters';
import { resolveParseErrorMessage } from './parse-error-message';
import { findSimilarTerms } from './similar-terms';

type ActiveScope = { id: number; declared: Set<string> };

function isScopeNode(name: string): boolean {
  return (
    name === 'Program' ||
    name === 'BlockExpression' ||
    name === 'FunctionInstantiation'
  );
}

function collectDeclarationName(
  nodeName: string,
  syntaxNode: SyntaxNode
): SyntaxNode | null {
  if (nodeName === 'Declaration') {
    return syntaxNode.getChild('VariableName')?.getChild('Identifier') ?? null;
  }
  if (nodeName === 'SingleParam') {
    return syntaxNode.getChild('Identifier');
  }
  return null;
}

function addDeclarationPosition(
  declarationsByScope: Map<number, Map<string, number[]>>,
  scopeId: number,
  name: string,
  position: number
) {
  let declarations = declarationsByScope.get(scopeId);
  if (!declarations) {
    declarations = new Map<string, number[]>();
    declarationsByScope.set(scopeId, declarations);
  }

  const positions = declarations.get(name) ?? [];
  positions.push(position);
  declarations.set(name, positions);
}

function isDeclared(scopeStack: ActiveScope[], name: string): boolean {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    if (scopeStack[i].declared.has(name)) {
      return true;
    }
  }
  return false;
}

function hasDeclarationInAccessibleScopes(
  declarationsByScope: Map<number, Map<string, number[]>>,
  scopeStack: ActiveScope[],
  name: string
): boolean {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    if (declarationsByScope.get(scopeStack[i].id)?.has(name)) {
      return true;
    }
  }
  return false;
}

function nextNonWhitespaceChar(source: string, start: number): string | null {
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

function isInsideNode(node: SyntaxNodeRef, type: string): boolean {
  let current = node.node as SyntaxNode | null;
  while (current) {
    if (current.parent?.name === type) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function opelLinter(options: OpelOptions = {}) {
  return (view: EditorView) => {
    const diagnostics: Diagnostic[] = [];
    const doc = view.state.doc;
    const source = doc.toString();
    const delimiterAnalysis = analyzeDelimiters(source);
    const seenVariables: string[] = [];

    const tree = syntaxTree(view.state);
    const allDeclarationsByScope = new Map<number, Map<string, number[]>>();

    // First pass: gather all declarations in each scope (independent of order).
    let scanScopeId = 0;
    const scanScopeStack: number[] = [];

    tree.cursor().iterate(
      (node) => {
        if (isScopeNode(node.name)) {
          const id = scanScopeId++;
          allDeclarationsByScope.set(id, new Map());
          scanScopeStack.push(id);
        }

        const scopeId = scanScopeStack[scanScopeStack.length - 1];
        if (scopeId === undefined) {
          return;
        }

        if (node.name === 'MultiParam') {
          for (const param of node.node.getChildren('Identifier')) {
            const paramName = doc.sliceString(param.from, param.to);
            addDeclarationPosition(
              allDeclarationsByScope,
              scopeId,
              paramName,
              param.from
            );
          }
          return;
        }

        if (node.name === 'Declaration' || node.name === 'SingleParam') {
          const declarationNode = collectDeclarationName(node.name, node.node);
          if (declarationNode) {
            const declarationName = doc.sliceString(
              declarationNode.from,
              declarationNode.to
            );
            addDeclarationPosition(
              allDeclarationsByScope,
              scopeId,
              declarationName,
              declarationNode.from
            );
          }
        }
      },
      (node) => {
        if (isScopeNode(node.name)) {
          scanScopeStack.pop();
        }
      }
    );

    const scopeStack: ActiveScope[] = [];
    function currentScope(): ActiveScope | undefined {
      return scopeStack[scopeStack.length - 1];
    }

    function declare(name: string, node: { from: number; to: number }) {
      const scope = currentScope()?.declared;
      if (!scope) {
        return;
      }
      if (scope.has(name)) {
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: 'error',
          message: `Variable "${name}" is already declared`,
        });
        return;
      }

      scope.add(name);
      seenVariables.push(name);
    }

    let runtimeScopeId = 0;
    tree.cursor().iterate(
      (node) => {
        if (isScopeNode(node.name)) {
          scopeStack.push({ id: runtimeScopeId++, declared: new Set() });
        }

        if (node.name === 'Identifier') {
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
            'MethodCall',
            'Declaration',
            'LambdaParams',
            'SingleParam',
            'MultiParam',
          ];

          if (ignoredParents.includes(parent.name)) {
            return;
          }

          if (
            parent.name === 'NamedValue' &&
            nextNonWhitespaceChar(source, node.to) === '('
          ) {
            return;
          }

          // Check if it's accessing a property (obj.property)
          const grandParent = parent.parent;
          if (grandParent && grandParent.name === 'FieldAccess') {
            return;
          }

          if (!isDeclared(scopeStack, identifierName)) {
            let message = '';

            if (
              hasDeclarationInAccessibleScopes(
                allDeclarationsByScope,
                scopeStack,
                identifierName
              )
            ) {
              message = `Variable "${identifierName}" is used before declaration.`;
            } else {
              const similarVars = findSimilarTerms(identifierName, seenVariables);
              message = `Variable "${identifierName}" is not declared.`;
              if (similarVars.length > 0) {
                message += ` Did you mean: ${similarVars.join(', ')}?`;
              } else {
                message += ` Declare it with: val ${identifierName} = value;`;
              }
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

        if (node.name === '⚠') {
          const errorText = doc.sliceString(node.from, node.to);
          const context = doc.sliceString(
            Math.max(0, node.from - 20),
            Math.min(doc.length, node.to + 20)
          );
          const logicalKeyword = unsupportedLogicalKeywordNear(
            source,
            node.from,
            node.to
          );
          const isNearEnd = node.to >= doc.length - 1;
          const isEmptyOrWhitespace = errorText.trim() === '';

          const message = resolveParseErrorMessage({
            errorText,
            context,
            isNearEnd,
            isEmptyOrWhitespace,
            isMissingElseBranch:
              isNearEnd && isEmptyOrWhitespace && isInsideNode(node.node, 'IfExpression'),
            delimiterAnalysis,
            logicalKeyword,
            nodeFrom: node.from,
            nodeTo: node.to,
          });

          diagnostics.push({
            from: node.from,
            to: node.to,
            severity: 'error',
            message,
          });
        }
      },
      (node) => {
        if (node.name === 'Declaration' || node.name === 'SingleParam') {
          const declarationNode = collectDeclarationName(node.name, node.node);
          if (declarationNode) {
            declare(
              doc.sliceString(declarationNode.from, declarationNode.to),
              declarationNode
            );
          }
        } else if (node.name === 'MultiParam') {
          for (const param of node.node.getChildren('Identifier')) {
            declare(doc.sliceString(param.from, param.to), param);
          }
        }

        if (isScopeNode(node.name)) {
          scopeStack.pop();
        }
      }
    );

    tree.cursor().iterate((node) => {
      if (node.name === 'Declaration') {
        // Check whether declaration itself ends with a semicolon.
        const lastChar = doc.sliceString(node.to - 1, node.to);
        if (lastChar !== ';') {
          diagnostics.push({
            from: Math.max(node.from, node.to - 1),
            to: node.to,
            severity: 'error',
            message: 'Variable declaration must end with a semicolon (;)',
          });
        }
      }
    });

    return diagnostics;
  };
}
