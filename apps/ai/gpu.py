# VoltHub AI — GPU resource management (Tier 5 of docs/ai-platform.md).
# Single-host allocator for the 8x A100 pool: enumerate, pick least-loaded, pin
# via CUDA_VISIBLE_DEVICES, and record utilization receipts. Deliberately NOT
# Kubernetes: batch jobs on one shared box are served by a ~100-line allocator
# with a file-lock quota; a scheduler would add operational surface without a
# demonstrated requirement (masterplan principle: no infra without need).
#
# The pool is SHARED with other tenants (nvidia-smi shows foreign jobs), so
# every pick is measured, never assumed: least memory-used with enough free
# memory and <90% utilization wins; none qualifies -> caller falls back to CPU.

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

REPORTS = Path(__file__).resolve().parent / "reports"

_SMI_QUERY = "index,memory.used,memory.total,utilization.gpu"


def _smi() -> str:
    return subprocess.run(
        ["nvidia-smi", f"--query-gpu={_SMI_QUERY}", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    ).stdout


def list_gpus(smi_output: str | None = None) -> list[dict]:
    """Parse nvidia-smi into [{index, mem_used_mb, mem_total_mb, util_pct}]."""
    out = smi_output if smi_output is not None else _smi()
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 4:
            continue
        gpus.append(
            {
                "index": int(parts[0]),
                "mem_used_mb": int(parts[1]),
                "mem_total_mb": int(parts[2]),
                "util_pct": int(parts[3]),
            }
        )
    return gpus


def pick_gpu(min_free_mb: int = 4096, max_util_pct: int = 90, smi_output: str | None = None) -> int | None:
    """Least-loaded GPU with enough free memory; None when the pool is busy."""
    gpus = list_gpus(smi_output)
    candidates = [g for g in gpus if g["mem_total_mb"] - g["mem_used_mb"] >= min_free_mb and g["util_pct"] < max_util_pct]
    if not candidates:
        return None
    return min(candidates, key=lambda g: (g["mem_used_mb"], g["util_pct"]))["index"]


def pin(index: int | None) -> str | None:
    """Pin the process to one GPU before torch/CUDA initializes."""
    if index is None:
        return os.environ.get("CUDA_VISIBLE_DEVICES")
    os.environ["CUDA_VISIBLE_DEVICES"] = str(index)
    return os.environ["CUDA_VISIBLE_DEVICES"]


def acquire(lock_dir: Path | None = None, min_free_mb: int = 4096, max_util_pct: int = 90) -> int | None:
    """Pick + pin + file-lock a GPU (quota for concurrent VoltHub jobs on the box)."""
    lock_dir = lock_dir or (REPORTS / "gpu-locks")
    lock_dir.mkdir(parents=True, exist_ok=True)
    index = pick_gpu(min_free_mb=min_free_mb, max_util_pct=max_util_pct)
    if index is None:
        return None
    lock = lock_dir / f"gpu{index}.lock"
    try:
        if lock.exists():
            return None  # another VoltHub job holds it; do not stack
        lock.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        return None
    pin(index)
    return index


def release(index: int | None, lock_dir: Path | None = None) -> None:
    if index is None:
        return
    lock_dir = lock_dir or (REPORTS / "gpu-locks")
    try:
        (lock_dir / f"gpu{index}.lock").unlink(missing_ok=True)
    except OSError:
        pass


class UtilLogger:
    """Samples nvidia-smi into reports/gpu-util.jsonl while a job runs (receipts)."""

    def __init__(self, job: str, interval_s: float = 2.0):
        self.job = job
        self.interval_s = interval_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self):
        REPORTS.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def _loop(self):
        while not self._stop.is_set():
            try:
                rec = {
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "job": self.job,
                    "gpus": list_gpus(),
                }
                with (REPORTS / "gpu-util.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + "\n")
            except Exception:
                pass  # receipts must never break the job
            self._stop.wait(self.interval_s)

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        return False


if __name__ == "__main__":
    gpus = list_gpus()
    print(f"GPUs: {len(gpus)}")
    for g in gpus:
        print(
            f"  gpu{g['index']}: {g['mem_used_mb']}/{g['mem_total_mb']} MiB, util {g['util_pct']}%"
        )
    choice = pick_gpu()
    print(f"least-loaded pick: {'gpu' + str(choice) if choice is not None else 'NONE — fall back to CPU'}")
