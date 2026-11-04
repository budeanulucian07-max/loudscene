#!/usr/bin/env bash
# The same with curl: create a token's launch film from its contract address.
#   LOUDSCENE_API_KEY=ls_live_… ./examples/token-film.sh 0xCD291FA4d3e2Eb43e4639625092D31ae10E61111
set -euo pipefail
curl -s https://www.loudscene.com/api/v1/videos \
  -H "Authorization: Bearer $LOUDSCENE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || date +%s%N)" \
  -d "{\"token\": \"$1\", \"format\": \"16:9\"}"
# → { "id": "…", "status": "generating", … }  then GET /api/v1/videos/{id} until "ready",
#   POST /api/v1/videos/{id}/variants {"formats":["16:9"]} and GET /api/v1/renders/{id} for the MP4.
