"""Standalone check that OpenCV never loads an OpenCL driver inside the
server. With onnxruntime-migraphx loaded, Mesa's rusticl OpenCL driver
crashed the whole process (two LLVMs in one process). The check runs in a
child process so the real crash, if it ever came back, cannot take the test
runner down with it. No pytest.

Run with:

    .venv/bin/python -m backend.test_opencl_off
"""
import subprocess
import sys

CHILD = """
import backend.server as server
try:
    import cv2
except ImportError:
    print("skip"); raise SystemExit(0)
print("opencl" if cv2.ocl.haveOpenCL() else "off")
"""


def test_opencv_opencl_is_disabled():
    r = subprocess.run([sys.executable, "-c", CHILD], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, f"server process died (code {r.returncode}): {r.stderr[-400:]}"
    assert r.stdout.strip().splitlines()[-1] in ("off", "skip"), r.stdout


if __name__ == "__main__":
    test_opencv_opencl_is_disabled()
    print("OK")
