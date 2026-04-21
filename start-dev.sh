#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID=""
FRONTEND_PID=""
CLEANUP_DONE=0

cleanup() {
  [[ "${CLEANUP_DONE}" -eq 1 ]] && return
  CLEANUP_DONE=1

  trap - INT TERM EXIT

  stop_tree "${BACKEND_PID}"
  stop_tree "${FRONTEND_PID}"

  wait "${BACKEND_PID}" 2>/dev/null || true
  wait "${FRONTEND_PID}" 2>/dev/null || true
}

signal_exit() {
  local exit_code="$1"
  cleanup
  exit "${exit_code}"
}

kill_tree() {
  local pid="$1"
  local signal="$2"
  local child=""

  [[ -z "${pid}" ]] && return
  kill -0 "${pid}" 2>/dev/null || return

  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
    kill_tree "${child}" "${signal}"
  done

  kill -"${signal}" "${pid}" 2>/dev/null || true
}

stop_tree() {
  local pid="$1"

  [[ -z "${pid}" ]] && return
  kill -0 "${pid}" 2>/dev/null || return

  kill_tree "${pid}" INT
  sleep 1

  kill -0 "${pid}" 2>/dev/null || return
  kill_tree "${pid}" TERM
  sleep 2

  kill -0 "${pid}" 2>/dev/null || return
  kill_tree "${pid}" KILL
}

trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM
trap cleanup EXIT

cd "${ROOT_DIR}"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Missing .venv/bin/python. Create the virtualenv first." >&2
  echo "Example: ~/.pyenv/versions/3.10.0/bin/python -m venv .venv" >&2
  exit 1
fi

if [[ ! -d "web/node_modules" ]]; then
  echo "Missing web/node_modules. Run: npm install --prefix web" >&2
  exit 1
fi

echo "Starting backend on http://localhost:8001"
".venv/bin/python" -m server.server --reload &
BACKEND_PID=$!

echo "Starting frontend on http://localhost:3000"
(
  cd "${ROOT_DIR}/web"
  npm run dev
) &
FRONTEND_PID=$!

echo "Backend PID: ${BACKEND_PID}"
echo "Frontend PID: ${FRONTEND_PID}"
echo "Press Ctrl-C to stop both servers."

while true; do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    wait "${BACKEND_PID}" 2>/dev/null || true
    break
  fi

  if ! kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    wait "${FRONTEND_PID}" 2>/dev/null || true
    break
  fi

  sleep 1
done
