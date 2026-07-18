#!/usr/bin/env node
// Entry-point shim: boots the TypeScript CLI under tsx so that `matos`
// works from any directory without a separate build step.  Everything is
// resolved relative to this package, never the caller's cwd, so the tsx
// loader and source files are always found.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'src', 'cli.ts');

// Resolve tsx from *our* package so it works even when invoked from a
// project that doesn't have tsx installed.
const require = createRequire(import.meta.url);
const tsxPath = require.resolve('tsx');

const child = spawn(
  process.execPath,
  ['--import', tsxPath, cliPath, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
