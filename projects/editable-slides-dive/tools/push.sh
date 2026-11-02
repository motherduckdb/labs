#!/bin/bash
# Pull the live Dive, apply a patch script to its scene, check, assemble, push, verify.
# The live Dive is the source of truth: the owner may have edited and saved it in the app.
# Run it from the folder holding deck.json and dive.jsx.
# Usage: DIVE_ID=… FLIGHT_ID=… SHARE_PATH=md:_share/<db>/<uuid> SHARE_ALIAS=<db> path/to/tools/push.sh patches/<change>.py
# Needs motherduck_token in the environment (never print it).
set -eo pipefail
TOOLS=$(cd "$(dirname "$0")" && pwd)
: "${DIVE_ID:?}" "${FLIGHT_ID:?}" "${SHARE_PATH:?}" "${SHARE_ALIAS:?}" "${motherduck_token:?}"
export SHARE_PATH SHARE_ALIAS
duckdb md: -c "COPY (SELECT content FROM MD_GET_DIVE(id := '$DIVE_ID'::UUID)) TO 'live.jsx' (FORMAT csv, HEADER false, QUOTE '');" >/dev/null
perl -i -pe 'chomp if eof' live.jsx
if cmp -s live.jsx dive.jsx; then echo "live == last push"; else echo "live differs from last push: rebuilding from live"; fi
node -e '
const src=require("fs").readFileSync("live.jsx","utf8");
const a=src.indexOf("// __SCENE_START__"), b=src.indexOf("// __SCENE_END__");
const body=src.slice(a,b); const lit=body.slice(body.indexOf("const SCENE = ")+14, body.lastIndexOf(";"));
require("fs").writeFileSync("deck.json", JSON.stringify(JSON.parse(lit),null,1));'
python3 "$1"                                    # edits deck.json in place
node "$TOOLS/../skill/scripts/check-deck.mjs" deck.json | tail -1 # must print ALL DECK CHECKS PASSED (pipefail stops the push otherwise)
node "$TOOLS/assemble.mjs" deck.json "$FLIGHT_ID" dive.jsx | tail -1
duckdb md: -noheader -list -c "
SET VARIABLE c=(SELECT content FROM read_text('dive.jsx'));
SELECT 'pushed version ' || version FROM MD_UPDATE_DIVE_CONTENT(id := '$DIVE_ID'::UUID, content := getvariable('c'), required_resources := [{'url': '$SHARE_PATH', 'alias': '$SHARE_ALIAS'}]);
SELECT 'identical=' || (content = getvariable('c')) FROM MD_GET_DIVE(id := '$DIVE_ID'::UUID);"
