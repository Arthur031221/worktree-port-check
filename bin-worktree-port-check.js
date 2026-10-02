#!/usr/bin/env node
import { EXIT, exitCode, parseArgs, renderHuman, renderJson } from './lib/core.js';
import { inspectPort } from './lib/system.js';

const parsed = parseArgs(process.argv.slice(2));
if (parsed.action === 'help') {
  process.stdout.write(
    'Usage: worktree-port-check <port> [--json]\n' +
    'Compare this Git worktree with the cwd of visible TCP listeners on a port.\n'
  );
  process.exitCode = EXIT.MATCH;
} else if (parsed.error) {
  process.stderr.write(parsed.error + '\n');
  process.stderr.write('Usage: worktree-port-check <port> [--json]\n');
  process.exitCode = EXIT.USAGE;
} else {
  const report = inspectPort(parsed.port);
  const output = parsed.json ? renderJson(report) : renderHuman(report);
  process.stdout.write(output + '\n');
  process.exitCode = exitCode(report);
}
