# Changelog

## 0.3.0 — 2026-11-25

Four commands that need no account and no API key. They send a plain GET to the site's public JSON routes, with no Authorization header.

- `film <contract address or token link>`: the home page's free instant film (`GET /api/instant-film`, no AI). Prints the token's name, symbol and chain, its market cap, liquidity, 24h volume and holders, its HEY builder record when it has one, the Dexscreener pair, the link that plays the film and the sign-up link that turns it into an editable video. `--open` opens the film in the browser; `--json` leaves out the player's document (about 160 KB of scenes and images) and adds `film_url` and `make_url`.
- `live [--limit <n>]`: the latest Robinhood Chain events from loudscene Score (`GET /api/creators/live`): launches with their market cap, KOL calls and founder seats, with the time in UTC and a score.loudscene.com link each.
- `launches`: the Torch tokens that used loudscene (`GET /api/torch/loud-launches`), with contract, start date, what they used, Score page, and the rule for the list.
- `seats`: `27 of 50 Season 1 founder seats taken, 23 left.` (`GET /api/creators/seats`).
- Rate limits: on a 429 the CLI prints the server's message and its Retry-After, exits 1 and does not retry. Requests time out after 30 s.
- `--api-url` / `LOUDSCENE_API_URL` apply to the new commands too; Score links then point at that server.
- Dev tooling: vite (pulled in by vitest) goes from 8.3.5 to 8.3.8 and rolldown to 1.2.19, for GHSA-p4f5-76q4-ffq7 (code execution through a vite dev server exposed to the network; the CLI never starts one). `pnpm audit`: no known vulnerabilities. Still no runtime dependencies.

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
