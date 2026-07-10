export const PYTHON_QUERIES = {
  exports: `
    (module (function_definition name: (identifier) @export.name))
    (module (class_definition name: (identifier) @export.name))
    (module (expression_statement (assignment left: (identifier) @export.name)))
  `,

  symbols: `
    (function_definition name: (identifier) @symbol.name) @symbol.decl

    (class_definition name: (identifier) @symbol.name) @symbol.decl
  `,

  extendsClause: `
    (class_definition
      name: (identifier) @class.name
      superclasses: (argument_list (identifier) @class.extends)?) @class
  `,

  identifiers: `
    (identifier) @identifier
  `,
} as const;
