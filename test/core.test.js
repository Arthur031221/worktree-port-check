import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  EXIT,
  classifyOwner,
  exitCode,
  parseArgs,
  parseLsofOutput,
  renderHuman,
  renderJson,
  sameListenerSet,
} from '../lib/core.js';
import { inspectPort, readGitInfo } from '../lib/system.js';

const current = {
  status: 'git',
  root: '/work/project',
  commonDir: '/work/project/.git',
  branch: 'main',
};

test('accepts a port and optional JSON output flag', () => {
  assert.deepEqual(parseArgs(['3000']), {
    action: 'inspect',
    port: 3000,
    json: false,
  });
  assert.deepEqual(parseArgs(['--json', '65535']), {
    action: 'inspect',
    port: 65535,
    json: true,
  });
});

test('rejects invalid or extra arguments', () => {
  for (const args of [[], ['0'], ['65536'], ['3.2'], ['abc'], ['3000', '3001'], ['--quiet', '3000']]) {
    assert.ok(parseArgs(args).error, args.join(' '));
  }
  assert.equal(parseArgs(['--help']).action, 'help');
});

test('parses NUL delimited listener records across process boundaries', () => {
  const output = [
    'p101\0cnode\0',
    '\nf17\0tIPv4\0PTCP\0n127.0.0.1:3000\0TST=LISTEN\0',
    '\np202\0cpython\0',
    '\nf5\0tIPv6\0PTCP\0n[::1]:3000\0TST=LISTEN\0',
  ].join('');
  const result = parseLsofOutput(output);
  assert.equal(result.parseable, true);
  assert.deepEqual(result.listeners, [
    { pid: '101', command: 'node', fds: ['17'], names: ['127.0.0.1:3000'] },
    { pid: '202', command: 'python', fds: ['5'], names: ['[::1]:3000'] },
  ]);
});

test('groups multiple listening sockets owned by one process', () => {
  const output = [
    'p101\0cnode\0',
    '\nf17\0PTCP\0n127.0.0.1:3000\0TST=LISTEN\0',
    '\nf18\0PTCP\0n[::1]:3000\0TST=LISTEN\0',
  ].join('');
  const result = parseLsofOutput(output);
  assert.equal(result.listeners.length, 1);
  assert.deepEqual(result.listeners[0].fds, ['17', '18']);
  assert.equal(result.listeners[0].names.length, 2);
});

test('ignores descriptors that are not TCP listeners', () => {
  const output = [
    'p101\0cnode\0',
    '\nf17\0PTCP\0n127.0.0.1:3000\0TST=ESTABLISHED\0',
    '\nf18\0PUDP\0n127.0.0.1:3000\0TST=LISTEN\0',
  ].join('');
  assert.deepEqual(parseLsofOutput(output).listeners, []);
});

test('marks empty output as parseable only when fields exist', () => {
  assert.equal(parseLsofOutput('').parseable, false);
});

test('same checkout identity is a match even when branch metadata differs', () => {
  assert.equal(classifyOwner(current, {
    status: 'git',
    root: '/work/project',
    commonDir: '/work/project/.git',
    branch: 'feature',
  }).status, 'match');
});

test('same common directory and another root identifies a linked worktree', () => {
  assert.equal(classifyOwner(current, {
    status: 'git',
    root: '/work/project-feature',
    commonDir: '/work/project/.git',
  }).status, 'other_worktree');
});

test('different common directory identifies another repository', () => {
  assert.equal(classifyOwner(current, {
    status: 'git',
    root: '/work/other',
    commonDir: '/work/other/.git',
  }).status, 'other_repository');
});

test('verified non-Git cwd has a separate result', () => {
  assert.equal(classifyOwner(current, { status: 'non_git' }).status, 'non_git');
});

test('unavailable owner details remain incomplete', () => {
  assert.equal(classifyOwner(current, {
    status: 'incomplete',
    detail: 'permission denied',
  }).status, 'incomplete');
});

test('listener snapshot comparison notices a changed file descriptor', () => {
  const left = [{ pid: '1', fds: ['7'] }];
  const right = [{ pid: '1', fds: ['8'] }];
  assert.equal(sameListenerSet(left, left), true);
  assert.equal(sameListenerSet(left, right), false);
});

test('owner inspection runs between listener snapshots', () => {
  const calls = [];
  let query = 0;
  const listener = { pid: '4', command: 'node', fds: ['3'], names: ['127.0.0.1:3000'] };
  const operations = {
    readGitInfo(cwd) {
      calls.push('git:' + cwd);
      return { ...current, cwd };
    },
    queryListeners(port) {
      calls.push('lsof:' + port);
      query += 1;
      return { listeners: [listener], errors: [] };
    },
    readOwnerCwd(pid, platform) {
      calls.push('cwd:' + pid + ':' + platform);
      return { status: 'ok', cwd: '/work/project' };
    },
  };
  const report = inspectPort(3000, '/current', 'linux', operations);
  assert.deepEqual(calls, [
    'git:/current',
    'lsof:3000',
    'cwd:4:linux',
    'git:/work/project',
    'lsof:3000',
  ]);
  assert.equal(report.stable, true);
  assert.equal(report.listeners[0].comparison.status, 'match');
  assert.equal(exitCode(report), EXIT.MATCH);
});

test('changed listener snapshot is reported after owner inspection', () => {
  let query = 0;
  const listener = { pid: '4', command: 'node', fds: ['3'], names: [] };
  const operations = {
    readGitInfo: () => current,
    queryListeners() {
      query += 1;
      return { listeners: [{ ...listener, fds: [String(query + 2)] }], errors: [] };
    },
    readOwnerCwd: () => ({ status: 'ok', cwd: '/work/project' }),
  };
  const report = inspectPort(3000, '/current', 'linux', operations);
  assert.equal(report.stable, false);
  assert.match(report.errors[0], /changed during inspection/);
  assert.equal(report.listeners[0].comparison.status, 'match');
  assert.equal(exitCode(report), EXIT.INCOMPLETE);
});

test('a mismatch is conclusive even if another owner is incomplete', () => {
  const report = {
    port: 3000,
    current,
    listeners: [
      { comparison: { status: 'other_worktree' } },
      { comparison: { status: 'incomplete' } },
    ],
    errors: ['owner hidden'],
    stable: true,
  };
  assert.equal(exitCode(report), EXIT.MISMATCH);
});

test('exit codes distinguish a match, no listener, and non-Git listener', () => {
  const base = { port: 3000, current, errors: [], stable: true };
  assert.equal(exitCode({ ...base, listeners: [{ comparison: { status: 'match' } }] }), EXIT.MATCH);
  assert.equal(exitCode({ ...base, listeners: [] }), EXIT.NO_LISTENER);
  assert.equal(exitCode({ ...base, listeners: [{ comparison: { status: 'non_git' } }] }), EXIT.NON_GIT);
});

test('human output names the cwd and the comparison result', () => {
  const report = {
    port: 3000,
    current: { status: 'git', root: '/work/project', branch: 'main' },
    listeners: [{
      pid: '7',
      command: 'node',
      cwd: '/work/project-feature',
      root: '/work/project-feature',
      branch: 'preview',
      comparison: {
        status: 'other_worktree',
        detail: 'The process cwd belongs to another worktree in this repository.',
      },
    }],
    errors: [],
    stable: true,
  };
  const output = renderHuman(report);
  assert.match(output, /PID 7 \(node\)/);
  assert.match(output, /work\/project-feature/);
  assert.match(output, /result: OTHER_WORKTREE/);
});

test('JSON output includes an exit code', () => {
  const report = { port: 3000, current, listeners: [], errors: [], stable: true };
  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.exitCode, EXIT.NO_LISTENER);
});

test('readGitInfo resolves this project from a real checkout', () => {
  const info = readGitInfo(fileURLToPath(new URL('../', import.meta.url)));
  assert.equal(info.status, 'git');
  assert.ok(info.root);
  assert.ok(info.commonDir);
});
