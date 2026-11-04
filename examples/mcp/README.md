# MCP configs

| Client | File | Where it goes |
|---|---|---|
| Claude Code | [`claude-code.sh`](claude-code.sh) | run it once in a terminal |
| Cursor | [`cursor.mcp.json`](cursor.mcp.json) | `~/.cursor/mcp.json` or `.cursor/mcp.json` in a project |
| Claude Desktop | [`claude_desktop_config.json`](claude_desktop_config.json) | Settings → Developer → Edit Config (uses the CLI's stdio bridge) |
| Windsurf | [`windsurf.mcp_config.json`](windsurf.mcp_config.json) | `~/.codeium/windsurf/mcp_config.json` |

Replace `ls_live_…` with a key from loudscene → Settings → API keys. Claude and ChatGPT can also
connect without a key, as a connector with sign-in: see https://www.loudscene.com/docs/mcp.
