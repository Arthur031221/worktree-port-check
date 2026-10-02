export const EXIT = Object.freeze({
  MATCH: 0,
  MISMATCH: 1,
  NO_LISTENER: 2,
  NON_GIT: 3,
  INCOMPLETE: 4,
  USAGE: 64,
});

export function parseArgs(args) {
  let portText = null;
  let json = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      return { action: 'help' };
    }
    if (arg === '--json') {
      if (json) return { error: 'Use --json once.' };
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: 'Unknown option: ' + arg };
    }
    if (portText !== null) {
      return { error: 'Pass one port number.' };
    }
    portText = arg;
  }

  if (portText === null) return { error: 'Pass a TCP port number.' };
  if (!/^[0-9]+$/.test(portText)) {
    return { error: 'Port must be a number from 1 to 65535.' };
  }

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { error: 'Port must be a number from 1 to 65535.' };
  }

  return { action: 'inspect', port, json };
}

export function parseLsofOutput(input) {
  const output = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const processes = [];
  let process = null;
  let file = null;
  let sawProtocol = false;
  let sawTcpState = false;

  function beginProcess(pid) {
    process = { pid, command: null, files: [] };
    processes.push(process);
    file = null;
  }

  for (const rawToken of output.split('\0')) {
    const token = rawToken.replace(/^[\r\n]+/, '');
    if (token.length === 0) continue;

    const field = token[0];
    const value = token.slice(1);

    if (field === 'p') {
      beginProcess(value);
      continue;
    }
    if (process === null) continue;
    if (field === 'c') {
      process.command = value;
      continue;
    }
    if (field === 'f') {
      file = { fd: value, name: null, protocol: null, states: [] };
      process.files.push(file);
      continue;
    }
    if (file === null) continue;
    if (field === 'n') {
      file.name = value;
    } else if (field === 'P') {
      file.protocol = value;
      if (value === 'TCP') sawProtocol = true;
    } else if (field === 'T') {
      file.states.push(value);
      if (value.startsWith('ST=')) sawTcpState = true;
    }
  }

  const byPid = new Map();
  for (const item of processes) {
    const listeningFiles = item.files.filter((entry) =>
      entry.protocol === 'TCP' && entry.states.includes('ST=LISTEN')
    );
    if (listeningFiles.length === 0) continue;

    const previous = byPid.get(item.pid);
    if (previous) {
      previous.files.push(...listeningFiles);
    } else {
      byPid.set(item.pid, {
        pid: item.pid,
        command: item.command,
        files: listeningFiles,
      });
    }
  }

  const listeners = [...byPid.values()].map((item) => ({
    pid: item.pid,
    command: item.command,
    fds: [...new Set(item.files.map((entry) => entry.fd))].sort(),
    names: [...new Set(item.files.map((entry) => entry.name).filter(Boolean))].sort(),
  }));

  return {
    listeners: listeners.sort((a, b) => Number(a.pid) - Number(b.pid)),
    parseable: sawProtocol && sawTcpState,
  };
}

export function sameListenerSet(left, right) {
  const signature = (items) => items
    .map((item) => [
      item.pid,
      item.command || '',
      [...item.fds].sort().join(','),
      [...(item.names || [])].sort().join(','),
    ].join(':'))
    .sort()
    .join('|');
  return signature(left) === signature(right);
}

export function classifyOwner(current, owner) {
  if (!owner || (owner.status !== 'git' && owner.status !== 'non_git')) {
    return { status: 'incomplete', detail: owner?.detail || 'Owner details are unavailable.' };
  }
  if (owner.status === 'non_git') {
    return { status: 'non_git', detail: 'The process cwd is outside a Git worktree.' };
  }
  if (owner.root === current.root) {
    return { status: 'match', detail: 'The process cwd resolves to this checkout.' };
  }
  if (owner.commonDir === current.commonDir) {
    return { status: 'other_worktree', detail: 'The process cwd belongs to another worktree in this repository.' };
  }
  return { status: 'other_repository', detail: 'The process cwd belongs to a different Git repository.' };
}

export function exitCode(report) {
  if (report.current?.status !== 'git') return EXIT.INCOMPLETE;
  if (report.listeners.some((item) =>
    item.comparison.status === 'other_worktree' ||
    item.comparison.status === 'other_repository'
  )) return EXIT.MISMATCH;
  if (report.errors.length > 0 ||
      report.listeners.some((item) => item.comparison.status === 'incomplete') ||
      report.stable === false) return EXIT.INCOMPLETE;
  if (report.listeners.length === 0) return EXIT.NO_LISTENER;
  if (report.listeners.some((item) => item.comparison.status === 'non_git')) {
    return EXIT.NON_GIT;
  }
  return EXIT.MATCH;
}

export function renderHuman(report) {
  const lines = [];
  lines.push('worktree-port-check ' + report.port);
  if (report.current?.status === 'git') {
    lines.push('Checkout: ' + report.current.branch + ' at ' + report.current.root);
  } else {
    lines.push('Checkout: not a Git worktree');
  }

  if (report.listeners.length === 0) {
    lines.push('Listener: none visible');
  }

  for (const item of report.listeners) {
    lines.push('');
    lines.push('PID ' + item.pid + ' (' + (item.command || 'unknown') + ')');
    lines.push('  cwd:    ' + (item.cwd || 'unavailable'));
    lines.push('  Git:    ' + (item.root || 'not detected'));
    lines.push('  branch: ' + (item.branch || 'unavailable'));
    lines.push('  result: ' + item.comparison.status.toUpperCase());
    lines.push('  detail: ' + item.comparison.detail);
  }

  for (const error of report.errors) {
    lines.push('Inspection: ' + error);
  }

  const code = exitCode(report);
  const summary = {
    [EXIT.MATCH]: 'The listener cwd matches this checkout.',
    [EXIT.MISMATCH]: 'A listener cwd belongs to another checkout.',
    [EXIT.NO_LISTENER]: 'No visible listener owns this port.',
    [EXIT.NON_GIT]: 'A listener is running outside a Git worktree.',
    [EXIT.INCOMPLETE]: 'The inspection is incomplete.',
  }[code] || 'The command could not inspect this port.';
  lines.push('');
  lines.push(summary);
  return lines.join('\n');
}

export function renderJson(report) {
  return JSON.stringify({
    ...report,
    exitCode: exitCode(report),
  }, null, 2);
}
