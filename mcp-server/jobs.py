"""Background runner for the Node CLI.

Scans drive a real browser against Google's servers and routinely take many
minutes — a full path scan is minutes, and a single lab link check is ~30s
because Google provisions an environment before answering. That is longer than
an MCP client will happily block for, so every action starts as a job: the caller
waits a bounded number of seconds, and if the work is still going it gets a
handle to poll instead of a timeout.

Two rules are enforced here rather than left to the caller:

* Only one browser job at a time. Two Playwright runs against the same profile
  directory collide on Chromium's ``SingletonLock`` and the second one hangs with
  no useful error.
* ``auth`` is never started. It opens a window a human has to sign in to and
  blocks on an Enter prompt; see the refusal in ``server.py``.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


class JobError(RuntimeError):
    """Raised when a job cannot be started."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# Exit codes are part of the CLI's contract: 2 means "something is outstanding
# or unknown", which is meaningful output rather than a failure.
EXIT_MEANING = {
    0: "Succeeded, with nothing outstanding.",
    1: "Scraper or configuration error — see the output.",
    2: "Ran fine; something is still outstanding or unknown.",
}


@dataclass
class Job:
    id: str
    label: str
    steps: list[list[str]]
    log_path: Path
    uses_browser: bool
    timeout_s: int
    started_at: str = field(default_factory=_now)
    finished_at: str | None = None
    exit_code: int | None = None
    timed_out: bool = False
    cancelled: bool = False
    error: str | None = None
    process: subprocess.Popen | None = None
    done: threading.Event = field(default_factory=threading.Event)

    @property
    def state(self) -> str:
        if not self.done.is_set():
            return "running"
        if self.cancelled:
            return "cancelled"
        if self.timed_out:
            return "timed_out"
        if self.error:
            return "failed"
        if self.exit_code == 0:
            return "completed"
        if self.exit_code == 2:
            return "completed_with_outstanding"
        return "failed"


class JobRegistry:
    def __init__(self, cwd: Path, log_dir: Path, keep: int = 50) -> None:
        self.cwd = cwd
        self.log_dir = log_dir
        self.keep = keep
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self.log_dir.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------- starting

    def start(
        self,
        label: str,
        steps: list[list[str]],
        *,
        uses_browser: bool,
        timeout_s: int,
        env: dict[str, str] | None = None,
    ) -> Job:
        with self._lock:
            if uses_browser:
                busy = self._active_browser_job()
                if busy:
                    raise JobError(
                        f"A browser job is already running ({busy.id}: {busy.label}). "
                        "Playwright runs share one Chromium profile directory and "
                        "collide on its lock — wait for that job, or cancel it with "
                        "partner_cancel_job."
                    )
            job = Job(
                id=uuid.uuid4().hex[:8],
                label=label,
                steps=steps,
                log_path=self.log_dir / f"{_now().replace(':', '-')}-{label}.log",
                uses_browser=uses_browser,
                timeout_s=timeout_s,
            )
            self._jobs[job.id] = job
            self._prune()
        threading.Thread(target=self._run, args=(job, env), daemon=True).start()
        return job

    def _active_browser_job(self) -> Job | None:
        for job in self._jobs.values():
            if job.uses_browser and not job.done.is_set():
                return job
        return None

    def _prune(self) -> None:
        finished = [job for job in self._jobs.values() if job.done.is_set()]
        if len(finished) <= self.keep:
            return
        for job in sorted(finished, key=lambda item: item.started_at)[: len(finished) - self.keep]:
            self._jobs.pop(job.id, None)

    # -------------------------------------------------------------- running

    def _run(self, job: Job, env: dict[str, str] | None) -> None:
        environment = {**os.environ, **(env or {})}
        deadline = datetime.now(timezone.utc).timestamp() + job.timeout_s
        worst = 0
        try:
            for step in job.steps:
                if job.cancelled:
                    break
                remaining = deadline - datetime.now(timezone.utc).timestamp()
                if remaining <= 0:
                    job.timed_out = True
                    break
                with open(job.log_path, "ab") as log:
                    log.write(f"\n$ {' '.join(step)}\n".encode())
                    # start_new_session so a timeout can kill the whole tree:
                    # Playwright leaves a Chromium process group behind otherwise.
                    process = subprocess.Popen(
                        step,
                        cwd=self.cwd,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                        env=environment,
                    )
                job.process = process
                try:
                    code = process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    job.timed_out = True
                    _kill_tree(process)
                    worst = process.wait()
                    break
                # Exit 2 is a real result, not a failure, so a sequence keeps
                # going — but the whole job still reports 2, or a later step
                # succeeding would erase the "something is outstanding" answer.
                if code not in (0, 2):
                    worst = code
                    break
                if code == 2:
                    worst = 2
            job.exit_code = worst
        except Exception as error:  # noqa: BLE001 — surfaced to the caller as job.error
            job.error = f"{type(error).__name__}: {error}"
        finally:
            job.finished_at = _now()
            job.done.set()

    # ------------------------------------------------------------ inspecting

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if not job:
            raise JobError(f"No job {job_id!r}. Use partner_list_jobs to see recent jobs.")
        return job

    def all(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda job: job.started_at, reverse=True)

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.done.is_set():
            return job
        job.cancelled = True
        if job.process:
            _kill_tree(job.process)
        job.done.wait(timeout=15)
        return job

    def tail(self, job: Job, lines: int = 60) -> str:
        try:
            text = job.log_path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return ""
        return "\n".join(text.splitlines()[-lines:])

    def describe(self, job: Job, tail_lines: int = 40) -> dict:
        return {
            "job_id": job.id,
            "label": job.label,
            "state": job.state,
            "command": " && ".join(" ".join(step) for step in job.steps),
            "started_at": job.started_at,
            "finished_at": job.finished_at,
            "exit_code": job.exit_code,
            "exit_meaning": EXIT_MEANING.get(job.exit_code) if job.exit_code is not None else None,
            "timed_out": job.timed_out,
            "error": job.error,
            "log_file": str(job.log_path),
            "output_tail": self.tail(job, tail_lines),
        }

    def wait(self, job: Job, seconds: float) -> bool:
        return job.done.wait(timeout=max(0.0, seconds))


def _kill_tree(process: subprocess.Popen) -> None:
    try:
        group = os.getpgid(process.pid)
    except ProcessLookupError:
        return
    for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            continue
