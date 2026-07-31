import type Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import TS from 'tree-sitter-typescript';
import Go from 'tree-sitter-go';
import Py from 'tree-sitter-python';
import { loadPerlBinding } from './perlBinding.js';
import type { Language } from './languages.js';

const require = createRequire(import.meta.url);

let _Parser: typeof Parser | null = null;

/**
 * Lazily load the tree-sitter runtime.
 *
 * tree-sitter compiles a native .node binding via node-gyp. If the binary is
 * missing, built for the wrong ABI, or otherwise corrupt, loading it can
 * crash the process (SIGSEGV) — an error JavaScript cannot catch. Deferring
 * the load to first parse ensures a broken binding prevents only code
 * analysis tools, not app startup. Catchable errors (module not found, etc.)
 * are wrapped with guidance to `npm rebuild tree-sitter`.
 */
export function loadTreeSitter(): typeof Parser {
  if (_Parser) return _Parser;
  try {
    const mod = require('tree-sitter');
    _Parser = (mod.default ?? mod) as typeof Parser;
    return _Parser;
  } catch (e: any) {
    throw new Error(
      `Failed to load tree-sitter native binding. ` +
        `The module may need recompiling: run \`npm rebuild tree-sitter\`. ` +
        `Original error: ${e?.message ?? e}`,
    );
  }
}

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
  const ParserClass = loadTreeSitter();
  const parser = new ParserClass();
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
