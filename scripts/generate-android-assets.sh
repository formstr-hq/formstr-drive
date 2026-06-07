#!/usr/bin/env bash
# Generates Android launcher icons from public/favicon.svg.
# Requires: rsvg-convert, magick (ImageMagick 7)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$REPO_ROOT/public/favicon.svg"
RES="$REPO_ROOT/android/app/src/main/res"

declare -A SIZES=(
  [mipmap-mdpi]=48
  [mipmap-hdpi]=72
  [mipmap-xhdpi]=96
  [mipmap-xxhdpi]=144
  [mipmap-xxxhdpi]=192
)

# Adaptive icon foreground canvas is 108dp; icon occupies center 72dp (66.67%)
declare -A FG_CANVAS=(
  [mipmap-mdpi]=108
  [mipmap-hdpi]=162
  [mipmap-xhdpi]=216
  [mipmap-xxhdpi]=324
  [mipmap-xxxhdpi]=432
)

for density in "${!SIZES[@]}"; do
  size=${SIZES[$density]}
  fg_canvas=${FG_CANVAS[$density]}
  icon_in_fg=$(( fg_canvas * 2 / 3 ))  # 66.67% of canvas
  dir="$RES/$density"

  # ic_launcher.png — square on white background
  rsvg-convert -w "$size" -h "$size" "$SVG" | \
    magick - -background white -flatten "$dir/ic_launcher.png"
  echo "✓ $density/ic_launcher.png (${size}x${size})"

  # ic_launcher_foreground.png — icon centered in 108dp adaptive canvas (transparent bg)
  rsvg-convert -w "$icon_in_fg" -h "$icon_in_fg" "$SVG" | \
    magick - \
      -background none \
      -gravity Center \
      -extent "${fg_canvas}x${fg_canvas}" \
      "$dir/ic_launcher_foreground.png"
  echo "✓ $density/ic_launcher_foreground.png (${fg_canvas}x${fg_canvas}, icon ${icon_in_fg}px)"
done

echo ""
echo "Done. Icons written to android/app/src/main/res/mipmap-*"
