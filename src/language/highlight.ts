import { styleTags, tags as t } from '@lezer/highlight';

export const opelHighlighting = styleTags({
  // OPEL Keywords
  val: t.definitionKeyword,
  if: t.controlKeyword,
  else: t.controlKeyword,

  // OPEL Literals
  BooleanLiteral: t.bool,
  NullLiteral: t.null,
  IntegerLiteral: t.integer,
  FloatingPointLiteral: t.float,
  StringLiteral: t.string,

  // OPEL Identifiers and Names
  Identifier: t.variableName,
  NamedValue: t.variableName,
  VariableName: t.definition(t.variableName), // Variable names in declarations

  // OPEL Function-related - now with separate function name highlighting
  FunctionCall: t.function(t.variableName),
  FunctionName: t.function(t.name),
  MethodCall: t.function(t.variableName),
  MethodName: t.function(t.propertyName),
  FieldName: t.propertyName, // Field access like obj.field
  FunctionInstantiation: t.function(t.variableName),
  LambdaParams: t.variableName,
  SingleParam: t.variableName,
  MultiParam: t.variableName,

  // OPEL logical and comparison operators
  LogicalOr: t.logicOperator,
  LogicalAnd: t.logicOperator,
  EqualityOp: t.compareOperator,
  InequalityOp: t.compareOperator,
  GreaterThan: t.compareOperator,
  GreaterThanOrEqual: t.compareOperator,
  LessThan: t.compareOperator,
  LessThanOrEqual: t.compareOperator,

  // Arithmetic operators
  Plus: t.arithmeticOperator,
  Minus: t.arithmeticOperator,
  Multiply: t.arithmeticOperator,
  Divide: t.arithmeticOperator,

  // Other operators
  Not: t.operator,
  Assign: t.definitionOperator,
  Arrow: t.punctuation,

  // Delimiters
  LParen: t.paren,
  RParen: t.paren,
  LBracket: t.squareBracket,
  RBracket: t.squareBracket,
  LBrace: t.brace,
  RBrace: t.brace,
  Dot: t.derefOperator,
  Comma: t.separator,
  Semicolon: t.separator,
  Colon: t.punctuation,

  // OPEL Punctuation (using standard lezer bracket notation)
  '( )': t.paren,
  '[ ]': t.squareBracket,
  '{ }': t.brace,
});
