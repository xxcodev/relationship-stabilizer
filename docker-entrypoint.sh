#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" "$DATA_DIR/run" "$DATA_DIR/logs" "$DATA_DIR/shots"

# Remove stale runtime locks left by an ungraceful container stop
if [ -f "$DATA_DIR/run/host.pid" ]; then
  OLD_PID=$(cat "$DATA_DIR/run/host.pid" 2>/dev/null || true)
  if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null || ! tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null | grep -q "node"; then
    rm -f "$DATA_DIR/run/host.pid"
  fi
fi

for lock in "$DATA_DIR/run"/schedule-*.lock; do
  [ -e "$lock" ] || continue
  rm -f "$lock"
done

find "$DATA_DIR" -maxdepth 3 \( -name "SingletonLock" -o -name "SingletonCookie" -o -name "SingletonSocket" \) -delete 2>/dev/null || true

# Start virtual X11 display when running Chromium in headed mode (reduces Douyin headless detection)
case "${BROWSER_HEADLESS:-false}" in
  1|true|TRUE|yes|YES|on|ON)
    ;;
  *)
    DISPLAY_NUM="${DISPLAY:-:99}"
    DISPLAY_ID="${DISPLAY_NUM#:}"
    DISPLAY_ID="${DISPLAY_ID%%.*}"
    rm -f "/tmp/.X${DISPLAY_ID}-lock" "/tmp/.X11-unix/X${DISPLAY_ID}"
    Xvfb "$DISPLAY_NUM" -screen 0 "${BROWSER_WIDTH:-1280}x${BROWSER_HEIGHT:-900}x24" -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    i=0
    while [ "$i" -lt 25 ]; do
      if [ -S "/tmp/.X11-unix/X${DISPLAY_ID}" ]; then
        break
      fi
      if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "Xvfb failed to start; see /tmp/xvfb.log" >&2
        cat /tmp/xvfb.log >&2 || true
        exit 1
      fi
      i=$((i + 1))
      sleep 0.2
    done
    ;;
esac

exec "$@"
