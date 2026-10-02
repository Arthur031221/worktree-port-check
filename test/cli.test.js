import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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

test('CLI accepts a live Linux cwd ending in the deleted-directory marker', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux process cwd lookup uses /proc');
    return;
  }

  const scratchRoot = process.env.TMPDIR || tmpdir();
  const scratchDir = mkdtempSync(path.join(scratchRoot, 'worktree-port-check-cwd-'));
  const serviceDir = path.join(scratchDir, 'service (deleted)');
  const binDir = path.join(scratchDir, 'bin');
  mkdirSync(serviceDir);
  mkdirSync(binDir);

  let server;
  t.after(async () => {
    if (server?.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  });

  const serverScript = [
    "const net=require('node:net');",
    'const server=net.createServer();',
    "server.listen(0,'127.0.0.1',()=>console.log(server.address().port));",
  ].join('');
  server = spawn(process.execPath, ['-e', serverScript], {
    cwd: serviceDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const lines = createInterface({ input: server.stdout });
  const port = await new Promise((resolve, reject) => {
    lines.once('line', resolve);
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error('listener exited with status ' + code)));
  });
  lines.close();

  const fakeLsofPath = path.join(binDir, 'lsof');
  writeFileSync(fakeLsofPath, String.raw`#!/bin/sh
printf 'p%s\0cnode\0f17\0tIPv4\0PTCP\0n127.0.0.1:%s\0TST=LISTEN\0' "$WPC_TARGET_PID" "$WPC_TARGET_PORT"
`, { mode: 0o755 });
  chmodSync(fakeLsofPath, 0o755);

  const cliPath = fileURLToPath(new URL('../bin-worktree-port-check.js', import.meta.url));
  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
    WPC_TARGET_PID: String(server.pid),
    WPC_TARGET_PORT: port,
  };
  const result = spawnSync(process.execPath, [cliPath, port, '--json'], {
    encoding: 'utf8',
    env,
  });

  assert.equal(result.error, undefined);
  const report = JSON.parse(result.stdout);
  assert.equal(report.listeners.length, 1);
  assert.equal(report.listeners[0].cwd, serviceDir);
  assert.ok(['match', 'other_repository', 'non_git'].includes(report.listeners[0].comparison.status));
  assert.ok([0, 1, 3].includes(result.status));

  rmSync(serviceDir, { recursive: true, force: true });
  const deletedResult = spawnSync(process.execPath, [cliPath, port, '--json'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(deletedResult.status, 4);
  const deletedReport = JSON.parse(deletedResult.stdout);
  assert.match(deletedReport.listeners[0].comparison.detail, /cwd has been deleted/);
});
