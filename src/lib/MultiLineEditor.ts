import { EventEmitter } from 'events';
import { emitKeypressEvents } from 'readline';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  code?: string;
}

export interface MultiLineEditorOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt?: string;
  continuationPrompt?: string;
}

/**
 * Minimal multi-line input editor using raw-mode stdin + emitKeypressEvents.
 *
 * Key bindings:
 *   Enter            submit
 *   Alt+Enter        newline (most reliable cross-terminal)
 *   Shift+Enter      newline (terminal-dependent — may not fire)
 *   Ctrl+J           newline (always works)
 *   Backspace        delete char before cursor / merge lines
 *   Delete           delete char at cursor / merge lines
 *   Ctrl+W           delete word backward
 *   Alt+Backspace    delete word backward
 *   Alt+D            delete word forward
 *   Alt+Delete       delete word forward
 *   Ctrl+U           kill to beginning of line
 *   Ctrl+K           cut entire line
 *   Left/Right       move cursor (Ctrl/Meta = word jump)
 *   Up/Down          move between lines
 *   Home / Ctrl+A    beginning of line
 *   End  / Ctrl+E    end of line
 *   Ctrl+L           clear screen, re-render
 *   Ctrl+C           emit 'sigint'
 *   Ctrl+D           emit 'close' (when empty)
 *   Escape           emit 'escape'
 */
export class MultiLineEditor extends EventEmitter {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private promptStr: string;
  private readonly continuationStr: string;

  private lines: string[] = [''];
  private row = 0;
  private col = 0;
  private active = false;
  private renderedRows = 0;
  private cursorScreenRow = 0;

  private questionResolve: ((line: string) => void) | null = null;
  private questionOriginalPrompt: string | null = null;

  private readonly keypressHandler: (str: string, key: Key) => void;
  private readonly resizeHandler: () => void;

  constructor(opts: MultiLineEditorOptions) {
    super();
    this.input = opts.input;
    this.output = opts.output;
    this.promptStr = opts.prompt ?? '> ';
    this.continuationStr = opts.continuationPrompt ?? '  ';

    emitKeypressEvents(this.input);
    if (this.input.isTTY) {
      (this.input as any).setRawMode(true);
    }
    this.input.resume();

    this.keypressHandler = (str, key) => this.onKeypress(str, key);
    this.resizeHandler = () => {
      if (this.active) this.render();
    };

    this.input.on('keypress', this.keypressHandler);
    this.output.on('resize', this.resizeHandler);
  }

  // ── Public API ──────────────────────────────────────────────

  /** Reset buffer, show prompt, start accepting input. */
  prompt(): void {
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.renderedRows = 0;
    this.cursorScreenRow = 0;
    this.active = true;
    this.render();
  }

  /** Write a message above the prompt, preserving any in-progress input. */
  write(msg: string): void {
    if (this.renderedRows > 0) {
      this.clearRendered();
    }
    this.output.write(msg);
    if (this.active) {
      this.render();
    }
  }

  /**
   * Write *text*, then collect a single line of input using *prompt* as the
   * prompt string.  Resolves with the submitted line.  While active, the
   * normal 'line' event is suppressed so CLI input handlers don't fire.
   * Escape resolves with 'n' (treated as rejection by callers).
   */
  question(text: string, prompt?: string): Promise<string> {
    this.clearRendered();
    this.output.write(text);

    if (prompt !== undefined) {
      this.questionOriginalPrompt = this.promptStr;
      this.promptStr = prompt;
    }

    this.prompt();

    return new Promise<string>((resolve) => {
      this.questionResolve = resolve;
    });
  }

  /**
   * Programmatically cancel any active question.  Resolves the pending
   * question promise with *value*, restores the original prompt, and
   * deactivates input.  No-op when no question is active.
   */
  cancelQuestion(value: string): void {
    if (!this.questionResolve) return;
    const resolve = this.questionResolve;
    this.questionResolve = null;
    if (this.questionOriginalPrompt !== null) {
      this.promptStr = this.questionOriginalPrompt;
      this.questionOriginalPrompt = null;
    }
    this.active = false;
    this.clearRendered();
    resolve(value);
  }

  /** Teardown — restore cooked mode, remove listeners. */
  close(): void {
    this.input.removeListener('keypress', this.keypressHandler);
    this.output.removeListener('resize', this.resizeHandler);
    if (this.input.isTTY) {
      (this.input as any).setRawMode(false);
    }
    this.active = false;
  }

  // ── Rendering ───────────────────────────────────────────────

  private termWidth(): number {
    return this.output.columns || 80;
  }

  /** Screen rows occupied by logical line *index* (accounting for wrap). */
  private lineScreenRows(index: number): number {
    const prefixLen =
      index === 0 ? this.promptStr.length : this.continuationStr.length;
    const contentLen = this.lines[index].length;
    const w = this.termWidth();
    const firstRow = w - prefixLen;
    if (firstRow <= 0 || contentLen <= firstRow) return 1;
    return 1 + Math.ceil((contentLen - firstRow) / w);
  }

  private totalScreenRows(): number {
    let total = 0;
    for (let i = 0; i < this.lines.length; i++) {
      total += this.lineScreenRows(i);
    }
    return total;
  }

  private clearRendered(): void {
    if (this.renderedRows === 0) return;
    if (this.cursorScreenRow > 0) {
      this.output.write(`\x1b[${this.cursorScreenRow}A`);
    }
    this.output.write('\r\x1b[J');
    this.renderedRows = 0;
    this.cursorScreenRow = 0;
  }

  private render(): void {
    const out = this.output;

    this.clearRendered();

    for (let i = 0; i < this.lines.length; i++) {
      const prefix = i === 0 ? this.promptStr : this.continuationStr;
      out.write(prefix + this.lines[i] + '\n');
    }

    this.renderedRows = this.totalScreenRows();

    // Calculate target screen position
    let targetRow = 0;
    for (let i = 0; i < this.row; i++) {
      targetRow += this.lineScreenRows(i);
    }
    const prefixLen =
      this.row === 0 ? this.promptStr.length : this.continuationStr.length;
    const cursorPos = prefixLen + this.col;
    const w = this.termWidth();
    targetRow += Math.floor(cursorPos / w);
    const targetCol = cursorPos % w;

    // Cursor currently sits below all content — move up to target row
    const moveUp = this.renderedRows - targetRow;
    if (moveUp > 0) {
      out.write(`\x1b[${moveUp}A`);
    }
    // Set column (CHA is 1-based)
    out.write(`\x1b[${targetCol + 1}G`);

    this.cursorScreenRow = targetRow;
  }

  // ── Key handling ────────────────────────────────────────────

  private onKeypress(str: string, key: Key): void {
    // ── Always-active keys ──
    if (key.ctrl && key.name === 'c') {
      this.emit('sigint');
      return;
    }
    if (key.ctrl && key.name === 'd') {
      if (!this.active || this.getText() === '') {
        this.emit('close');
      }
      return;
    }
    if (key.name === 'escape') {
      if (this.questionResolve) {
        const resolve = this.questionResolve;
        this.questionResolve = null;
        if (this.questionOriginalPrompt !== null) {
          this.promptStr = this.questionOriginalPrompt;
          this.questionOriginalPrompt = null;
        }
        this.active = false;
        this.clearRendered();
        resolve('n');
      } else {
        this.emit('escape');
      }
      return;
    }

    if (!this.active) return;

    // ── Submit ──
    if (key.name === 'return' && !key.meta && !key.shift) {
      this.submit();
      return;
    }

    // ── Newline: Alt+Enter | Shift+Enter | Ctrl+J ──
    if (
      (key.name === 'return' && (key.meta || key.shift)) ||
      (key.ctrl && key.name === 'j')
    ) {
      this.insertNewline();
      this.render();
      return;
    }

    // ── Word deletion (check before plain char deletion) ──
    if (key.ctrl && key.name === 'w') {
      this.deleteWordBackward();
      this.render();
      return;
    }
    if (key.meta && key.name === 'backspace') {
      this.deleteWordBackward();
      this.render();
      return;
    }
    if (key.meta && (key.name === 'd' || key.name === 'delete')) {
      this.deleteWordForward();
      this.render();
      return;
    }

    // ── Deletion ──
    if (key.name === 'backspace') {
      this.backspace();
      this.render();
      return;
    }
    if (key.name === 'delete') {
      this.deleteForward();
      this.render();
      return;
    }
    if (key.ctrl && key.name === 'u') {
      this.lines[this.row] = this.lines[this.row].slice(this.col);
      this.col = 0;
      this.render();
      return;
    }
    if (key.ctrl && key.name === 'k') {
      this.deleteLine();
      this.render();
      return;
    }

    // ── Word jump: macOS terminals send meta+b / meta+f for Opt+Left / Opt+Right ──
    if (key.meta && key.name === 'b') {
      this.moveWordLeft();
      this.render();
      return;
    }
    if (key.meta && key.name === 'f') {
      this.moveWordRight();
      this.render();
      return;
    }

    // ── Cursor movement ──
    if (key.name === 'left') {
      if (key.ctrl || key.meta) this.moveWordLeft();
      else this.cursorLeft();
      this.render();
      return;
    }
    if (key.name === 'right') {
      if (key.ctrl || key.meta) this.moveWordRight();
      else this.cursorRight();
      this.render();
      return;
    }
    if (key.name === 'up') {
      this.cursorUp();
      this.render();
      return;
    }
    if (key.name === 'down') {
      this.cursorDown();
      this.render();
      return;
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.col = 0;
      this.render();
      return;
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      this.col = this.lines[this.row].length;
      this.render();
      return;
    }

    // ── Clear screen ──
    if (key.ctrl && key.name === 'l') {
      this.output.write('\x1b[2J\x1b[H');
      this.renderedRows = 0;
      this.cursorScreenRow = 0;
      this.render();
      return;
    }

    // ── Printable character ──
    if (str && !key.ctrl && !key.meta) {
      const code = str.charCodeAt(0);
      if (code >= 32 || str === '\t') {
        this.insertChar(str);
        this.render();
      }
    }
  }

  // ── Text operations ─────────────────────────────────────────

  private getText(): string {
    return this.lines.join('\n');
  }

  private submit(): void {
    const text = this.getText();
    this.active = false;
    // Re-render final state without cursor, then advance to fresh line
    this.clearRendered();
    for (let i = 0; i < this.lines.length; i++) {
      const prefix = i === 0 ? this.promptStr : this.continuationStr;
      this.output.write(prefix + this.lines[i] + '\n');
    }
    this.lines = [''];
    this.row = 0;
    this.col = 0;

    if (this.questionResolve) {
      const resolve = this.questionResolve;
      this.questionResolve = null;
      if (this.questionOriginalPrompt !== null) {
        this.promptStr = this.questionOriginalPrompt;
        this.questionOriginalPrompt = null;
      }
      resolve(text);
    } else {
      this.emit('line', text);
    }
  }

  private insertChar(ch: string): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col);
    this.col += ch.length;
  }

  private insertNewline(): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, line.slice(this.col));
    this.row++;
    this.col = 0;
  }

  private backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      this.col = prev.length;
      this.lines[this.row - 1] = prev + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
    }
  }

  private deleteForward(): void {
    const line = this.lines[this.row];
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
  }

  private cursorLeft(): void {
    if (this.col > 0) {
      this.col--;
    } else if (this.row > 0) {
      this.row--;
      this.col = this.lines[this.row].length;
    }
  }

  private cursorRight(): void {
    if (this.col < this.lines[this.row].length) {
      this.col++;
    } else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
  }

  private cursorUp(): void {
    if (this.row > 0) {
      this.row--;
      this.col = Math.min(this.col, this.lines[this.row].length);
    }
  }

  private cursorDown(): void {
    if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = Math.min(this.col, this.lines[this.row].length);
    }
  }

  private moveWordLeft(): void {
    const line = this.lines[this.row];
    if (this.col === 0) {
      if (this.row > 0) {
        this.row--;
        this.col = this.lines[this.row].length;
      }
      return;
    }
    let i = this.col - 1;
    while (i >= 0 && /\s/.test(line[i])) i--;
    while (i >= 0 && !/\s/.test(line[i])) i--;
    this.col = i + 1;
  }

  private moveWordRight(): void {
    const line = this.lines[this.row];
    if (this.col >= line.length) {
      if (this.row < this.lines.length - 1) {
        this.row++;
        this.col = 0;
      }
      return;
    }
    let i = this.col;
    while (i < line.length && !/\s/.test(line[i])) i++;
    while (i < line.length && /\s/.test(line[i])) i++;
    this.col = i;
  }

  private deleteLine(): void {
    this.lines.splice(this.row, 1);
    if (this.lines.length === 0) {
      this.lines = [''];
    }
    if (this.row >= this.lines.length) {
      this.row = this.lines.length - 1;
    }
    this.col = 0;
  }

  private deleteWordBackward(): void {
    const line = this.lines[this.row];
    if (this.col === 0) {
      if (this.row > 0) {
        const prev = this.lines[this.row - 1];
        this.col = prev.length;
        this.lines[this.row - 1] = prev + line;
        this.lines.splice(this.row, 1);
        this.row--;
      }
      return;
    }
    let i = this.col - 1;
    while (i >= 0 && /\s/.test(line[i])) i--;
    while (i >= 0 && !/\s/.test(line[i])) i--;
    const wordStart = i + 1;
    this.lines[this.row] = line.slice(0, wordStart) + line.slice(this.col);
    this.col = wordStart;
  }

  private deleteWordForward(): void {
    const line = this.lines[this.row];
    if (this.col >= line.length) {
      if (this.row < this.lines.length - 1) {
        this.lines[this.row] = line + this.lines[this.row + 1];
        this.lines.splice(this.row + 1, 1);
      }
      return;
    }
    let i = this.col;
    while (i < line.length && /\s/.test(line[i])) i++;
    while (i < line.length && !/\s/.test(line[i])) i++;
    this.lines[this.row] = line.slice(0, this.col) + line.slice(i);
  }
}
