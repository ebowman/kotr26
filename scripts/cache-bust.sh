#!/bin/bash
# Stamp all local asset references in HTML files with ?v=<git-short-hash>
# for cache busting on GitHub Pages.
#
# Usage: ./scripts/cache-bust.sh
# Typically run before committing a release.

set -e
cd "$(dirname "$0")/.."

HASH=$(git rev-parse --short HEAD)
echo "Cache-busting with hash: $HASH"

FILES="index.html flyover.html compare/index.html skyline/index.html pace/index.html radial/index.html"

for f in $FILES; do
    [ -f "$f" ] || continue
    perl -pi -e "
        # Local CSS: href=\"css/...\" or href=\"../css/...\"
        s/(href=\"\.?\.?\/?css\/[^\"?]+)(\?v=[^\"]*)?/\$1?v=$HASH/g;
        # Local JS: src=\"js/...\" or src=\"../js/...\"
        s/(src=\"\.?\.?\/?js\/[^\"?]+)(\?v=[^\"]*)?/\$1?v=$HASH/g;
        # Local sibling inline JS: data-inline.js, gps-inline.js
        s/(src=\"(?:data-inline|gps-inline)\.js)(\?v=[^\"]*)?/\$1?v=$HASH/g;
        # Shared inline-data JS: ../routes/viz-data.js
        s/(src=\"\.\.\/routes\/[^\"?]+)(\?v=[^\"]*)?/\$1?v=$HASH/g;
    " "$f"
    echo "  $f"
done

echo "Done."
