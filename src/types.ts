export interface OpelOptions {
  warnOnLambdaDefinitions?: boolean;
  runtimeGlobals?: readonly string[];
}

export interface OpelExtensionsOptions extends OpelOptions {
  enableLinter?: boolean;
  includeLintGutter?: boolean;
}
