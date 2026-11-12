#!/bin/sh
# turbomarbles-stream.sh — stream the robot league to YouTube from a headless
# FreeBSD machine: a virtual screen (Xvfb), a null audio sink (PulseAudio),
# Chromium showing the stream page, and ffmpeg sending it to YouTube.
#
# Normally started by the turbomarbles_stream rc.d service (which restarts this
# script if it exits); run it by hand to test. Needs:
#   pkg install ffmpeg xorg-vfbserver chromium pulseaudio
#
# Settings (environment, all optional except the key file):
#   STREAM_PAGE   the page to show (default: the 6-team league, lite drawing)
#   STREAM_KEY_FILE  file holding the YouTube stream key (default /usr/local/etc/turbomarbles-stream.key)
#   STREAM_RTMP   ingest URL (default rtmp://a.rtmp.youtube.com/live2)
#   STREAM_SIZE   output size (default 1280x720); the page is laid out at 1920x1080 and scaled
#   STREAM_FPS    frames per second (default 30)
#   STREAM_VBITRATE  video bitrate (default 2500k for 720p; ~4500k for 1080p)
#   STREAM_PRESET    x264 preset (default veryfast; ultrafast if the CPU can't keep up)
#   CHROME        Chromium binary (default: chrome, else chromium)

set -u
PAGE="${STREAM_PAGE:-https://marbles.pacehouse.com/?watch=robots&players=6&lite=1}"
KEY_FILE="${STREAM_KEY_FILE:-/usr/local/etc/turbomarbles-stream.key}"
RTMP="${STREAM_RTMP:-rtmp://a.rtmp.youtube.com/live2}"
SIZE="${STREAM_SIZE:-1280x720}"
FPS="${STREAM_FPS:-30}"
VBITRATE="${STREAM_VBITRATE:-2500k}"
PRESET="${STREAM_PRESET:-veryfast}"
CHROME="${CHROME:-$(command -v chrome || command -v chromium)}"
DISP=":${STREAM_DISPLAY:-99}"

[ -r "$KEY_FILE" ] || { echo "stream: no key file $KEY_FILE" >&2; exit 1; }
KEY="$(tr -d ' \n\r' < "$KEY_FILE")"
W="${SIZE%x*}"; H="${SIZE#*x}"
# Lay the page out at 1920x1080 and draw it at the output size.
SCALE="$(echo "scale=4; $W / 1920" | bc)"

WORK="$(mktemp -d /tmp/tm-stream.XXXXXX)"
export XDG_RUNTIME_DIR="$WORK/run"; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export DISPLAY="$DISP" HOME="$WORK"
PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  pulseaudio --kill 2>/dev/null
  sleep 1; rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "stream: $PAGE at ${SIZE}@${FPS} → $RTMP"

Xvfb "$DISP" -screen 0 "${W}x${H}x24" -nolisten tcp &
PIDS="$PIDS $!"; XVFB=$!
sleep 2

pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit
sleep 1
pactl load-module module-null-sink sink_name=tm >/dev/null
pactl set-default-sink tm

"$CHROME" --user-data-dir="$WORK/chrome" --kiosk --no-first-run --noerrdialogs --disable-infobars \
  --hide-scrollbars --disable-translate --disable-features=Translate,MediaRouter \
  --autoplay-policy=no-user-gesture-required --force-device-scale-factor="$SCALE" \
  --window-position=0,0 --window-size="$W,$H" "$PAGE" >"$WORK/chrome.log" 2>&1 &
PIDS="$PIDS $!"; CHR=$!
sleep 8

# ffmpeg, restarted if it drops (network blips); the whole script exits (and the
# service restarts it) if the screen or the browser dies.
while kill -0 "$XVFB" 2>/dev/null && kill -0 "$CHR" 2>/dev/null; do
  ffmpeg -hide_banner -loglevel warning \
    -thread_queue_size 512 -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${W}x${H}" -i "$DISP" \
    -thread_queue_size 512 -f pulse -i tm.monitor \
    -c:v libx264 -preset "$PRESET" -tune zerolatency -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize "$(( ${VBITRATE%k} * 2 ))k" \
    -pix_fmt yuv420p -g "$(( FPS * 2 ))" \
    -c:a aac -b:a 160k -ar 44100 \
    -f flv "$RTMP/$KEY" &
  FF=$!
  wait "$FF"
  echo "stream: ffmpeg exited ($?), restarting in 5 s" >&2
  sleep 5
done
echo "stream: screen or browser died; exiting" >&2
exit 1
