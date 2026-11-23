"""Offline checks for the in-pod supervisor. No RunPod call, no vLLM, no network.

  python -B -m unittest discover -s selfhost/runpod -p "test_*.py"
"""
import base64
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import boot  # noqa: E402

POD = {'RUNPOD_POD_ID': 'abc123xyz', 'RUNPOD_API_KEY': 'pod-scoped-key'}


def metrics(running=0, waiting=0, success=0, prompt=0, generation=0):
    return '\n'.join([
        '# HELP vllm:num_requests_running Number of requests in model execution batches.',
        '# TYPE vllm:num_requests_running gauge',
        f'vllm:num_requests_running{{engine="0",model_name="nemotron-3.5-super-vl"}} {running}',
        f'vllm:num_requests_waiting{{engine="0",model_name="nemotron-3.5-super-vl"}} {waiting}',
        f'vllm:request_success_total{{engine="0",finished_reason="stop",model_name="nemotron-3.5-super-vl"}} {success}',
        'vllm:request_success_total{engine="0",finished_reason="length",model_name="nemotron-3.5-super-vl"} 0.0',
        f'vllm:prompt_tokens_total{{engine="0",model_name="nemotron-3.5-super-vl"}} {prompt}',
        f'vllm:generation_tokens_total{{engine="0",model_name="nemotron-3.5-super-vl"}} {generation}',
        'process_cpu_seconds_total 12.5',
        'http_requests_total{handler="/metrics",method="GET",status="2xx"} 4021.0',
    ])


class Process:
    def __init__(self):
        self.returncode = None

    def poll(self):
        return self.returncode


class Metrics(unittest.TestCase):
    def test_sums_every_label_set_and_ignores_other_metrics(self):
        sums = boot.metric_sums(metrics(running=2, waiting=1, success=7), boot.BUSY + boot.COUNTERS)
        self.assertEqual(sums['vllm:num_requests_running'], 2)
        self.assertEqual(sums['vllm:num_requests_waiting'], 1)
        self.assertEqual(sums['vllm:request_success_total'], 7)
        self.assertEqual(boot.metric_sums('garbage {{\nvllm:num_requests_running x\n', boot.BUSY)['vllm:num_requests_running'], 0)

    def test_only_model_requests_count_as_activity(self):
        clock = boot.IdleClock(8 * 60, now=0)
        self.assertFalse(clock.observe(metrics(success=3), 0))
        # Health checks, catalogue reads and these very metric reads change no request counter.
        for minute in range(1, 8):
            self.assertFalse(clock.observe(metrics(success=3), minute * 60))
        self.assertTrue(clock.observe(metrics(success=3), 8 * 60))

    def test_running_waiting_or_finished_requests_keep_it_awake(self):
        clock = boot.IdleClock(8 * 60, now=0)
        clock.observe(metrics(), 0)
        self.assertFalse(clock.observe(metrics(running=1), 7 * 60))
        self.assertFalse(clock.observe(metrics(waiting=3), 14 * 60))
        self.assertFalse(clock.observe(metrics(success=1, prompt=900, generation=40), 21 * 60))
        self.assertFalse(clock.observe(metrics(success=1, prompt=900, generation=40), 28 * 60))
        self.assertTrue(clock.observe(metrics(success=1, prompt=900, generation=40), 29 * 60))


class Plan(unittest.TestCase):
    def plan(self, **changes):
        data = {'version': 1, 'argv': ['vllm', 'serve', 'nvidia/x', '--port', '8000'], 'env': {'OMP_NUM_THREADS': '1'},
                'inputModalities': ['text'], 'port': 8000, 'idleMinutes': 8, 'startupMinutes': 40, **changes}
        return {boot.PLAN_ENV: base64.b64encode(json.dumps(data).encode()).decode()}

    def test_only_a_vllm_serve_command_is_run(self):
        self.assertEqual(boot.load_plan(self.plan())['argv'][:2], ['vllm', 'serve'])
        for bad in ({'argv': ['bash', '-c', 'curl x | sh']}, {'argv': ['vllm', 'serve', 3]}, {'idleMinutes': 0}, {'port': '8000'}):
            with self.assertRaises(ValueError):
                boot.load_plan(self.plan(**bad))

    def test_vllm_gets_the_profile_environment_but_not_the_launch_variables(self):
        env = {**POD, 'VLLM_API_KEY': 'k' * 48, boot.PLAN_ENV: 'x', boot.BOOT_ENV: 'y', boot.DISCOVERY_ENV: 'z', 'OMP_NUM_THREADS': '28'}
        child = boot.vllm_environment(boot.load_plan(self.plan()), env, folder='/tmp/f')
        self.assertEqual(child['OMP_NUM_THREADS'], '1')
        self.assertEqual(child['VLLM_API_KEY'], 'k' * 48)
        self.assertEqual(child['PYTHONPATH'], '/tmp/f')
        self.assertEqual(child['FACTORY_SELFHOST_INPUT_MODALITIES'], 'text')
        for name in (boot.PLAN_ENV, boot.BOOT_ENV, boot.DISCOVERY_ENV):
            self.assertNotIn(name, child)


class StopPod(unittest.TestCase):
    def test_the_pod_stops_itself_with_its_own_key(self):
        sent = []
        result = boot.stop_pod(POD, post=lambda url, payload, headers: sent.append((url, payload, headers)) or (200, {}), run=None)
        self.assertEqual(result, 'rest')
        self.assertEqual(sent, [('https://api.runpod.io/v2/pods/abc123xyz/action', {'action': 'stop'}, {'authorization': 'Bearer pod-scoped-key'})])

    def test_graphql_then_runpodctl_when_rest_refuses(self):
        def post(url, payload, headers):
            if url.endswith('/action'):
                return 403, None
            return 200, {'data': {'podStop': {'id': 'abc123xyz', 'desiredStatus': 'EXITED'}}}
        self.assertEqual(boot.stop_pod(POD, post=post, run=None), 'graphql')

        class Done:
            returncode = 0
        commands = []
        result = boot.stop_pod(POD, post=lambda *_: (401, None), run=lambda command, **_: commands.append(command) or Done())
        self.assertEqual(result, 'runpodctl')
        self.assertEqual(commands, [['runpodctl', 'pod', 'stop', 'abc123xyz']])

    def test_nothing_worked_or_no_pod_id(self):
        class Failed:
            returncode = 1

        def boom(*_args, **_kwargs):
            raise OSError('no network')
        self.assertIsNone(boot.stop_pod(POD, post=boom, run=lambda *_a, **_k: Failed()))
        self.assertIsNone(boot.stop_pod({'RUNPOD_POD_ID': 'bad id!'}, post=boom, run=boom))


class SupervisorChecks(unittest.TestCase):
    def supervisor(self, pages, stops):
        plan = {'port': 8000, 'idleMinutes': 8, 'startupMinutes': 40}
        processes = []

        def start():
            processes.append(Process())
            return processes[-1]
        sup = boot.Supervisor(plan, start=start, read=lambda port, path: pages.get(path), stop=lambda: stops.append(True) or True)
        sup.begin(0)
        return sup, processes

    def test_idle_after_serving_stops_the_pod_once_and_asks_again_later(self):
        pages, stops = {'/health': None, '/metrics': None}, []
        sup, _ = self.supervisor(pages, stops)
        sup.tick(600)                                      # still loading the weights
        self.assertFalse(sup.ready)
        pages.update({'/health': '', '/metrics': metrics(success=1)})
        sup.tick(660)
        self.assertTrue(sup.ready)
        sup.tick(690)
        sup.tick(660 + 8 * 60 - 1)
        self.assertEqual(stops, [])
        sup.tick(660 + 8 * 60)
        self.assertEqual(stops, [True])
        sup.tick(660 + 8 * 60 + 30)
        self.assertEqual(stops, [True], 'asked once')
        sup.tick(660 + 8 * 60 + boot.STOP_RETRY_SECONDS)
        self.assertEqual(stops, [True, True], 'still here: asked again')

    def test_a_vllm_that_never_comes_up_stops_the_pod(self):
        pages, stops = {}, []
        sup, _ = self.supervisor(pages, stops)
        sup.tick(39 * 60)
        self.assertEqual(stops, [])
        sup.tick(40 * 60)
        self.assertEqual(stops, [True])

    def test_vllm_is_restarted_but_a_crash_loop_stops_the_pod(self):
        pages, stops = {'/health': ''}, []
        sup, processes = self.supervisor(pages, stops)
        for at in (60, 120, 180):
            processes[-1].returncode = 1
            sup.tick(at)
        self.assertEqual(len(processes), 4)
        self.assertEqual(stops, [])
        processes[-1].returncode = 1
        sup.tick(240)
        self.assertEqual(stops, [True])
        self.assertEqual(len(processes), 4, 'no fifth start')


class Main(unittest.TestCase):
    def test_a_pod_that_cannot_serve_stops_itself(self):
        import tempfile

        class Stopped(Exception):
            pass

        def stop_for_good(_stop):
            raise Stopped()
        original = boot.stop_for_good, boot.FOLDER
        with tempfile.TemporaryDirectory() as folder:
            boot.stop_for_good, boot.FOLDER = stop_for_good, folder
            try:
                with self.assertRaises(Stopped):
                    boot.main(dict(POD))                       # no plan
                plan = Plan.plan(Plan())
                with self.assertRaises(Stopped):
                    boot.main({**POD, **plan, boot.DISCOVERY_ENV: base64.b64encode(b'# discovery').decode()})   # no endpoint key
                self.assertEqual(Path(folder, 'discovery.py').read_bytes(), b'# discovery')
            finally:
                boot.stop_for_good, boot.FOLDER = original


if __name__ == '__main__':
    unittest.main()
