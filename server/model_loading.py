"""Serialize model construction: Transformers/Accelerate patch global torch init.

Inference remains concurrent. RLock permits nested model loader calls.
"""
import functools
import threading

_lock = threading.RLock()


def serialized_load(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with _lock:
            return function(*args, **kwargs)
    return wrapped
