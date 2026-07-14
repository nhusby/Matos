import { spawn } from 'child_process';
import { resolve } from 'path';
import type { Tool } from '../Agent';

export interface BashToolConfig {
  /** Timeout in ms (default: 30_000) */
  timeout?: number;
  /** Restrict working directory (default: process.cwd()) */
  cwd?: string;
  /** Max stdout/stderr characters per stream before truncation (default: 50_000) */
  maxOutput?: number;
}

export const createBashTool = (config: BashToolConfig = {}): Tool => ({
  name: 'RunBashCommand',
  description: 'Run a bash command.  Do not use with interactive commands',
  ttl: 3,
  summarize: true,
  requiresApproval: true,
  params: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to project root.',
      },
    },
    required: ['command'],
  },
  callback: async ({ command, cwd }) => {
    const workDir = cwd ? resolve(cwd) : (config.cwd ?? process.cwd());
    const timeout = config.timeout ?? 30_000;
    const maxOutput = config.maxOutput ?? 50_000;

    return new Promise<string>((done) => {
      const proc = spawn(command, {
        shell: true,
        cwd: workDir,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        done(formatResult('TIMEOUT', stdout, stderr, maxOutput));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        done(formatResult(String(code ?? 'null'), stdout, stderr, maxOutput));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        done(`Error spawning command: ${err.message}`);
      });
    });
  },
});

function formatResult(
  exitCode: string,
  stdout: string,
  stderr: string,
  maxOutput: number,
): string {
  const parts: string[] = [`exit code: ${exitCode}`];

  if (stdout.trim()) {
    const out = stdout.trim();
    parts.push(
      `stdout:\n${out.length > maxOutput ? out.slice(0, maxOutput) + '\n...[truncated]' : out}`,
    );
  }
  if (stderr.trim()) {
    const err = stderr.trim();
    parts.push(
      `stderr:\n${err.length > maxOutput ? err.slice(0, maxOutput) + '\n...[truncated]' : err}`,
    );
  }

  return parts.join('\n');
}
