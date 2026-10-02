# Contributing

Thanks for taking a look at worktree-port-check.

## Development

Use Node.js 20 or newer and Git.

```sh
npm test
```

The test suite uses Node's built-in test runner and does not need a package install.

## Changes

Keep process inspection read-only. Do not add commands that stop or change a listener, bind to its port, or request an application URL.

For a behavior change, include a test that covers the listener record and the checkout comparison. Update the README when a command or result changes.
