import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { Language } from '../parsers/languages.js';
import type { LspServerConfig } from './config.js';
import type {
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  Hover,
  InitializeResult,
  Location,
  Position,
  RenameParams,
  ServerCapabilities,
  WorkspaceEdit,
} from './protocol.js';

const LANGUAGE_ID: Record<Language, string> = {
  typescript: 'typescript',
  tsx: 'typescriptreact',
  go: 'go',
  python: 'python',
  perl: 'perl',
};

export class LspClient {
  private connection: MessageConnection | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private capabilities: ServerCapabilities = {};
  private readonly openDocs = new Set<string>();
  private ready = false;

  constructor(
    private readonly language: Language,
    private readonly server: LspServerConfig,
    private readonly workspaceRoot: string,
  ) {}

  async start(): Promise<void> {
    if (this.ready) return;
    const child = spawn(this.server.command, this.server.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workspaceRoot,
    });
    this.process = child;

    child.on('error', (err) => {
      console.warn(
        `[lsp:${this.language}] process error:`,
        (err as Error).message,
      );
      this.ready = false;
    });
    child.on('exit', (code) => {
      console.warn(
        `[lsp:${this.language}] server exited with code ${code}`,
      );
      this.ready = false;
      this.connection?.dispose();
      this.connection = null;
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection.listen();

    const result: InitializeResult = await this.connection.sendRequest(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspaceRoot).toString(),
        capabilities: {},
      },
    );
    this.capabilities = result.capabilities;
    await this.connection.sendNotification('initialized', {});
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    if (!this.connection || !this.ready) {
      this.kill();
      return;
    }
    try {
      await this.connection.sendRequest('shutdown', undefined);
      await this.connection.sendNotification('exit', undefined);
    } catch (e) {
      console.warn(
        `[lsp:${this.language}] shutdown error:`,
        (e as Error).message,
      );
    }
    this.kill();
  }

  private kill(): void {
    this.connection?.dispose();
    this.connection = null;
    this.ready = false;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 2000).unref();
    }
    this.process = null;
    this.openDocs.clear();
  }

  get isReady(): boolean {
    return this.ready;
  }

  supportsRename(): boolean {
    return this.capabilities.renameProvider !== undefined;
  }

  supportsHover(): boolean {
    return this.capabilities.hoverProvider === true;
  }

  async ensureOpen(filePath: string): Promise<void> {
    if (!this.connection || !this.ready) {
      throw new Error(`LSP server for ${this.language} not ready`);
    }
    const uri = pathToFileURL(filePath).toString();
    if (this.openDocs.has(uri)) return;
    const text = await readFile(filePath, 'utf-8');
    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri,
        languageId: LANGUAGE_ID[this.language],
        version: 1,
        text,
      },
    };
    await this.connection.sendNotification('textDocument/didOpen', params);
    this.openDocs.add(uri);
  }

  async notifyDidChange(filePath: string, newText: string): Promise<void> {
    if (!this.connection || !this.ready) return;
    const uri = pathToFileURL(filePath).toString();
    if (!this.openDocs.has(uri)) {
      await this.ensureOpen(filePath);
      return;
    }
    const params: DidChangeTextDocumentParams = {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text: newText }],
    };
    await this.connection.sendNotification('textDocument/didChange', params);
  }

  async rename(
    filePath: string,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    if (!this.supportsRename()) {
      throw new Error(`${this.language} server does not support rename`);
    }
    await this.ensureOpen(filePath);
    const params: RenameParams = {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position,
      newName,
    };
    return await this.connection!.sendRequest('textDocument/rename', params);
  }

  async hover(
    filePath: string,
    position: Position,
  ): Promise<Hover | null> {
    if (!this.supportsHover()) return null;
    await this.ensureOpen(filePath);
    return await this.connection!.sendRequest('textDocument/hover', {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position,
    });
  }

  async references(
    filePath: string,
    position: Position,
  ): Promise<Location[] | null> {
    await this.ensureOpen(filePath);
    return await this.connection!.sendRequest('textDocument/references', {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position,
      context: { includeDeclaration: true },
    });
  }
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}
