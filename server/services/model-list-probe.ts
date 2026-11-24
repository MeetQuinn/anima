// The server runs this script to read a CLI's model list (see modelListProbe in
// system.service.ts):
//   node model-list-probe.js <maxBytes> <deadlineMs> <parser> <command> [args...]
// The CLI's output can carry credentials (Kimi Code's lists provider API keys), so it
// is read and parsed here, in a process of its own, and only the catalog goes back:
// one JSON line on stdout, `{"catalog": ...}` in the compact form `modelListReply`
// writes, or `{"error": "..."}`. Errors name what failed, never what the CLI printed.
// Nothing reads the CLI's stderr, so it is not piped (a full pipe would stall the
// CLI). Once the line is written, or cannot be (the server is gone), this process
// ends its group, the CLI and all it started included. The server ends the group
// when it gives up waiting; if the server is gone by then, the group ends itself at
// `deadlineMs`.
import { spawn, type ChildProcess } from 'node:child_process';
import { isModelListParserName, MODEL_LIST_PARSERS, modelListReply } from './model-list-parsers.js';

const [maxBytesArg, deadlineArg, parserName, command, ...args] = process.argv.slice(2);
let child: ChildProcess | undefined;

/**
 * Ends this process's group (the server starts the probe as its leader): the CLI, all
 * it started, and this process.
 */
function endGroup(): void {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // Not a group leader (run directly): end the CLI, then this process.
    child?.kill('SIGKILL');
    process.exit(0);
  }
}

function report(result: { catalog: unknown } | { error: string }): void {
  // A reply that cannot be delivered ends the group too: an EPIPE must not leave the CLI.
  process.stdout.on('error', endGroup);
  process.stdout.write(`${JSON.stringify(result)}\n`, endGroup);
}

const deadlineMs = Number(deadlineArg);
if (deadlineMs > 0) setTimeout(endGroup, deadlineMs).unref();

if (!isModelListParserName(parserName) || !command) {
  report({ error: 'Model list probe was started without a parser and command' });
} else {
  const parser = MODEL_LIST_PARSERS[parserName];
  const maxBytes = Number(maxBytesArg) > 0 ? Number(maxBytesArg) : 8 * 1024 * 1024;
  const cli = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  child = cli;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let done = false;
  const finish = (result: { catalog: unknown } | { error: string }) => {
    if (done) return;
    done = true;
    report(result);
  };
  cli.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) finish({ error: `${parser.label} wrote more output than expected` });
    else chunks.push(chunk);
  });
  cli.on('error', (error: NodeJS.ErrnoException) =>
    finish({ error: `${parser.label} could not start (${error.code ?? 'error'})` }),
  );
  cli.on('close', (code, signal) => {
    if (code !== 0) {
      finish({ error: `${parser.label} exited (${code ?? signal ?? 'signal'})` });
      return;
    }
    try {
      finish({ catalog: modelListReply(parser.parse(Buffer.concat(chunks).toString('utf8'))) });
    } catch (error) {
      // Parser errors are fixed text; they never quote the output.
      finish({ error: error instanceof Error ? error.message : `${parser.label} could not be read` });
    }
  });
}
