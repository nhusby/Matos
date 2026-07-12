import { test, expect } from 'bun:test';
import { PassThrough } from 'stream';
import { MultiLineEditor } from '../../lib/MultiLineEditor';

/**
 * Build an editor backed by in-memory streams so we can drive keypress events
 * directly (bypassing the real TTY / raw-mode).
 */
function makeEditor() {
  const input = new PassThrough();
  const output = new PassThrough();
  const editor = new MultiLineEditor({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    prompt: '> ',
  });
  // Drain render output so the buffer doesn't grow unbounded.
  output.on('data', () => {});
  return { editor, input, output };
}

/** Send a synthetic keypress, mirroring what readline emits. */
function send(input: PassThrough, str: string | undefined, key: any) {
  (input as any).emit('keypress', str, key);
}

test('multi-line paste does not submit; content is buffered', () => {
  const { editor, input } = makeEditor();
  const lines: string[] = [];
  editor.on('line', (line: string) => lines.push(line));

  editor.prompt();

  // Simulate a bracketed paste of "hello\r\nworld"
  send(input, undefined, { name: 'paste-start', sequence: '\x1b[200~' });
  send(input, 'h', { name: 'h', sequence: 'h' });
  send(input, 'e', { name: 'e', sequence: 'e' });
  send(input, 'l', { name: 'l', sequence: 'l' });
  send(input, 'l', { name: 'l', sequence: 'l' });
  send(input, 'o', { name: 'o', sequence: 'o' });
  send(input, '\r', { name: 'return', sequence: '\r' });
  send(input, '\n', { name: 'enter', sequence: '\n' });
  send(input, 'w', { name: 'w', sequence: 'w' });
  send(input, 'o', { name: 'o', sequence: 'o' });
  send(input, 'r', { name: 'r', sequence: 'r' });
  send(input, 'l', { name: 'l', sequence: 'l' });
  send(input, 'd', { name: 'd', sequence: 'd' });
  send(input, undefined, { name: 'paste-end', sequence: '\x1b[201~' });

  // No submission should have happened yet.
  expect(lines).toEqual([]);

  // A real Enter (not part of a paste) submits the buffered text.
  send(input, '\r', { name: 'return', sequence: '\r' });
  expect(lines).toEqual(['hello\nworld']);
});

test('paste collapses a CRLF pair into a single line break', () => {
  const { editor, input } = makeEditor();
  const lines: string[] = [];
  editor.on('line', (line: string) => lines.push(line));

  editor.prompt();

  send(input, undefined, { name: 'paste-start', sequence: '\x1b[200~' });
  send(input, 'a', { name: 'a', sequence: 'a' });
  send(input, '\r', { name: 'return', sequence: '\r' });
  send(input, '\n', { name: 'enter', sequence: '\n' });
  send(input, 'b', { name: 'b', sequence: 'b' });
  send(input, undefined, { name: 'paste-end', sequence: '\x1b[201~' });
  send(input, '\r', { name: 'return', sequence: '\r' });

  expect(lines).toEqual(['a\nb']);
});

test('paste with only LF line endings also inserts line breaks', () => {
  const { editor, input } = makeEditor();
  const lines: string[] = [];
  editor.on('line', (line: string) => lines.push(line));

  editor.prompt();

  send(input, undefined, { name: 'paste-start', sequence: '\x1b[200~' });
  send(input, 'x', { name: 'x', sequence: 'x' });
  send(input, '\n', { name: 'enter', sequence: '\n' });
  send(input, 'y', { name: 'y', sequence: 'y' });
  send(input, undefined, { name: 'paste-end', sequence: '\x1b[201~' });
  send(input, '\r', { name: 'return', sequence: '\r' });

  expect(lines).toEqual(['x\ny']);
});

test('typed Enter (no paste markers) still submits immediately', () => {
  const { editor, input } = makeEditor();
  const lines: string[] = [];
  editor.on('line', (line: string) => lines.push(line));

  editor.prompt();

  send(input, 'h', { name: 'h', sequence: 'h' });
  send(input, 'i', { name: 'i', sequence: 'i' });
  // A plain typed Enter submits right away.
  send(input, '\r', { name: 'return', sequence: '\r' });

  expect(lines).toEqual(['hi']);
});
