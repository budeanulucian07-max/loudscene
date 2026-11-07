#!/usr/bin/env bash
# Change a film's text, look at a few frames, then render: the edit uses no AI and the stills are
# free, so only the render spends a credit.
#   LOUDSCENE_API_KEY=ls_live_… ./examples/edit-and-render.sh <video id>
# Uses the `loudscene` command (npm link after building from source, or npx loudscene).
set -euo pipefail
VIDEO="${1:?usage: edit-and-render.sh <video id>}"

# 1. The video's fields: keys, types and current values.
loudscene status "$VIDEO"

# 2. New values. key=value is text; key:=<json> is a number, toggle, image or list.
#    Use the keys step 1 printed: "headline" is only an example.
loudscene update "$VIDEO" --field headline="Live on mainnet" --note "new headline"

# 3. PNG frames of the new version, saved to ./frames, to check the look.
loudscene stills "$VIDEO" --at 1,6,12 -o ./frames

# 4. The MP4s, then download each one: loudscene download <render id> -o ./videos
loudscene render "$VIDEO" --formats 9:16,1:1 --wait
