import { extractSymbols as extractSymbolsGeneric } from '../parsers/extractors.js';

export interface ExtractedSymbol {
  kind: 'function' | 'method' | 'class';
  name: string;
  sourceText: string;
  filePath: string;
  startLine: number;
  endLine: number;
  className?: string;
}

export function extractSymbols(
  filePath: string,
  content: string,
): ExtractedSymbol[] {
  return extractSymbolsGeneric(filePath, content);
}
