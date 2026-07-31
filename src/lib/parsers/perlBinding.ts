import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Lazy shim around tree-sitter-perl's broken ESM wrapper.
 *
 * tree-sitter-perl ships an ESM index.js with top-level `await` but omits
 * `"type": "module"` from its package.json. tsx/esbuild therefore treats it
 * as CommonJS, which makes top-level await illegal and causes a build error.
 *
 * This shim loads the native binding via node-gyp-build, producing the same
 * object the package would export without the TLA issue. It also attaches
 * nodeTypeInfo, matching what the original wrapper does.
 *
 * **Loading is deferred** — {@link loadPerlBinding} is not called at module
 * evaluation time. tree-sitter-perl ships no prebuilt binaries; it must be
 * compiled per-platform by node-gyp. If the compilation fails or produces a
 * binary for the wrong ABI, loading it crashes the process with a SIGSEGV
 * that cannot be caught. Deferring the load to first use ensures a broken
 * Perl binding never prevents the app from starting.
 */
const require = createRequire(import.meta.url);
const pkgPath = require.resolve('tree-sitter-perl/package.json');
const root = dirname(pkgPath);
const loadBinding = require('node-gyp-build');

let _binding: any = null;

/** Load the Perl tree-sitter native binding on first call, then cache. */
export function loadPerlBinding(): any {
  if (_binding) return _binding;
  _binding = loadBinding(root);
  try {
    _binding.nodeTypeInfo = JSON.parse(
      readFileSync(join(root, 'src', 'node-types.json'), 'utf8'),
    );
  } catch {}
  return _binding;
}
