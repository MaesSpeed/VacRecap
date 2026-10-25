#!/usr/bin/env bash
# Wikimedia Commons → lokale JPEGs (Entwicklungszeit). Nicht zur Laufzeit laden.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/covers"
mkdir -p "$OUT"

fetch() {
  local id="$1"
  local url_name="$2"
  local out_main="$OUT/${id}.jpg"
  local out_thumb="$OUT/${id}-thumb.jpg"
  local tmp="$OUT/.tmp-${id}.jpg"
  local encoded
  encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$url_name'))")
  echo "→ $id"
  curl -fsSL "https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=1000" -o "$tmp"
  ffmpeg -y -loglevel error -i "$tmp" -vf "scale='min(1000,iw)':-2" -q:v 6 "$out_main"
  ffmpeg -y -loglevel error -i "$out_main" -vf "scale=200:-2" -q:v 6 "$out_thumb"
  rm -f "$tmp"
  ls -la "$out_main" "$out_thumb"
}

fetch stadt "Eiffel Tower and Pont Alexandre III at night.jpg"
fetch strand "Havelock Island, Sandy lagoon, Andaman Islands.jpg"
fetch berge "Panixersee (Lag da Pigniu) boven Andiast. 26-09-2025. (d.j.b.) 14.jpg"
fetch wald "Dülmen, Wildpark -- 2015 -- 8871-7.jpg"
fetch roadtrip "Amboy (California, USA), Hist. Route 66 -- 2012 -- 5705.jpg"
fetch winter "Snow Scene at Shipka Pass 1.JPG"

echo "Done."
