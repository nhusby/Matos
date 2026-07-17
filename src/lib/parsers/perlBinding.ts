import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Shim around tree-sitter-perl's broken ESM wrapper.
 *
 * tree-sitter-perl ships an ESM index.js with top-level `await` but omits
 * `"type": "module"` from its package.json. tsx/esbuild therefore treats it
 * as CommonJS, which makes top-level await illegal and causes a build error.
 *
 * This shim loads the native binding synchronously via node-gyp-build,
 * producing the same object the package would export without the TLA issue.
 * It also attaches nodeTypeInfo, matching what the original wrapper does.
 */
const require = createRequire(import.meta.url);
const pkgPath = require.resolve('tree-sitter-perl/package.json');
const root = dirname(pkgPath);
const loadBinding = require('node-gyp-build');

const binding = loadBinding(root);

try {
  binding.nodeTypeInfo = JSON.parse(
    readFileSync(join(root, 'src', 'node-types.json'), 'utf8'),
  );
} catch {}

export default binding;
