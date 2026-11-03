"""Deploy, prefetch, check or describe one owned self-hosted model app on Modal.

Reads one JSON request on stdin and prints exactly one JSON line; Modal's own output is
captured and discarded, so neither the key nor a transcript reaches the caller:

  {"action": "describe", "appName": "...", "profile": "qwen", "overrides": {...}}
  {"action": "prefetch", "appName": "...", "profile": "...", "overrides": {...}}   CPU only: weights into the volume
  {"action": "check-flags", "appName": "...", "profile": "...", "flags": ["--a", ...]}   CPU only
  {"action": "deploy", "appName": "...", "profile": "...", "overrides": {...}, "key": "...", "reuseSecret": false}

`deploy` creates the `<app>-auth` secret (never replacing an existing one unless
`reuseSecret` is set for a redeploy), runs `modal deploy app.py` and returns the replica URLs.
The active Modal profile selects the workspace.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from settings import SETTINGS_ENV, client_hints, resolve  # noqa: E402

MAX_INPUT = 65536


class Refused(Exception):
    """A safe, caller-facing reason."""


def read_request():
    raw = sys.stdin.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise Refused('The request is too large.')
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get('action') not in ('describe', 'prefetch', 'check-flags', 'deploy'):
        raise Refused('Unknown action.')
    return request


def settings_for(request):
    try:
        return resolve(request.get('appName', ''), request.get('profile', ''), request.get('overrides') or {})
    except (ValueError, TypeError) as error:
        raise Refused(str(error)) from None


def quiet_import_app(settings, helpers):
    os.environ[SETTINGS_ENV] = settings.to_b64()
    if helpers:
        os.environ['FACTORY_SELFHOST_HELPERS'] = '1'
    else:
        os.environ.pop('FACTORY_SELFHOST_HELPERS', None)
    import app  # noqa: PLC0415 - reads the settings above at import
    return app


def run_helper(settings, call):
    app = quiet_import_app(settings, helpers=True)
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink), app.app.run():
        return call(app)


def deploy(settings, request):
    import modal
    key = request.get('key')
    if not isinstance(key, str) or not 32 <= len(key) <= 256:
        raise Refused('The endpoint key is invalid.')
    if not settings.estimate_gib()['fits']:
        raise Refused('The model does not fit the selected GPU.')
    secret = settings.app_name + '-auth'
    if request.get('reuseSecret') is True:
        modal.Secret.from_name(secret, required_keys=['VLLM_API_KEY']).hydrate()
    else:
        modal.Secret.objects.create(secret, {'VLLM_API_KEY': key}, allow_existing=False)
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', SETTINGS_ENV: settings.to_b64()}
    env.pop('FACTORY_SELFHOST_HELPERS', None)
    with tempfile.TemporaryFile() as out:
        result = subprocess.run([sys.executable, '-B', '-m', 'modal', 'deploy', str(HERE / 'app.py')],
                                cwd=HERE, stdout=out, stderr=out, env=env, check=False)
    if result.returncode:
        raise Refused('The Modal deployment did not complete.')
    urls = [modal.Function.from_name(settings.app_name, name).get_web_url() for name in settings.endpoint_functions()]
    if len(urls) != settings.replicas or not all(isinstance(url, str) and url.startswith('https://') for url in urls):
        raise Refused('The deployed endpoints could not be identified.')
    return {'endpoints': urls, 'settings': settings.describe()}


def main():
    request = read_request()
    settings = settings_for(request)
    action = request['action']
    if action == 'describe':
        return {'settings': settings.describe(), 'hints': client_hints(settings.profile)}
    if action == 'prefetch':
        return run_helper(settings, lambda app: app.download.remote())
    if action == 'check-flags':
        flags = request.get('flags')
        if not isinstance(flags, list) or not flags or not all(isinstance(flag, str) and flag.startswith('--') for flag in flags):
            raise Refused('List the flags to check.')
        return run_helper(settings, lambda app: app.vllm_flags.remote(flags))
    return deploy(settings, request)


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Refused as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - never echo provider details that may hold names or keys
        print(json.dumps({'error': f'The Modal operation did not complete ({type(error).__name__}).'}))
        sys.exit(1)
