#!/usr/bin/env bash
# Generates Android launcher icons and splash screens from public/favicon.svg.
# Requires: rsvg-convert, magick (ImageMagick 7)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$REPO_ROOT/public/favicon.svg"
RES="$REPO_ROOT/android/app/src/main/res"

APP_NAME="Form* Drive"
TEXT_COLOR="#0B7AE8"
BG_COLOR="white"

# ── Launcher icons ──────────────────────────────────────────────────────────

declare -A SIZES=(
  [mipmap-mdpi]=48
  [mipmap-hdpi]=72
  [mipmap-xhdpi]=96
  [mipmap-xxhdpi]=144
  [mipmap-xxxhdpi]=192
)

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
  # Use 50% of canvas so the icon fits comfortably within any mask shape
  icon_in_fg=$(( fg_canvas / 2 ))
  dir="$RES/$density"

  rsvg-convert -w "$size" -h "$size" "$SVG" | \
    magick - -background white -flatten "$dir/ic_launcher.png"
  echo "✓ $density/ic_launcher.png (${size}x${size})"

  rsvg-convert -w "$icon_in_fg" -h "$icon_in_fg" "$SVG" | \
    magick - \
      -background none \
      -gravity Center \
      -extent "${fg_canvas}x${fg_canvas}" \
      "$dir/ic_launcher_foreground.png"
  echo "✓ $density/ic_launcher_foreground.png (${fg_canvas}x${fg_canvas}, icon ${icon_in_fg}px)"
done

# ── Splash screens ───────────────────────────────────────────────────────────

generate_splash() {
  local out_dir="$1" width="$2" height="$3"
  local min_dim=$(( width < height ? width : height ))
  local icon_size=$(( min_dim * 35 / 100 ))
  local font_size=$(( icon_size * 18 / 100 ))
  local gap=$(( icon_size / 10 ))
  local out="$RES/$out_dir/splash.png"

  local icon_tmp text_tmp
  icon_tmp=$(mktemp /tmp/icon_XXXXXX.png)
  text_tmp=$(mktemp /tmp/text_XXXXXX.png)

  rsvg-convert -w "$icon_size" -h "$icon_size" "$SVG" -o "$icon_tmp"

  magick -background "$BG_COLOR" -fill "$TEXT_COLOR" \
    -font Adwaita-Sans-Bold -pointsize "$font_size" \
    label:"$APP_NAME" "$text_tmp"

  local text_w text_h
  text_w=$(magick identify -format "%w" "$text_tmp")
  text_h=$(magick identify -format "%h" "$text_tmp")

  local total_h=$(( icon_size + gap + text_h ))
  local icon_x=$(( (width  - icon_size) / 2 ))
  local icon_y=$(( (height - total_h)   / 2 ))
  local text_x=$(( (width  - text_w)    / 2 ))
  local text_y=$(( icon_y + icon_size + gap ))

  magick -size "${width}x${height}" "xc:$BG_COLOR" \
    "$icon_tmp" -geometry "+${icon_x}+${icon_y}" -composite \
    "$text_tmp" -geometry "+${text_x}+${text_y}" -composite \
    "$out"

  rm -f "$icon_tmp" "$text_tmp"
  echo "✓ $out_dir/splash.png (${width}x${height})"
}

# Portrait
generate_splash drawable-port-mdpi    320  480
generate_splash drawable-port-hdpi    480  800
generate_splash drawable-port-xhdpi   720 1280
generate_splash drawable-port-xxhdpi  960 1600
generate_splash drawable-port-xxxhdpi 1280 1920

# Landscape
generate_splash drawable-land-mdpi    480  320
generate_splash drawable-land-hdpi    800  480
generate_splash drawable-land-xhdpi  1280  720
generate_splash drawable-land-xxhdpi 1600  960
generate_splash drawable-land-xxxhdpi 1920 1280

# Default (hdpi fallback)
generate_splash drawable 480 320

echo ""
echo "Done. Assets written to android/app/src/main/res/"
