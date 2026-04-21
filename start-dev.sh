#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID=""
FRONTEND_PID=""
VOICE_AGENT_PID=""
CLEANUP_DONE=0
CURRENT_SCRIPT_PID="$$"

cleanup() {
  [[ "${CLEANUP_DONE}" -eq 1 ]] && return
  CLEANUP_DONE=1

  trap - INT TERM EXIT

  hard_stop_tree "${BACKEND_PID}"
  hard_stop_tree "${FRONTEND_PID}"
  hard_stop_tree "${VOICE_AGENT_PID}"
  hard_stop_repo_processes "${ROOT_DIR}/web/node_modules/.bin/next dev"
  hard_stop_repo_processes "${ROOT_DIR}/voice-agent/node_modules/.bin/tsx src/agent.ts dev"
  hard_stop_repo_processes "${ROOT_DIR}/voice-agent/node_modules/@livekit/agents/dist/ipc/job_proc_lazy_main.js"
  hard_stop_repo_processes "${ROOT_DIR}/\\.venv/bin/python -m server\\.server --reload"
  hard_stop_repo_processes "${ROOT_DIR}/\\.venv/bin/python -c from multiprocessing\\.spawn import spawn_main"
  hard_stop_repo_processes "${ROOT_DIR}/\\.venv/bin/python -c from multiprocessing\\.resource_tracker import main"

  wait "${BACKEND_PID}" 2>/dev/null || true
  wait "${FRONTEND_PID}" 2>/dev/null || true
  wait "${VOICE_AGENT_PID}" 2>/dev/null || true
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

hard_stop_tree() {
  local pid="$1"

  [[ -z "${pid}" ]] && return
  kill -0 "${pid}" 2>/dev/null || return
  kill_tree "${pid}" KILL
}

start_group() {
  local cmd="$1"

  bash -lc "${cmd}" &
  REPLY=$!
}

stop_repo_processes() {
  local pattern="$1"
  local pid=""
  local pgid=""

  for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
    [[ "${pid}" == "${CURRENT_SCRIPT_PID}" ]] && continue
    kill -0 "${pid}" 2>/dev/null || continue
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    if [[ -n "${pgid}" ]]; then
      kill -TERM -- "-${pgid}" 2>/dev/null || true
    else
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done

  sleep 1

  for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
    [[ "${pid}" == "${CURRENT_SCRIPT_PID}" ]] && continue
    kill -0 "${pid}" 2>/dev/null || continue
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    if [[ -n "${pgid}" ]]; then
      kill -KILL -- "-${pgid}" 2>/dev/null || true
    else
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
}

hard_stop_repo_processes() {
  local pattern="$1"
  local pid=""
  local pgid=""

  for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
    [[ "${pid}" == "${CURRENT_SCRIPT_PID}" ]] && continue
    kill -0 "${pid}" 2>/dev/null || continue
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    if [[ -n "${pgid}" ]]; then
      kill -KILL -- "-${pgid}" 2>/dev/null || true
    fi
    kill -KILL "${pid}" 2>/dev/null || true
  done
}

assert_port_available() {
  local port="$1"
  local pid=""
  local command=""

  pid="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  [[ -z "${pid}" ]] && return

  command="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
  if [[ "${command}" == *"${ROOT_DIR}"* ]]; then
    local pgid=""
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    if [[ -n "${pgid}" ]]; then
      kill -TERM -- "-${pgid}" 2>/dev/null || true
      sleep 1
      kill -0 "${pid}" 2>/dev/null && kill -KILL -- "-${pgid}" 2>/dev/null || true
    else
      kill -TERM "${pid}" 2>/dev/null || true
      sleep 1
      kill -0 "${pid}" 2>/dev/null && kill -KILL "${pid}" 2>/dev/null || true
    fi
    return
  fi

  echo "Port ${port} is already in use by another process: ${command}" >&2
  exit 1
}

trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM
trap cleanup EXIT

cd "${ROOT_DIR}"

stop_repo_processes "${ROOT_DIR}/web/node_modules/.bin/next dev"
stop_repo_processes "${ROOT_DIR}/voice-agent/node_modules/.bin/tsx src/agent.ts dev"
stop_repo_processes "${ROOT_DIR}/voice-agent/node_modules/@livekit/agents/dist/ipc/job_proc_lazy_main.js"
stop_repo_processes "${ROOT_DIR}/\\.venv/bin/python -m server\\.server --reload"

assert_port_available 3000
assert_port_available 8001

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Missing .venv/bin/python. Create the virtualenv first." >&2
  echo "Example: ~/.pyenv/versions/3.10.0/bin/python -m venv .venv" >&2
  exit 1
fi

if ! ".venv/bin/python" -c "import fastapi" >/dev/null 2>&1; then
  echo "Installing backend dependencies into .venv"
  ".venv/bin/pip" install -r server/requirements.txt
fi

if grep -q '^LIVEKIT_URL=' .env 2>/dev/null || grep -q '^LIVEKIT_API_KEY=' .env 2>/dev/null || grep -q '^LIVEKIT_API_SECRET=' .env 2>/dev/null; then
  if ! ".venv/bin/python" -c "from livekit import api" >/dev/null 2>&1; then
    echo "Installing Python Talk mode dependencies into .venv"
    ".venv/bin/pip" install -r server/requirements.txt
  fi
fi

if [[ ! -d "web/node_modules" ]]; then
  echo "Installing frontend dependencies"
  npm install --prefix web
fi

if [[ -d "voice-agent" && ! -d "voice-agent/node_modules" ]]; then
  echo "Installing voice-agent dependencies"
  npm install --prefix voice-agent
fi

echo "Starting backend on http://localhost:8001"
start_group "cd \"${ROOT_DIR}\" && exec .venv/bin/python -m server.server --reload"
BACKEND_PID="${REPLY}"

echo "Starting frontend on http://localhost:3000"
start_group "cd \"${ROOT_DIR}/web\" && exec npm run dev -- --port 3000"
FRONTEND_PID="${REPLY}"

if [[ -d "voice-agent" ]]; then
  echo "Starting voice agent"
  start_group "cd \"${ROOT_DIR}/voice-agent\" && exec npm run dev"
  VOICE_AGENT_PID="${REPLY}"
fi

echo "Backend PID: ${BACKEND_PID}"
echo "Frontend PID: ${FRONTEND_PID}"
if [[ -n "${VOICE_AGENT_PID}" ]]; then
  echo "Voice agent PID: ${VOICE_AGENT_PID}"
fi
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

  if [[ -n "${VOICE_AGENT_PID}" ]] && ! kill -0 "${VOICE_AGENT_PID}" 2>/dev/null; then
    wait "${VOICE_AGENT_PID}" 2>/dev/null || true
    break
  fi

  sleep 1
done
