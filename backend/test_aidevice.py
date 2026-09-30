"""Standalone check for AI device selection (ort_providers / ort_session). No
pytest. onnxruntime is monkeypatched, so no GPU or model is needed.

Run with:

    .venv/bin/python -m backend.test_aidevice
"""
import os

import onnxruntime as ort

import backend.server as server


class _Sess:
    def __init__(self, path, providers):
        if providers[0] == "MIGraphXExecutionProvider" and _Sess.fail_gpu:
            raise RuntimeError("driver missing")
        self._p = providers

    def get_providers(self):
        return self._p

    fail_gpu = False


def _patched(avail, fn):
    saved = ort.get_available_providers, ort.InferenceSession, os.environ.get("MANTIPHY_AI_DEVICE")
    ort.get_available_providers, ort.InferenceSession = (lambda: avail), _Sess
    server._ai_device_active = None
    try:
        fn()
    finally:
        ort.get_available_providers, ort.InferenceSession = saved[0], saved[1]
        os.environ.pop("MANTIPHY_AI_DEVICE", None)
        if saved[2] is not None:
            os.environ["MANTIPHY_AI_DEVICE"] = saved[2]
        server._ai_device_active = None


def test_prefers_gpu_and_reports_it():
    def body():
        assert server.ort_providers() == ["MIGraphXExecutionProvider", "CPUExecutionProvider"]
        assert server.ai_device() == "GPU (MIGraphX)"  # predicted
        server.ort_session("m.onnx")
        assert server.ai_device() == "GPU (MIGraphX)"  # measured
    _patched(["CPUExecutionProvider", "AzureExecutionProvider", "MIGraphXExecutionProvider"], body)


def test_falls_back_to_cpu_when_the_gpu_wont_start():
    def body():
        _Sess.fail_gpu = True
        try:
            s = server.ort_session("m.onnx")
        finally:
            _Sess.fail_gpu = False
        assert s.get_providers() == ["CPUExecutionProvider"]
        assert server.ai_device() == "CPU"
    _patched(["MIGraphXExecutionProvider", "CPUExecutionProvider"], body)


def test_env_forces_cpu():
    def body():
        os.environ["MANTIPHY_AI_DEVICE"] = "cpu"
        assert server.ort_providers() == ["CPUExecutionProvider"]
    _patched(["CUDAExecutionProvider", "CPUExecutionProvider"], body)


if __name__ == "__main__":
    test_prefers_gpu_and_reports_it()
    test_falls_back_to_cpu_when_the_gpu_wont_start()
    test_env_forces_cpu()
    print("OK")
