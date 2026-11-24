// The server runs this script to read a CLI's model list (see modelListProbe in
// system.service.ts):
//   node model-list-probe.js <maxBytes> <deadlineMs> <parser> <command> [args...]
// The CLI's output can carry credentials (Kimi Code's lists provider API keys), so it
// is read and parsed here, in a process of its own, and only the catalog goes back:
// one JSON line on stdout, `{"catalog": ...}` in the compact form `modelListReply`
// writes, or `{"error": "..."}`. Errors name what failed, never what the CLI printed.
// Nothing reads the CLI's stderr, so it is not piped (a full pipe would stall the
// CLI). The server ends this process's group, CLI included, once it has the line or
// gives up waiting; if the server is gone by then, the group ends itself at
// `deadlineMs`.
import { spawn } from 'node:child_process';
import { isModelListParserName, MODEL_LIST_PARSERS, modelListReply } from './model-list-parsers.js';

const [maxBytesArg, deadlineArg, parserName, command, ...args] = process.argv.slice(2);

function report(result: { catalog: unknown } | { error: string }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

const deadlineMs = Number(deadlineArg);
if (deadlineMs > 0) {
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  }, deadlineMs).unref();
}

if (!isModelListParserName(parserName) || !command) {
  report({ error: 'Model list probe was started without a parser and command' });
} else {
  const parser = MODEL_LIST_PARSERS[parserName];
  const maxBytes = Number(maxBytesArg) > 0 ? Number(maxBytesArg) : 8 * 1024 * 1024;
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let done = false;
  const finish = (result: { catalog: unknown } | { error: string }) => {
    if (done) return;
    done = true;
    report(result);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) finish({ error: `${parser.label} wrote more output than expected` });
    else chunks.push(chunk);
  });
  child.on('error', (error: NodeJS.ErrnoException) =>
    finish({ error: `${parser.label} could not start (${error.code ?? 'error'})` }),
  );
  child.on('close', (code, signal) => {
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
