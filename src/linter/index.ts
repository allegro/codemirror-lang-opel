import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import type { OpelOptions } from '../types';
import { createRuntimeContext } from '../runtime';
import { analyzeRuntimeSemantics } from './semantics';
import { analyzeDelimiters, unsupportedLogicalKeywordNear } from './delimiters';
import { resolveParseErrorMessage } from './parse-error-message';
import { OPEL_NODE_NAMES as NODE } from '../syntax/nodes';

type ActiveScope = { id: number; declared: Set<string> };

function isScopeNode(name: string): boolean {
  return (
    name === NODE.Program ||
    name === NODE.BlockExpression ||
    name === NODE.FunctionInstantiation
  );
}

function collectDeclarationName(
  nodeName: string,
  syntaxNode: SyntaxNode
): SyntaxNode | null {
  if (nodeName === NODE.Declaration) {
    return (
      syntaxNode.getChild(NODE.VariableName)?.getChild(NODE.Identifier) ?? null
    );
  }
  if (nodeName === NODE.SingleParam) {
    return syntaxNode.getChild(NODE.Identifier);
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
  const { warnOnLambdaDefinitions = true } = options;
  const runtimeContext = createRuntimeContext(
    options.runtime,
    options.onRuntimeIssues
  );
  const runtimeNames = new Set([
    ...Object.keys(runtimeContext.runtime.globals ?? {}),
    ...Object.keys(runtimeContext.runtime.functions ?? {}),
  ]);

  return (view: EditorView) => {
    const diagnostics: Diagnostic[] = [];
    const doc = view.state.doc;
    const source = doc.toString();
    const delimiterAnalysis = analyzeDelimiters(source);
    const usedBeforeDeclarationPositions = new Set<number>();

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

        if (node.name === NODE.MultiParam) {
          for (const param of node.node.getChildren(NODE.Identifier)) {
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

        if (node.name === NODE.Declaration || node.name === NODE.SingleParam) {
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
    }

    let runtimeScopeId = 0;
    tree.cursor().iterate(
      (node) => {
        if (isScopeNode(node.name)) {
          scopeStack.push({ id: runtimeScopeId++, declared: new Set() });
        }

        if (node.name === NODE.Identifier) {
          const identifierName = doc.sliceString(node.from, node.to);

          // Skip reserved keywords and literals
          if (['true', 'false', 'null'].includes(identifierName)) {
            return;
          }
          if (runtimeNames.has(identifierName)) {
            return;
          }

          // Check if identifier is in a context where it should be ignored
          const parent = node.node.parent;
          if (!parent) {
            return;
          }

          const ignoredParents: string[] = [
            NODE.FunctionName,
            NODE.MethodName,
            NODE.FieldName,
            NODE.FunctionCall,
            NODE.VariableName,
            NODE.FieldAccess,
            NODE.MethodCall,
            NODE.Declaration,
            NODE.LambdaParams,
            NODE.SingleParam,
            NODE.MultiParam,
          ];

          if (ignoredParents.includes(parent.name)) {
            return;
          }

          if (
            parent.name === NODE.NamedValue &&
            nextNonWhitespaceChar(source, node.to) === '('
          ) {
            return;
          }

          // Check if it's accessing a property (obj.property)
          const grandParent = parent.parent;
          if (grandParent && grandParent.name === NODE.FieldAccess) {
            return;
          }

          if (!isDeclared(scopeStack, identifierName)) {
            const usedBeforeDeclaration = hasDeclarationInAccessibleScopes(
              allDeclarationsByScope,
              scopeStack,
              identifierName
            );

            if (usedBeforeDeclaration) {
              usedBeforeDeclarationPositions.add(node.from);
              diagnostics.push({
                from: node.from,
                to: node.to,
                severity: 'error',
                message: `Variable "${identifierName}" is used before declaration.`,
              });
            }
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
              isNearEnd &&
              isEmptyOrWhitespace &&
              isInsideNode(node.node, NODE.IfExpression),
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
          return;
        }

        if (
          node.name === NODE.FunctionInstantiation &&
          warnOnLambdaDefinitions
        ) {
          diagnostics.push({
            from: node.from,
            to: node.to,
            severity: 'warning',
            message:
              'Lambda definition detected. Avoid lambda definitions if possible.',
          });
        }
      },
      (node) => {
        if (node.name === NODE.Declaration || node.name === NODE.SingleParam) {
          const declarationNode = collectDeclarationName(node.name, node.node);
          if (declarationNode) {
            declare(
              doc.sliceString(declarationNode.from, declarationNode.to),
              declarationNode
            );
          }
        } else if (node.name === NODE.MultiParam) {
          for (const param of node.node.getChildren(NODE.Identifier)) {
            declare(doc.sliceString(param.from, param.to), param);
          }
        }

        if (isScopeNode(node.name)) {
          scopeStack.pop();
        }
      }
    );

    tree.cursor().iterate((node) => {
      if (node.name === NODE.Declaration) {
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

    diagnostics.push(
      ...analyzeRuntimeSemantics(tree.topNode, source, runtimeContext, {
        suppressUnknownIdentifierAt: usedBeforeDeclarationPositions,
      })
    );

    return diagnostics;
  };
}
