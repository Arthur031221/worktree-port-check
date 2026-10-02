import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI drains JSON output larger than a pipe buffer', (t) => {
  const scratchRoot = process.env.TMPDIR || tmpdir();
  const scratchDir = mkdtempSync(path.join(scratchRoot, 'worktree-port-check-json-'));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));

  const binDir = path.join(scratchDir, 'bin');
  mkdirSync(binDir);
  const fakeLsofPath = path.join(binDir, 'lsof');
  const fakeLsof = String.raw`#!/bin/sh
case " $* " in
  *" -d cwd "*) printf 'lsof: owner hidden\n' >&2; exit 1 ;;
  *" -Di "*) printf 'lsof: unsupported option: -D\n' >&2; exit 1 ;;
esac
i=1
while [ "$i" -le 500 ]; do
  pid=$((999999999 + i))
  printf 'p%s\0cnode\0\nf%s\0tIPv4\0PTCP\0n127.0.0.1:20000\0TST=LISTEN\0' "$pid" "$i"
  i=$((i + 1))
done
`;
  writeFileSync(fakeLsofPath, fakeLsof, { mode: 0o755 });
  chmodSync(fakeLsofPath, 0o755);

  const cliPath = fileURLToPath(new URL('../bin-worktree-port-check.js', import.meta.url));
  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
  };
  const result = spawnSync(process.execPath, [cliPath, '20000', '--json'], {
    encoding: 'utf8',
    env,
    maxBuffer: 2 * 1024 * 1024,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 4);
  assert.ok(Buffer.byteLength(result.stdout) > 65_536);
  const report = JSON.parse(result.stdout);
  assert.equal(report.listeners.length, 500);
  assert.equal(report.exitCode, 4);
});
