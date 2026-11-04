# Claude Code: one command, the key as a header (leave --header out to sign in with OAuth instead).
claude mcp add --transport http loudscene https://www.loudscene.com/api/mcp \
  --header "Authorization: Bearer ls_live_…"
