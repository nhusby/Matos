import { Marked, type Token } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * Minimal structural shape of a writable terminal stream.  We only need
 * `write` — no cursor positioning, no row counting, no ANSI awareness.
 */
interface WritableLike {
  write(data: string): boolean;
}

/**
 * Streams Markdown to a terminal with live formatting — **without any cursor
 * manipulation**.
 *
 * ## Strategy: forward-only block rendering
 *
 * As content tokens arrive via {@link push}, the accumulated buffer is
 * re-lexed into top-level Markdown blocks (paragraphs, headings, code fences,
 * lists, tables, …).  All blocks except the *last* are considered syntactically
 * complete.  Their raw source text is sliced from the buffer, rendered through
 * `marked.parse()` + `marked-terminal`, and written to the stream **once,
 * forward** — never rewritten.
 *
 * The final block is always "pending" — it may still be receiving tokens (an
 * unclosed code fence, a paragraph whose trailing blank line hasn't arrived).
 * It stays invisible until the next block begins (making it complete) or
 * {@link flush} is called (end of stream).
 *
 * Because output only ever moves forward, there is no row-counting, no
 * `\x1b[A` rewind, no `\x1b[J` clear.
 */
export class MarkdownStreamRenderer {
  private readonly stream: WritableLike;
  private readonly marked: Marked;
  private buffer = '';

  constructor(stream: WritableLike) {
    this.stream = stream;
    this.marked = new Marked();
    this.marked.use(markedTerminal() as any);
  }

  /**
   * Append a chunk of streamed content.  Any newly-completed Markdown blocks
   * are rendered and emitted immediately (synchronously, forward-only).
   */
  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    this.emitCompletedBlocks();
  }

  /**
   * Render any remaining buffered content and reset.  Call this when the
   * stream is finished (end of agent turn, before a tool result, etc.).
   *
   * Safe to call multiple times (subsequent calls are no-ops).
   */
  flush(): void {
    if (!this.buffer) return;
    this.renderAndWrite(this.buffer);
    this.buffer = '';
  }

  /** Discard any buffered content without rendering anything. */
  reset(): void {
    this.buffer = '';
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Render a raw Markdown string through `marked.parse()` and write it to the
   * stream.  Both {@link flush} and {@link emitCompletedBlocks} use this so the
   * formatting pipeline is identical everywhere.
   */
  private renderAndWrite(raw: string): void {
    let out: string;
    try {
      out = this.marked.parse(raw) as string;
    } catch {
      out = raw;
    }
    this.stream.write(out);
  }

  /**
   * Lex the buffer into top-level blocks and emit every block except the last.
   * The last block may still be incomplete (awaiting more tokens), so it stays
   * buffered until the next call or until {@link flush}.
   */
  private emitCompletedBlocks(): void {
    if (!this.buffer.trim()) return;

    let tokens: Token[];
    try {
      tokens = this.marked.lexer(this.buffer);
    } catch {
      return; // malformed input — wait for more content
    }

    // Need at least two tokens for the first to be "complete".
    if (tokens.length <= 1) return;

    const complete = tokens.slice(0, -1);

    // Sum the raw source of completed tokens to know exactly how much of the
    // buffer to consume.
    let consumed = '';
    for (const t of complete) consumed += t.raw;

    this.renderAndWrite(consumed);
    this.buffer = this.buffer.slice(consumed.length);
  }
}
