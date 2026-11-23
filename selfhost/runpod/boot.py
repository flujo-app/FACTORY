"""Runs inside a RunPod pod: starts vLLM with FACTORY's settings and stops the pod when it is idle.

The pod uses the official vLLM image as it is; nothing is built. Its entrypoint runs this file
from FACTORY_SELFHOST_BOOT_B64. FACTORY_SELFHOST_PLAN_B64 holds the exact vLLM command (built by
selfhost/modal/settings.py, the same as on Modal), its extra environment and the idle rules;
FACTORY_SELFHOST_DISCOVERY_B64 holds the model-catalogue middleware that vLLM imports by name.

Idle means: no request running or waiting and no request finished for `idleMinutes`. Only
vLLM's own request counters are read, so health checks, catalogue reads and metric reads never
keep the GPU running. A vLLM that does not come up within `startupMinutes`, or keeps ending,
also stops the pod. The pod stops itself with the pod-scoped key RunPod gives every pod
(RUNPOD_API_KEY); the account key never enters the pod. Standard library only.
"""
import base64
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

PLAN_ENV = 'FACTORY_SELFHOST_PLAN_B64'
DISCOVERY_ENV = 'FACTORY_SELFHOST_DISCOVERY_B64'
BOOT_ENV = 'FACTORY_SELFHOST_BOOT_B64'
FOLDER = '/tmp/factory-selfhost'
REST_STOP = 'https://api.runpod.io/v2/pods/{pod}/action'
GRAPHQL = 'https://api.runpod.io/graphql'
POD_ID = re.compile(r'[a-z0-9]{6,40}')
POLL_SECONDS = 30
# After a stop request RunPod ends the container; ask again if it is still here after this long.
STOP_RETRY_SECONDS = 300
# Requests in flight, and counters that grow with every model request (never with /health,
# /metrics or /v1/models).
BUSY = ('vllm:num_requests_running', 'vllm:num_requests_waiting')
COUNTERS = ('vllm:request_success_total', 'vllm:prompt_tokens_total', 'vllm:generation_tokens_total')


def log(message):
    print(f'[factory-selfhost] {message}', flush=True)


def load_plan(env):
    """The launch plan FACTORY wrote; refuses anything but a vLLM command line."""
    plan = json.loads(base64.b64decode(env[PLAN_ENV]).decode('utf-8'))
    argv = plan.get('argv')
    if not isinstance(argv, list) or argv[:2] != ['vllm', 'serve'] or not all(isinstance(arg, str) for arg in argv):
        raise ValueError('the plan must hold a vllm serve command')
    for name in ('idleMinutes', 'startupMinutes', 'port'):
        if not isinstance(plan.get(name), int) or plan[name] < 1:
            raise ValueError(f'the plan needs {name}')
    if not isinstance(plan.get('env', {}), dict):
        raise ValueError('the plan env must be an object')
    return plan


def metric_sums(text, names):
    """Sum each named metric over all its label sets in a Prometheus text page."""
    sums = dict.fromkeys(names, 0.0)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '{' in line:
            if '}' not in line:
                continue
            name, rest = line[:line.index('{')], line[line.rindex('}') + 1:]
        else:
            name, _, rest = line.partition(' ')
        if name in sums:
            try:
                sums[name] += float(rest.split()[0])
            except (IndexError, ValueError):
                pass
    return sums


class IdleClock:
    """Decides when vLLM has been idle long enough. Fed with metric pages and times only."""

    def __init__(self, idle_seconds, now):
        self.idle_seconds = idle_seconds
        self.last_active = now
        self.last_counts = None

    def observe(self, text, now):
        sums = metric_sums(text, BUSY + COUNTERS)
        counts = tuple(sums[name] for name in COUNTERS)
        if any(sums[name] > 0 for name in BUSY) or (self.last_counts is not None and counts != self.last_counts):
            self.last_active = now
        self.last_counts = counts
        return now - self.last_active >= self.idle_seconds


def http_post(url, payload, headers, timeout=30):
    """POST JSON; returns (status, parsed body or None). Never raises for an HTTP error status."""
    request = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), method='POST',
                                     headers={'content-type': 'application/json', 'accept': 'application/json', **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read(1_000_000)
    except urllib.error.HTTPError as error:
        status, raw = error.code, b''
    try:
        return status, json.loads(raw.decode('utf-8')) if raw else None
    except ValueError:
        return status, None


def stop_pod(env, post=http_post, run=subprocess.run):
    """Ask RunPod to stop this pod with its own pod-scoped key. Returns the way that worked, or None."""
    pod, key = env.get('RUNPOD_POD_ID', ''), env.get('RUNPOD_API_KEY', '')
    if not POD_ID.fullmatch(pod):
        log('cannot stop the pod: RUNPOD_POD_ID is missing')
        return None
    if key:
        auth = {'authorization': f'Bearer {key}'}
        try:
            status, _ = post(REST_STOP.format(pod=pod), {'action': 'stop'}, auth)
            if status == 200:
                return 'rest'
            log(f'the REST stop answered {status}')
        except Exception as error:  # noqa: BLE001 - try the next way
            log(f'the REST stop failed ({type(error).__name__})')
        try:
            status, body = post(GRAPHQL, {'query': 'mutation { podStop(input: {podId: "%s"}) { id desiredStatus } }' % pod}, auth)
            if status == 200 and isinstance(body, dict) and not body.get('errors') and (body.get('data') or {}).get('podStop'):
                return 'graphql'
            log(f'the GraphQL stop answered {status}')
        except Exception as error:  # noqa: BLE001
            log(f'the GraphQL stop failed ({type(error).__name__})')
    # runpodctl comes with every pod and knows its own key.
    for command in (['runpodctl', 'pod', 'stop', pod], ['runpodctl', 'stop', 'pod', pod]):
        try:
            if run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False).returncode == 0:
                return 'runpodctl'
        except Exception:  # noqa: BLE001 - not installed or not allowed
            pass
    log('no way to stop the pod worked; trying again later')
    return None


def read_local(port, path, timeout=10):
    """GET a local vLLM page; its text, or None while it does not answer 200."""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=timeout) as response:
            return response.read(4_000_000).decode('utf-8', 'replace') if response.status == 200 else None
    except Exception:  # noqa: BLE001 - not up yet
        return None


def vllm_environment(plan, env, folder=FOLDER):
    """The vLLM process environment: the pod's, minus FACTORY's launch variables, plus the profile's."""
    child = {name: value for name, value in env.items() if name not in (PLAN_ENV, DISCOVERY_ENV, BOOT_ENV)}
    child.update({str(name): str(value) for name, value in plan.get('env', {}).items()})
    child['PYTHONPATH'] = folder + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    child['FACTORY_SELFHOST_INPUT_MODALITIES'] = ','.join(plan.get('inputModalities') or ['text'])
    return child


class Supervisor:
    """One look every POLL_SECONDS: restart a vLLM that ended, and stop the pod when it should stop."""

    def __init__(self, plan, start, read, stop, max_restarts=3):
        self.plan, self.start, self.read, self.stop = plan, start, read, stop
        self.max_restarts = max_restarts
        self.process = None
        self.started_at = None
        self.ready = False
        self.clock = None
        self.restarts = []
        self.stop_reason = None
        self.stop_asked_at = None

    def begin(self, now):
        self.process = self.start()
        self.started_at = now

    def request_stop(self, reason, now):
        if self.stop_reason is None:
            log(f'stopping the pod: {reason}')
            self.stop_reason = reason
        if self.stop_asked_at is None or now - self.stop_asked_at >= STOP_RETRY_SECONDS:
            if self.stop():
                self.stop_asked_at = now

    def tick(self, now):
        if self.stop_reason is not None:
            self.request_stop(self.stop_reason, now)
            return
        if self.process.poll() is not None:
            self.restarts = [at for at in self.restarts if now - at < 3600]
            if len(self.restarts) >= self.max_restarts:
                self.request_stop(f'vLLM ended {len(self.restarts) + 1} times within an hour', now)
                return
            self.restarts.append(now)
            log(f'vLLM ended with code {self.process.returncode}; starting it again')
            self.ready, self.clock = False, None
            self.begin(now)
            return
        port = self.plan['port']
        if not self.ready:
            if self.read(port, '/health') is not None:
                self.ready = True
                self.clock = IdleClock(self.plan['idleMinutes'] * 60, now)
                log(f'vLLM is serving; the pod stops after {self.plan["idleMinutes"]} idle minutes')
            elif now - self.started_at >= self.plan['startupMinutes'] * 60:
                self.request_stop(f'vLLM did not start within {self.plan["startupMinutes"]} minutes', now)
            return
        text = self.read(port, '/metrics')
        if text is not None and self.clock.observe(text, now):
            self.request_stop(f'no model request for {self.plan["idleMinutes"]} minutes', now)


def stop_for_good(stop):
    """A pod that cannot serve stops itself rather than restarting its container on a paid GPU."""
    while not stop():
        time.sleep(POLL_SECONDS)
    while True:
        time.sleep(STOP_RETRY_SECONDS)
        stop()


def main(env=None):
    env = dict(os.environ if env is None else env)
    stop = lambda: stop_pod(env)  # noqa: E731
    try:
        plan = load_plan(env)
        os.makedirs(FOLDER, exist_ok=True)
        with open(os.path.join(FOLDER, 'discovery.py'), 'wb') as handle:
            handle.write(base64.b64decode(env[DISCOVERY_ENV]))
    except Exception as error:  # noqa: BLE001
        log(f'the launch plan is unusable ({type(error).__name__}); nothing is served')
        stop_for_good(stop)
    if len(env.get('VLLM_API_KEY', '')) < 32:
        log('the endpoint key is missing; nothing is served')
        stop_for_good(stop)
    child_env = vllm_environment(plan, env)
    supervisor = Supervisor(plan, start=lambda: subprocess.Popen(plan['argv'], env=child_env), read=read_local, stop=stop)

    def end(signum, _frame):
        # RunPod is stopping the container: let vLLM finish cleanly.
        if supervisor.process and supervisor.process.poll() is None:
            supervisor.process.terminate()
            try:
                supervisor.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                supervisor.process.kill()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, end)
    log(f'starting vLLM for {plan["argv"][2]}')
    supervisor.begin(time.monotonic())
    while True:
        time.sleep(POLL_SECONDS)
        try:
            supervisor.tick(time.monotonic())
        except Exception as error:  # noqa: BLE001 - the watcher itself must never end
            log(f'a check failed ({type(error).__name__}); trying again')


if __name__ == '__main__':
    main()
