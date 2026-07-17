export const PERL_QUERIES = {
  exports: `
    (package_statement name: (package) @export.name) @export

    (subroutine_declaration_statement name: (bareword) @export.name) @export
  `,

  symbols: `
    (package_statement name: (package) @symbol.name) @symbol.decl

    (subroutine_declaration_statement name: (bareword) @symbol.name) @symbol.decl
  `,

  imports: `
    (use_statement module: (package) @import.source) @import
  `,

  extendsClause: ``,

  identifiers: `
    (bareword) @identifier
    (package) @identifier
  `,
} as const;
