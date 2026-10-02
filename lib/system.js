import { spawnSync } from 'node:child_process';
import { realpathSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { classifyOwner, parseLsofOutput, sameListenerSet } from './core.js';

const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 4000;

function commandEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  return env;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnv(),
    encoding: null,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || Buffer.alloc(0),
    stderr: result.stderr || Buffer.alloc(0),
    error: result.error || null,
  };
}

function text(buffer) {
  return Buffer.from(buffer).toString('utf8');
}

function stripOneLineEnding(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function commandFailure(result) {
  if (result.error) return result.error.message;
  const message = stripOneLineEnding(text(result.stderr));
  return message || 'command exited with status ' + result.status;
}

function gitCall(cwd, args) {
  return run('git', ['-C', cwd, ...args], cwd);
}

export function readGitInfo(inputCwd) {
  let cwd;
  try {
    cwd = realpathSync(inputCwd);
  } catch (error) {
    return { status: 'incomplete', detail: 'Cannot resolve cwd: ' + error.message };
  }

  const rootResult = gitCall(cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.status !== 0) {
    const message = commandFailure(rootResult);
    if (/not a git repository/i.test(message)) {
      return { status: 'non_git', cwd };
    }
    return { status: 'incomplete', cwd, detail: 'Git root check failed: ' + message };
  }

  const rootValue = stripOneLineEnding(text(rootResult.stdout));
  let root;
  try {
    root = realpathSync(rootValue);
  } catch (error) {
    return { status: 'incomplete', cwd, detail: 'Cannot resolve Git root: ' + error.message };
  }

  const commonResult = gitCall(cwd, ['rev-parse', '--git-common-dir']);
  if (commonResult.status !== 0) {
    return { status: 'incomplete', cwd, root, detail: 'Git common directory check failed: ' + commandFailure(commonResult) };
  }
  const commonValue = stripOneLineEnding(text(commonResult.stdout));
  const commonPath = path.isAbsolute(commonValue) ? commonValue : path.resolve(cwd, commonValue);
  let commonDir;
  try {
    commonDir = realpathSync(commonPath);
  } catch (error) {
    return { status: 'incomplete', cwd, root, detail: 'Cannot resolve Git common directory: ' + error.message };
  }

  const branchResult = gitCall(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let branch = null;
  if (branchResult.status === 0) {
    branch = stripOneLineEnding(text(branchResult.stdout));
  } else if (branchResult.status !== 1) {
    return { status: 'incomplete', cwd, root, commonDir, detail: 'Git branch check failed: ' + commandFailure(branchResult) };
  }

  return { status: 'git', cwd, root, commonDir, branch: branch || '(detached)' };
}

function lsofArgs(port, cacheMode) {
  const args = [];
  if (cacheMode) args.push('-Di');
  args.push(
    '-nP',
    '-a',
    '-iTCP:' + port,
    '-sTCP:LISTEN',
    '-F0pcfntPT'
  );
  return args;
}

function isUnsupportedCacheOption(result) {
  const message = text(result.stderr);
  return result.status !== 0 && /unsupported option: -D/i.test(message);
}

export function queryListeners(port) {
  let result = run('lsof', lsofArgs(port, true));
  let usedCacheFlag = true;
  if (isUnsupportedCacheOption(result)) {
    result = run('lsof', lsofArgs(port, false));
    usedCacheFlag = false;
  }

  const parsed = parseLsofOutput(result.stdout);
  const stderr = stripOneLineEnding(text(result.stderr));
  const errors = [];
  if (result.error) {
    errors.push('lsof could not run: ' + result.error.message);
  } else if (result.status !== 0 && !(result.status === 1 && result.stdout.length === 0 && !stderr)) {
    errors.push('lsof exited with status ' + result.status + (stderr ? ': ' + stderr : ''));
  } else if (stderr) {
    errors.push('lsof reported: ' + stderr);
  }
  if (result.stdout.length > 0 && !parsed.parseable) {
    errors.push('lsof output did not include parseable TCP listener fields');
  }

  return {
    listeners: parsed.listeners,
    errors,
    usedCacheFlag,
  };
}

function readMacCwd(pid) {
  const result = run('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-F0n']);
  if (result.status !== 0) {
    return { status: 'incomplete', detail: 'Cannot read process cwd: ' + commandFailure(result) };
  }
  const diagnostic = stripOneLineEnding(text(result.stderr));
  if (diagnostic) {
    return { status: 'incomplete', detail: 'lsof reported while reading process cwd: ' + diagnostic };
  }
  const output = text(result.stdout);
  const cwdToken = output.split('\0').map((token) => token.replace(/^[\r\n]+/, ''))
    .find((token) => token.startsWith('n'));
  if (!cwdToken || cwdToken.length === 1) {
    return { status: 'incomplete', detail: 'lsof did not report a process cwd.' };
  }
  try {
    return { status: 'ok', cwd: realpathSync(cwdToken.slice(1)) };
  } catch (error) {
    return { status: 'incomplete', detail: 'Cannot resolve process cwd: ' + error.message };
  }
}

function readLinuxCwd(pid) {
  try {
    const link = readlinkSync('/proc/' + pid + '/cwd');
    if (link.endsWith(' (deleted)')) {
      return { status: 'incomplete', detail: 'The process cwd has been deleted.' };
    }
    return { status: 'ok', cwd: realpathSync('/proc/' + pid + '/cwd') };
  } catch (error) {
    return { status: 'incomplete', detail: 'Cannot read process cwd: ' + error.message };
  }
}

function readOwnerCwd(pid, platform) {
  if (platform === 'linux') return readLinuxCwd(pid);
  if (platform === 'darwin') return readMacCwd(pid);
  return { status: 'incomplete', detail: 'Process cwd lookup is supported on Linux and macOS.' };
}

const defaultOperations = { readGitInfo, queryListeners, readOwnerCwd };

export function inspectPort(port, cwd = process.cwd(), platform = process.platform, operations = defaultOperations) {
  const current = operations.readGitInfo(cwd);
  const errors = [];
  if (current.status !== 'git') {
    return {
      port,
      current,
      listeners: [],
      errors: current.status === 'non_git'
        ? ['Run this command from a Git worktree.']
        : [current.detail],
      stable: null,
    };
  }

  const first = operations.queryListeners(port);
  errors.push(...first.errors);
  const listeners = [];
  for (const found of first.listeners) {
    const cwdResult = operations.readOwnerCwd(found.pid, platform);
    if (cwdResult.status !== 'ok') {
      listeners.push({
        ...found,
        cwd: null,
        root: null,
        branch: null,
        comparison: { status: 'incomplete', detail: cwdResult.detail },
      });
      continue;
    }

    const owner = operations.readGitInfo(cwdResult.cwd);
    const comparison = classifyOwner(current, owner);
    listeners.push({
      ...found,
      cwd: cwdResult.cwd,
      root: owner.root || null,
      branch: owner.branch || null,
      comparison,
    });
  }

  const second = operations.queryListeners(port);
  errors.push(...second.errors);
  const stable = sameListenerSet(first.listeners, second.listeners);
  if (!stable) errors.push('The listener list changed during inspection.');

  return {
    port,
    current: {
      status: 'git',
      root: current.root,
      branch: current.branch,
      commonDir: current.commonDir,
    },
    listeners,
    errors,
    stable,
  };
}
