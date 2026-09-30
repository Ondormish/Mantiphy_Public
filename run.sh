#!/usr/bin/env bash
# Mantiphy launcher — creates a venv on first run, then starts the app.
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run: creating virtual environment…"
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip >/dev/null
  .venv/bin/pip install -r requirements.txt
fi
for arg in "$@"; do
  case "$arg" in
    --with-ai)   .venv/bin/pip install -r requirements-ai.txt ;;
    --with-hdr)  .venv/bin/pip install -r requirements-hdr.txt ;;
    --with-panorama) .venv/bin/pip install -r requirements-panorama.txt ;;
    --with-camera-profile) .venv/bin/pip install -r requirements-cameraprofile.txt ;;
    --with-ai-gpu)
      # AI denoise / masks on the GPU: swap the CPU onnxruntime for a GPU build.
      # Mantiphy picks the GPU automatically once onnxruntime reports it
      # (MANTIPHY_AI_DEVICE=cpu forces the CPU again).
      .venv/bin/pip install -r requirements-ai.txt
      GPUS=$(lspci 2>/dev/null | grep -Ei "vga|3d|display" || true)
      if echo "$GPUS" | grep -q NVIDIA; then
        .venv/bin/pip uninstall -y onnxruntime >/dev/null 2>&1 || true
        .venv/bin/pip install onnxruntime-gpu
      elif echo "$GPUS" | grep -Eq "AMD|ATI"; then
        # Microsoft's onnxruntime-migraphx wheel (PyPI) links against the system
        # MIGraphX/HIP libraries, so those have to come from the distribution.
        .venv/bin/pip uninstall -y onnxruntime >/dev/null 2>&1 || true
        .venv/bin/pip install onnxruntime-migraphx
        if ! ldconfig -p 2>/dev/null | grep -q "libmigraphx_c.so.3"; then
          echo "  AMD GPU detected: onnxruntime-migraphx is installed, but it needs the MIGraphX"
          echo "  libraries from ROCm 7.x on the system (about 5 GB with its compiler toolchain):"
          echo "    Fedora / Nobara:  sudo dnf install migraphx"
          echo "    Ubuntu / Debian:  add AMD's ROCm apt repository, then sudo apt install migraphx"
          echo "  Until then AI features keep running on the CPU."
        fi
        echo "  The first use of each AI model compiles it for your GPU (a few minutes, once)."
      else
        echo "  No NVIDIA/AMD GPU found — AI features stay on the CPU."
      fi
      .venv/bin/python -c "import onnxruntime as o; print('  AI providers available:', ', '.join(o.get_available_providers()))" 2>/dev/null
      ;;
    --with-heal)
      .venv/bin/pip install -r requirements-inpaint.txt
      # --no-deps on purpose: see the header of requirements-inpaint.txt
      .venv/bin/pip install --no-deps 'simple-lama-inpainting>=0.1.2'
      .venv/bin/python -c "
import torch
if torch.cuda.is_available():
    print('  Object removal will run on: GPU (' + torch.cuda.get_device_name(0) + ')')
else:
    print('  Object removal will run on: CPU (fine, just slower). To use your GPU instead:')
    import subprocess
    gpus = subprocess.run(['bash','-c','lspci 2>/dev/null | grep -Ei \"vga|3d|display\"'], capture_output=True, text=True).stdout
    if 'AMD' in gpus or 'ATI' in gpus:
        print('    AMD GPU detected — reinstall torch with a ROCm wheel, then rerun ./run.sh --with-heal:')
        print('    .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/rocm7.1')
        print('    (needs the amdgpu kernel driver + your user in the render/video groups — both are standard on a desktop AMD install)')
    elif 'NVIDIA' in gpus:
        print('    NVIDIA GPU detected — reinstall torch with a CUDA wheel, then rerun ./run.sh --with-heal:')
        print('    .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121')
    else:
        print('    See https://pytorch.org/get-started/locally/ for the right command for your GPU.')
" 2>/dev/null
      ;;
    --install-desktop)
      # App-menu entry pointing at wherever this copy lives, plus its icon.
      APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
      ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
      mkdir -p "$APPS" "$ICONS/scalable/apps" "$ICONS/512x512/apps"
      cp mantiphy.svg "$ICONS/scalable/apps/mantiphy.svg"
      cp mantiphy.png "$ICONS/512x512/apps/mantiphy.png"
      sed "s|^Exec=.*|Exec=\"$PWD/run.sh\"|" mantiphy.desktop > "$APPS/mantiphy.desktop"
      update-desktop-database "$APPS" >/dev/null 2>&1 || true
      gtk-update-icon-cache -q "$ICONS" >/dev/null 2>&1 || true
      echo "  Added Mantiphy to your application menu."
      exit 0
      ;;
    --with-all)
      .venv/bin/pip install -r requirements-ai.txt -r requirements-inpaint.txt -r requirements-hdr.txt -r requirements-panorama.txt -r requirements-cameraprofile.txt
      .venv/bin/pip install --no-deps 'simple-lama-inpainting>=0.1.2'
      ;;
  esac
done
PORT="${MANTIPHY_PORT:-7878}"
URL="http://127.0.0.1:$PORT"
.venv/bin/python backend/server.py &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s "$URL/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
# Prefer an app-mode window (no browser chrome) when a Chromium-family browser is around.
for B in chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge; do
  if command -v "$B" >/dev/null 2>&1; then
    "$B" --app="$URL" --user-data-dir="${XDG_DATA_HOME:-$HOME/.local/share}/mantiphy/chrome-profile" >/dev/null 2>&1
    exit 0
  fi
done
xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL in your browser."
wait $PID
