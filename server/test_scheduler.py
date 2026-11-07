import queue
import threading
import unittest
from scheduler import JobQueue, resource_group
from model_loading import serialized_load


class SchedulerTests(unittest.TestCase):
    def test_model_initialization_is_serialized_and_reentrant(self):
        first_entered = threading.Event()
        release = threading.Event()
        second_entered = threading.Event()

        @serialized_load
        def nested():
            return True

        @serialized_load
        def load_first():
            self.assertTrue(nested())
            first_entered.set()
            release.wait(timeout=2)

        @serialized_load
        def load_second():
            second_entered.set()

        first = threading.Thread(target=load_first)
        second = threading.Thread(target=load_second)
        first.start()
        self.assertTrue(first_entered.wait(timeout=1))
        second.start()
        try:
            self.assertFalse(second_entered.wait(timeout=0.05))
        finally:
            release.set()
            first.join(timeout=2)
            second.join(timeout=2)
        self.assertTrue(second_entered.is_set())

    def test_groups_and_head_of_line(self):
        jobs = JobQueue()
        jobs.put("video1", resource_group("detect.video"))
        jobs.put("video2", resource_group("defend.video"))
        jobs.put("tts", resource_group("audio.clone"))
        self.assertEqual(jobs.get(), "video1")
        self.assertEqual(jobs.get(), "tts")
        with self.assertRaises(queue.Empty):
            jobs.get(timeout=0.01)
        jobs.task_done("video1")
        self.assertEqual(jobs.get(), "video2")

    def test_dedup_and_release_after_error(self):
        jobs = JobQueue()
        jobs.put("a", "tts")
        jobs.put("a", "tts")
        self.assertEqual(jobs.get(), "a")
        jobs.put("a", "tts")
        try:
            raise RuntimeError("simulated inference error")
        except RuntimeError:
            pass
        finally:
            jobs.task_done("a")
        with self.assertRaises(queue.Empty):
            jobs.get(timeout=0.01)
        jobs.put("b", "tts")
        self.assertEqual(jobs.get(), "b")

    def test_two_threads_execute_different_models_together(self):
        jobs = JobQueue()
        jobs.put("clone", "tts")
        jobs.put("detect", "vision")
        barrier = threading.Barrier(2)
        errors = []

        def run():
            job = jobs.get()
            try:
                barrier.wait(timeout=2)
            except Exception as exc:
                errors.append(exc)
            finally:
                jobs.task_done(job)

        workers = [threading.Thread(target=run) for _ in range(2)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
