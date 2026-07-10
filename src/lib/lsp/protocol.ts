export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface VersionedTextDocumentIdentifier {
  uri: string;
  version: number;
}

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: Array<{ range?: Range; text: string }>;
}

export interface RenameParams extends TextDocumentPositionParams {
  newName: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{
    textDocument: VersionedTextDocumentIdentifier;
    edits: TextEdit[];
  }>;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface Hover {
  contents:
    | string
    | { language: string; value: string }
    | Array<string | { language: string; value: string }>;
}

export interface ServerCapabilities {
  renameProvider?: boolean | { prepareProvider: boolean };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
}

export interface ServerIncompatibleError {
  serverName: string;
}
