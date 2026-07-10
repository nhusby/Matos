export const PERL_QUERIES = {
  exports: `
    (package_statement name: (package_name) @export.name) @export

    (subroutine_declaration_statement name: (identifier) @export.name) @export
  `,

  symbols: `
    (package_statement name: (package_name) @symbol.name) @symbol.decl

    (subroutine_declaration_statement name: (identifier) @symbol.name) @symbol.decl
  `,

  imports: `
    (use_statement (string) @import.source) @import

    (use_statement (package_name) @import.symbol) @import
  `,

  extendsClause: ``,

  identifiers: `
    (identifier) @identifier
    (package_name) @identifier
  `,
} as const;
