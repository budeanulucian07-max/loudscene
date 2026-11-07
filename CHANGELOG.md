# Changelog

## 0.2.0 · 7 Nov 2026

- `update <video id>`: change a video's field values, title and version note through `PATCH /v1/videos/{id}` (the endpoint behind the MCP tool `update_video`). No AI, no cost; saved as a new version. `--field key=value` sends text, `--field key:=<json>` numbers, toggles, images and lists.
- `status <video id>` lists the video's field keys, types and values.
- `stills <video id> --at …`: PNG frames of the current version (`POST /v1/videos/{id}/stills`, MCP `create_stills`). Free. Prints the signed links, or saves the PNGs with `-o`.
- `render --translate de,es`: one translated copy per language through the `locales` of `POST /v1/videos/{id}/variants` (up to 3, one AI generation each). With `--wait` it also waits for the copies and prints their video ids. Without `--translate`, `render --json` is unchanged.
- `loudscene <command> --help` and `loudscene help <command>` show one command's usage and an example; a mistyped command gets a suggestion.
- `examples/edit-and-render.sh`.
- `.github/dependabot.yml`: npm weekly (grouped, no majors), GitHub Actions monthly. `pnpm audit --prod`: no known vulnerabilities; the package still has no runtime dependencies.

## 0.1.0 · 4 Nov 2026

- First public release of the `loudscene` CLI and its stdio MCP bridge.
- `create --token <contract or link>`: a token's launch film from its contract address (live figures and its image).
- `login`, `logout`, `whoami`, `brand`, `brands`, `stories`, `create`, `status`, `render`, `download`, `open`, `mcp`.
- `--json` output on every command, `--wait` for generations and renders, every format (16:9, 9:16, 1:1, 4:5) up to 4K.
