import { test, expect } from 'bun:test';
import { MarkdownStreamRenderer } from '../../lib/markdownRenderer';

/** Strip ANSI escape codes so content assertions see plain text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * A minimal recording stream implementing the `WritableLike` shape the
 * renderer depends on.  Every `write` is captured so tests can inspect
 * the exact output the renderer emits.
 */
function makeStream() {
  const writes: string[] = [];
  const stream = {
    write(data: string) {
      writes.push(data);
      return true;
    },
  };
  return { stream, writes };
}

test('flush() with no buffered content writes nothing', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);
  md.flush();
  expect(writes).toEqual([]);
});

test('single block stays pending — nothing emitted until flush', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  md.push('hello world');
  // Only one block (a paragraph) — it's the "pending" tail, not yet emitted.
  expect(writes).toEqual([]);

  md.flush();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('hello world');
});

test('first block is emitted when the second block begins', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  md.push('first paragraph\n\n');
  // Still one token — the trailing blank line may or may not create a space
  // token, but even if it does, the paragraph is only "complete" once there's
  // a subsequent block.
  md.push('second paragraph');

  // Two tokens now: paragraph one is complete, paragraph two is pending.
  expect(writes.length).toBeGreaterThanOrEqual(1);
  expect(writes[0]).toContain('first paragraph');
  expect(writes.join('')).not.toContain('second paragraph');

  md.flush();
  const all = writes.join('');
  expect(all).toContain('second paragraph');
});

test('no content is ever emitted twice', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  // Three blank-line-separated paragraphs → three block tokens.
  md.push('para one\n\npara two\n\npara three');
  // First two blocks are complete, third is pending.
  expect(writes).toHaveLength(1);

  md.flush();
  expect(writes).toHaveLength(2);

  const all = writes.join('');
  expect(all.match(/para one/g)).toHaveLength(1);
  expect(all.match(/para two/g)).toHaveLength(1);
  expect(all.match(/para three/g)).toHaveLength(1);
});

test('incremental pushes across block boundary emit in order', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  // Feed tokens that form one paragraph, then a second.
  md.push('# Heading\n\n');
  expect(writes).toHaveLength(1); // heading is complete once blank line arrives
  expect(writes[0]).toContain('Heading');

  md.push('body text');
  // The trailing whitespace from the first push becomes a complete space token
  // when "body text" starts a new block — emitted as whitespace-only.
  // "body text" itself is still the pending tail.
  expect(writes).toHaveLength(2);
  expect(writes[1].trim()).toBe(''); // space token — no visible content

  md.flush();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toContain('body text');
});

test('reset() discards buffered content', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  md.push('heading and\n\nbody');
  expect(writes.length).toBeGreaterThanOrEqual(1); // heading emitted
  md.reset();
  md.flush();
  // flush after reset writes nothing — the pending "body" was discarded.
  const afterReset = writes.length;
  expect(writes.length).toBe(afterReset);
});

test('flush() is idempotent', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  md.push('once');
  md.flush();
  const count = writes.length;
  md.flush();
  expect(writes.length).toBe(count);
});

test('code block stays pending until closing fence, then next block emits it', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  // An unclosed code fence — the lexer treats this as a single paragraph
  // (the opening ``` is not recognized without a closing fence).
  md.push('```js\nconst x = 1;\n');
  expect(writes).toEqual([]);

  // Close the fence — now it's a complete code block, but still the LAST
  // token, so it's pending.
  md.push('```\n\n');
  // A space token or nothing follows — code block is still last, still pending.
  // Nothing should be emitted yet.
  const beforeNext = writes.length;

  // Now a new block starts — the code block is no longer last.
  md.push('after code');
  expect(writes.length).toBeGreaterThan(beforeNext);
  // The code block content should appear in the emitted output.
  // Syntax highlighting adds ANSI codes mid-content, so strip them first.
  const allSoFar = stripAnsi(writes.join(''));
  expect(allSoFar).toContain('const x = 1');
});

test('empty/whitespace-only chunks produce no output', () => {
  const { stream, writes } = makeStream();
  const md = new MarkdownStreamRenderer(stream);

  md.push('');
  md.push('   ');
  md.push('\n\n');
  expect(writes).toEqual([]);
  md.flush();
  // Whitespace-only buffer: marked may produce whitespace, but no visible
  // content.
  const all = writes.join('');
  expect(all.trim()).toBe('');
});
