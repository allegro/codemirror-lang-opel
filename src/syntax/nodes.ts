/** Lezer node names shared by parsing, linting, highlighting, and completion. */
export const OPEL_NODE_NAMES = {
  Program: 'Program', // The complete OPEL document.
  Body: 'Body', // Declarations followed by the body's final expression.
  Declarations: 'Declarations', // The declarations preceding a body expression.
  Declaration: 'Declaration', // A `val name = expression;` binding.
  VariableName: 'VariableName', // The name being introduced by a declaration.
  FunctionName: 'FunctionName', // The name of a named function call, when present.
  MethodName: 'MethodName', // The name of a method, when present.
  FieldName: 'FieldName', // The name of a field, when present.
  Expression: 'Expression', // Any OPEL expression.
  IfExpression: 'IfExpression', // A conditional `if (...) ... else ...` expression.
  OrExpression: 'OrExpression', // A chain of logical-or expressions.
  AndExpression: 'AndExpression', // A chain of logical-and expressions.
  EqualityExpression: 'EqualityExpression', // An equality or inequality expression.
  RelationalExpression: 'RelationalExpression', // A comparison expression.
  AdditiveExpression: 'AdditiveExpression', // An addition or subtraction expression.
  MultiplyExpression: 'MultiplyExpression', // A multiplication or division expression.
  UnaryExpression: 'UnaryExpression', // A negated or signed expression.
  FunctionInstantiation: 'FunctionInstantiation', // A lambda/function definition.
  FunctionBody: 'FunctionBody', // The expression or block inside a lambda.
  BlockExpression: 'BlockExpression', // A scoped `{ ... }` expression body.
  LambdaParams: 'LambdaParams', // Parameters declared by a lambda.
  SingleParam: 'SingleParam', // A lambda with one parameter.
  MultiParam: 'MultiParam', // A lambda with zero or multiple parameters.
  FunctionCall: 'FunctionCall', // A named function call such as `fn(value)`.
  MethodCall: 'MethodCall', // A receiver method call such as `value.method()`.
  CallGroup: 'CallGroup', // A call applied to an arbitrary expression.
  FieldAccess: 'FieldAccess', // Dot or bracket member access.
  PostfixExpression: 'PostfixExpression', // A base expression followed by postfix access/calls.
  Postfix: 'Postfix', // One chained access or call, such as `.name`, `[key]`, `.method()`, or `(argument)`.
  Primary: 'Primary', // An expression that can be followed by postfix syntax, such as `user` in `user.name` or `makeUser()` in `makeUser().id`.
  Atom: 'Atom', // A self-contained expression, such as `user`, `42`, `"text"`, `[1, 2]`, `{name: "Ada"}`, or `(a + b)`.
  NamedValue: 'NamedValue', // A literal keyword or identifier reference.
  Identifier: 'Identifier', // An OPEL identifier token.
  Number: 'Number', // An integer or floating-point literal.
  StringLiteral: 'StringLiteral', // A quoted string literal.
  ListInstantiation: 'ListInstantiation', // A list literal such as `[a, b]`.
  MapInstantiation: 'MapInstantiation', // An object/map literal such as `{key: value}`.
  ParenthesizedExpression: 'ParenthesizedExpression', // An expression wrapped in parentheses.
  Args: 'Args', // Arguments supplied to a call.
  Pair: 'Pair', // One key/value pair in a map literal.
  Pairs: 'Pairs', // The collection of pairs in a map literal.
  Dot: 'Dot', // The dot operator in member access.
  RParen: 'RParen', // A closing parenthesis marking a complete call.
  LogicalOr: 'LogicalOr', // The `||` logical-or operator.
  LogicalAnd: 'LogicalAnd', // The `&&` logical-and operator.
  EqualityOp: 'EqualityOp', // The `==` equality operator.
  InequalityOp: 'InequalityOp', // The `!=` inequality operator.
  GreaterThan: 'GreaterThan', // The `>` comparison operator.
  GreaterThanOrEqual: 'GreaterThanOrEqual', // The `>=` comparison operator.
  LessThan: 'LessThan', // The `<` comparison operator.
  LessThanOrEqual: 'LessThanOrEqual', // The `<=` comparison operator.
  Plus: 'Plus', // The `+` arithmetic operator.
  Minus: 'Minus', // The `-` arithmetic operator.
  Multiply: 'Multiply', // The `*` arithmetic operator.
  Divide: 'Divide', // The `/` arithmetic operator.
} as const;
