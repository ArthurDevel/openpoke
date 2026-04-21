#!/bin/zsh

set -euo pipefail

ROOT_PATH="${CONDUCTOR_ROOT_PATH:-}"

if [[ -n "${ROOT_PATH}" ]]; then
  for f in "${ROOT_PATH}"/.env*(.N); do
    [[ "${f}" == *.example ]] && continue
    ln -sf "${f}" .
  done
fi

pick_python() {
  local candidate=""

  for candidate in \
    "$HOME/.pyenv/versions/3.10.0/bin/python" \
    python3.10 \
    python3
  do
    if [[ "${candidate}" == /* ]]; then
      [[ -x "${candidate}" ]] && echo "${candidate}" && return 0
      continue
    fi

    if command -v "${candidate}" >/dev/null 2>&1; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

if [[ ! -x ".venv/bin/python" ]]; then
  PYTHON_BIN="$(pick_python)" || {
    echo "Could not find a Python interpreter for creating .venv" >&2
    exit 1
  }

  "${PYTHON_BIN}" -m venv .venv
fi

".venv/bin/python" -m pip install --upgrade pip
".venv/bin/python" -m pip install -r server/requirements.txt

npm install --prefix web
