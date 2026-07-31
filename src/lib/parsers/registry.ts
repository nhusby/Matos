import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import Go from 'tree-sitter-go';
import Py from 'tree-sitter-python';
import { loadPerlBinding } from './perlBinding.js';
import type { Language } from './languages.js';

type GrammarWrapper = { language: unknown };

const TS_GRAMMAR = (TS as unknown as { typescript: GrammarWrapper }).typescript;
const TSX_GRAMMAR = (TS as unknown as { tsx: GrammarWrapper }).tsx;
const GO_GRAMMAR = Go as unknown as GrammarWrapper;
const PY_GRAMMAR = Py as unknown as GrammarWrapper;

/**
 * Grammars with multi-platform prebuilds — safe to load eagerly at import
 * time. Perl is excluded; see {@link getParser}.
 */
const STATIC_GRAMMARS: Partial<Record<Language, GrammarWrapper>> = {
  typescript: TS_GRAMMAR,
  tsx: TSX_GRAMMAR,
  go: GO_GRAMMAR,
  python: PY_GRAMMAR,
};

const parsers = new Map<Language, Parser>();

export function getParser(lang: Language): Parser {
  const existing = parsers.get(lang);
  if (existing) return existing;

  let grammar: GrammarWrapper | undefined;
  if (lang === 'perl') {
    // tree-sitter-perl ships no prebuilds — the native binary is compiled
    // per-platform and loaded lazily here so a broken build can't crash the
    // process at startup.
    grammar = loadPerlBinding() as unknown as GrammarWrapper;
  } else {
    grammar = STATIC_GRAMMARS[lang];
  }

  if (!grammar) {
    throw new Error(`No tree-sitter grammar registered for language "${lang}"`);
  }
  const parser = new Parser();
  parser.setLanguage(grammar as any);
  parsers.set(lang, parser);
  return parser;
}

export function isLanguageSupported(lang: Language): boolean {
  return lang === 'perl' || STATIC_GRAMMARS[lang] !== undefined;
}

export function parseSource(lang: Language, source: string): Parser.Tree {
  return getParser(lang).parse(source)!;
}
