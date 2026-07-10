export const TYPESCRIPT_QUERIES = {
  exports: `
    (export_statement
      declaration: [
        (function_declaration name: (identifier) @export.name)
        (class_declaration name: (type_identifier) @export.name)
        (interface_declaration name: (type_identifier) @export.name)
        (type_alias_declaration name: (type_identifier) @export.name)
        (enum_declaration name: (identifier) @export.name)
        (variable_declaration (variable_declarator name: (identifier) @export.name))
        (lexical_declaration (variable_declarator name: (identifier) @export.name))
      ])

    (export_statement
      (export_clause
        (export_specifier name: (identifier) @export.name)))
  `,

  symbols: `
    (function_declaration name: (identifier) @symbol.name) @symbol.decl

    (class_declaration name: (type_identifier) @symbol.name) @symbol.decl

    (method_definition name: (property_identifier) @symbol.name) @symbol.decl

    (variable_declaration
      (variable_declarator
        name: (identifier) @symbol.name
        value: [(arrow_function) (function_expression)])) @symbol.decl

    (lexical_declaration
      (variable_declarator
        name: (identifier) @symbol.name
        value: [(arrow_function) (function_expression)])) @symbol.decl
  `,

  extendsClause: `
    (class_declaration
      name: (type_identifier) @class.name
      (class_heritage
        (extends_clause value: (_) @class.extends))?) @class
  `,

  identifiers: `
    (identifier) @identifier
  `,
} as const;
