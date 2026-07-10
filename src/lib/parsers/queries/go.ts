export const GO_QUERIES = {
  exports: `
    (function_declaration name: (identifier) @export.name)

    (method_declaration name: (field_identifier) @export.name)

    (type_declaration
      (type_spec name: (type_identifier) @export.name))

    (var_declaration
      (var_spec name: (identifier) @export.name))

    (const_declaration
      (const_spec name: (identifier) @export.name))
  `,

  symbols: `
    (function_declaration name: (identifier) @symbol.name) @symbol.decl

    (method_declaration name: (field_identifier) @symbol.name) @symbol.decl

    (type_declaration
      (type_spec
        name: (type_identifier) @symbol.name
        type: (struct_type))) @symbol.decl

    (type_declaration
      (type_spec
        name: (type_identifier) @symbol.name
        type: (interface_type))) @symbol.decl
  `,

  extendsClause: ``,

  identifiers: `
    (identifier) @identifier
    (field_identifier) @identifier
    (type_identifier) @identifier
  `,
} as const;
