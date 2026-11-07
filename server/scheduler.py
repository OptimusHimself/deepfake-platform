"""Bounded, resource-aware queue. Each model group has one active job."""
import queue
import threading
import time
from collections import deque


def resource_group(task):
    if task == "audio.clone":
        return "tts"
    if task == "detect.audio":
        return "audio-detection"
    # Video defense also calls video detection; image/video swaps share models.
    return "vision"


class JobQueue:
    def __init__(self):
        self.pending = deque()
        self.active = {}
        self.condition = threading.Condition()

    def put(self, job_id, group):
        with self.condition:
            if job_id in self.active or any(item[0] == job_id for item in self.pending):
                return
            self.pending.append((job_id, group))
            self.condition.notify_all()

    def get(self, timeout=1):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                busy = set(self.active.values())
                for item in self.pending:
                    if item[1] not in busy:
                        self.pending.remove(item)
                        self.active[item[0]] = item[1]
                        return item[0]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                self.condition.wait(remaining)

    def task_done(self, job_id):
        with self.condition:
            del self.active[job_id]
            self.condition.notify_all()
