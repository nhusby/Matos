declare module 'bash-parser' {
  /**
   * Parse a bash source string into an AST.  Only the subset of node types we
   * rely on is sketched here; consumers duck-type the rest as `any`.
   *
   * Top-level shape: `{ type: 'Script', commands: AstNode[] }`.
   */
  interface Word {
    type: string;
    text: string;
  }

  interface Redirect {
    type: 'Redirect';
    op: Word;
    file: Word;
  }

  interface Command {
    type: 'Command';
    name?: Word;
    suffix?: Array<Word | Redirect>;
    prefix?: Word[];
  }

  interface Pipeline {
    type: 'Pipeline';
    commands: AstNode[];
  }

  interface LogicalExpression {
    type: 'LogicalExpression';
    op: 'and' | 'or';
    left: AstNode;
    right: AstNode;
  }

  interface Script {
    type: 'Script';
    commands: AstNode[];
  }

  type AstNode =
    Command | Pipeline | LogicalExpression | Script | Word | Redirect;

  const parse: (source: string) => Script;
  export = parse;
}
