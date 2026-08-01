#!/bin/sh
# systemd ExecStart wrapper for the sense service (see README "Self-updating").
#
# Runs any pending tree swap staged by the in-app updater WHILE NO SERVER IS
# RUNNING, then execs node. systemd's Restart=always brings us back here every
# time the server exits — including the deliberate exit the updater performs
# after staging a new version.
#
# Env overrides (for local testing; production uses the defaults):
#   SENSE_UPDATE_DIR  updater workspace   (default /opt/sense-updates)
#   SENSE_LIVE_DIR    live app tree       (default /opt/sense)
set -u

UPD="${SENSE_UPDATE_DIR:-/opt/sense-updates}"
LIVE="${SENSE_LIVE_DIR:-/opt/sense}"
LOG="$UPD/update.log"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"
}

# Move every top-level entry of $1 except the keep-list (data, .env*) into $2.
move_tree() {
  src="$1"; dst="$2"
  mkdir -p "$dst"
  for entry in "$src"/* "$src"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      data|.env|.env.*) continue ;;
    esac
    mv "$entry" "$dst/" || return 1
  done
  return 0
}

swap_in() {
  # $1 = directory holding the replacement tree
  new_tree="$1"
  rm -rf "$UPD/previous.new"
  if ! move_tree "$LIVE" "$UPD/previous.new"; then
    log "swap: FAILED moving live tree aside; attempting to restore"
    move_tree "$UPD/previous.new" "$LIVE" || log "swap: restore also failed — manual intervention needed"
    return 1
  fi
  if ! move_tree "$new_tree" "$LIVE"; then
    log "swap: FAILED moving new tree in; restoring old tree"
    move_tree "$LIVE" "$UPD/trash.$$" 2>/dev/null
    move_tree "$UPD/previous.new" "$LIVE" || log "swap: restore failed — manual intervention needed"
    return 1
  fi
  return 0
}

if [ -f "$UPD/pending.json" ]; then
  ACTION=$(sed -n 's/.*"action"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$UPD/pending.json")
  log "pending action: $ACTION"
  case "$ACTION" in
    apply)
      STAGING=$(sed -n 's/.*"stagingDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$UPD/pending.json")
      if [ -n "$STAGING" ] && [ -f "$STAGING/packages/server/dist/index.js" ]; then
        if swap_in "$STAGING"; then
          rm -rf "$UPD/previous"
          mv "$UPD/previous.new" "$UPD/previous"
          rm -rf "$UPD/staging" "$UPD/download"
          echo 0 > "$UPD/boot-attempts"
          : > "$UPD/verify.flag"
          log "swap: applied $STAGING"
        else
          log "swap: apply failed; keeping current version"
        fi
      else
        log "swap: staging dir missing or incomplete ($STAGING); skipping"
      fi
      ;;
    rollback)
      if [ -f "$UPD/previous/packages/server/dist/index.js" ]; then
        if swap_in "$UPD/previous"; then
          # The replaced tree lands in previous/ so the files aren't lost,
          # but the app-side rollback slot (KV) is marked spent — the UI
          # won't offer a rollback ping-pong.
          rm -rf "$UPD/previous"
          mv "$UPD/previous.new" "$UPD/previous" 2>/dev/null || true
          rm -f "$UPD/verify.flag"
          echo 0 > "$UPD/boot-attempts"
          log "swap: rolled back"
        else
          log "swap: rollback failed; keeping current version"
        fi
      else
        log "swap: no previous tree to roll back to; skipping"
      fi
      ;;
    *)
      log "swap: unknown action '$ACTION'; ignoring"
      ;;
  esac
  rm -f "$UPD/pending.json"
fi

# Crash-loop guard: if a freshly swapped-in version keeps dying before the
# server marks itself healthy (which deletes verify.flag), revert.
if [ -f "$UPD/verify.flag" ]; then
  ATTEMPTS=$(cat "$UPD/boot-attempts" 2>/dev/null || echo 0)
  ATTEMPTS=$((ATTEMPTS + 1))
  echo "$ATTEMPTS" > "$UPD/boot-attempts"
  if [ "$ATTEMPTS" -gt 3 ]; then
    log "crash-loop: $ATTEMPTS failed boots on the new version; auto-reverting"
    if [ -f "$UPD/previous/packages/server/dist/index.js" ] && swap_in "$UPD/previous"; then
      rm -rf "$UPD/previous"
      mv "$UPD/previous.new" "$UPD/previous" 2>/dev/null || true
      : > "$UPD/reverted.flag"
      log "crash-loop: reverted"
    else
      log "crash-loop: no previous tree to revert to"
    fi
    rm -f "$UPD/verify.flag"
    echo 0 > "$UPD/boot-attempts"
  fi
fi

exec node "$LIVE/packages/server/dist/index.js"
