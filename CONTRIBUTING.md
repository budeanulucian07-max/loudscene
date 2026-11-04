# Contributing

Thanks for helping make loudscene louder.

1. Fork, then `pnpm install`.
2. Make the change with a test next to it (`test/`, vitest).
3. `pnpm typecheck && pnpm test && pnpm build` must pass.
4. Open a pull request that says what changes for the person running the CLI.

Keep the CLI dependency-free at runtime (Node 20's `fetch`, `node:util` `parseArgs`). Keys are only
ever sent as the `Authorization` header, never in a URL or a log line; please keep it that way.

Bugs and ideas: [open an issue](https://github.com/budeanulucian07-max/loudscene/issues/new/choose).
Questions about your account or credits: contact@loudscene.com.
