export interface OpelOptions {
  warnOnLambdaDefinitions?: boolean;
}

export interface OpelExtensionsOptions extends OpelOptions {
  enableLinter?: boolean;
  includeLintGutter?: boolean;
}
