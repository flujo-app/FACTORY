"""Offline checks for the self-hosted model settings. No Modal import, no cloud call.

  python -B -m unittest discover -s selfhost/modal -p "test_*.py"
"""
import base64
import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import discovery  # noqa: E402
from settings import (MAX_REPLICAS, SETTINGS_ENV, client_hints, from_env, profile_names,  # noqa: E402
                      resolve)

QWEN = 'factory-qwen-0123456789ab'
NEMOTRON = 'factory-nemotron-0123456789ab'


class Profiles(unittest.TestCase):
    def test_both_profiles_exist_and_fit_their_gpu(self):
        self.assertEqual(profile_names(), ['nemotron', 'qwen'])
        for name, app in (('qwen', QWEN), ('nemotron', NEMOTRON)):
            estimate = resolve(app, name).estimate_gib()
            self.assertTrue(estimate['fits'], (name, estimate))

    def test_qwen_command_uses_its_parsers_without_remote_code(self):
        s = resolve(QWEN, 'qwen')
        command = s.vllm_command()
        self.assertEqual(command[:3], ['vllm', 'serve', 'Qwen/Qwen3.8-27B-FP8'])
        for pair in (('--tool-call-parser', 'qwen3_xml'), ('--reasoning-parser', 'qwen3'), ('--max-model-len', '262144'),
                     ('--served-model-name', 'qwen3.8-27b')):
            self.assertEqual(command[command.index(pair[0]) + 1], pair[1])
        self.assertIn('--enable-prefix-caching', command)
        self.assertNotIn('--trust-remote-code', command)
        self.assertEqual(json.loads(command[command.index('--default-chat-template-kwargs') + 1]), {'enable_thinking': True})
        self.assertEqual(s.gpu, 'H100')
        self.assertEqual(s.usd_per_hour(), 4.84)
        self.assertEqual(client_hints('qwen'), {'compact_tokens': 80000, 'efforts': ['low', 'medium', 'xhigh']})

    def test_nemotron_command_uses_the_release_image_mtp_and_hybrid_prefix_caching(self):
        s = resolve(NEMOTRON, 'nemotron')
        command = s.vllm_command()
        self.assertEqual(s.gpu, 'B300')
        self.assertRegex(s.image, r'^vllm/vllm-openai@sha256:[a-f0-9]{64}$')
        self.assertEqual(s.variant, 'mtp1')
        for pair in (('--tool-call-parser', 'qwen3_coder'), ('--reasoning-parser', 'nemotron_v3'),
                     ('--mamba-cache-mode', 'align'), ('--mamba-backend', 'flashinfer'), ('--mamba-ssm-cache-dtype', 'float32')):
            self.assertEqual(command[command.index(pair[0]) + 1], pair[1])
        for flag in ('--trust-remote-code', '--language-model-only', '--async-scheduling', '--enable-mamba-shared-prefix-checkpoint'):
            self.assertIn(flag, command)
        # remote code and tokenizer from the same pinned revision as the weights
        for flag in ('--revision', '--code-revision', '--tokenizer-revision'):
            self.assertEqual(command[command.index(flag) + 1], s.revision, flag)
        self.assertNotIn('--code-revision', resolve(QWEN, 'qwen').vllm_command(), 'no remote code, nothing to pin')
        self.assertEqual(json.loads(command[command.index('--speculative-config') + 1]), {'method': 'mtp', 'num_speculative_tokens': 1})
        self.assertEqual(s.env, {'OMP_NUM_THREADS': '1'})
        self.assertEqual(s.input_modalities, ('text',))
        self.assertEqual(s.usd_per_hour(), 8.43)

    def test_variants_change_only_the_speed_flags(self):
        fast = resolve(NEMOTRON, 'nemotron', {'variant': 'fast'}).vllm_command()
        self.assertNotIn('--speculative-config', fast)
        self.assertIn('--async-scheduling', fast)
        fp16 = resolve(NEMOTRON, 'nemotron', {'variant': 'mtp1-fp16'}).vllm_command()
        self.assertEqual(fp16[fp16.index('--mamba-ssm-cache-dtype') + 1], 'float16')
        self.assertIn('--enable-mamba-cache-stochastic-rounding', fp16)

    def test_overrides_are_explicit_and_validated(self):
        s = resolve(QWEN, 'qwen', {'enable_thinking': False, 'replicas': 2, 'scaledown_minutes': 1})
        self.assertEqual(s.endpoint_functions(), ['serve', 'serve_b'])
        self.assertEqual(json.loads(s.vllm_command()[s.vllm_command().index('--default-chat-template-kwargs') + 1]), {'enable_thinking': False})
        bad = [{'gpu': 'TPU'}, {'replicas': MAX_REPLICAS + 1}, {'scaledown_minutes': 30}, {'variant': 'turbo'},
               {'unknown': 1}, {'app_name': NEMOTRON}, {'image': 'vllm/vllm-openai:latest'}, {'input_modalities': ['image']}]
        for override in bad:
            with self.assertRaises(ValueError, msg=override):
                resolve(QWEN, 'qwen', override)
        with self.assertRaises(ValueError):
            resolve(NEMOTRON, 'qwen')
        with self.assertRaises(ValueError):
            resolve('Bad-Name', 'qwen')
        with self.assertRaises(ValueError):
            resolve(QWEN, 'missing')

    def test_request_limit_is_one_the_starter_plan_schedules(self):
        # Modal's starter plan never gives a GPU to a function with a request limit of 45 minutes or more.
        for name, app in (('qwen', QWEN), ('nemotron', NEMOTRON)):
            s = resolve(app, name)
            self.assertLess(s.request_timeout_minutes, 45, name)
            self.assertEqual(s.describe()['requestTimeoutMinutes'], s.request_timeout_minutes)
        self.assertEqual(resolve(QWEN, 'qwen', {'request_timeout_minutes': 60}).request_timeout_minutes, 60)
        for bad in (0, 1441):
            with self.assertRaises(ValueError):
                resolve(QWEN, 'qwen', {'request_timeout_minutes': bad})

    def test_an_earlier_volume_can_hold_the_weights_and_is_never_owned(self):
        own = resolve(NEMOTRON, 'nemotron').volumes()
        self.assertEqual(own, {'weights': {'name': NEMOTRON + '-hf-cache', 'owned': True},
                               'compile': {'name': NEMOTRON + '-vllm-cache', 'owned': True}})
        reused = resolve(NEMOTRON, 'nemotron', {'weights_volume': 'earlier-hf-cache', 'compile_volume': 'earlier-vllm-cache'})
        self.assertEqual(reused.describe()['volumes'], {'weights': {'name': 'earlier-hf-cache', 'owned': False},
                                                        'compile': {'name': 'earlier-vllm-cache', 'owned': False}})
        for bad in (' x', 'a/b', 'x' * 64, NEMOTRON + '-hf-cache'):
            with self.assertRaises(ValueError, msg=bad):
                resolve(NEMOTRON, 'nemotron', {'weights_volume': bad})

    def test_frozen_settings_round_trip_through_the_image_environment(self):
        s = resolve(NEMOTRON, 'nemotron', {'replicas': 2})
        restored = from_env({SETTINGS_ENV: s.to_b64()})
        self.assertEqual(restored, s)
        self.assertNotIn('"', s.to_b64())
        self.assertIn('num_speculative_tokens', base64.b64decode(s.to_b64()).decode())
        with self.assertRaises(ValueError):
            from_env({})


class Discovery(unittest.TestCase):
    def test_catalogue_gets_context_length_and_honest_modalities(self):
        catalogue = discovery.enrich({'data': [{'id': 'm', 'max_model_len': 262144}]}, discovery.input_modalities({'FACTORY_SELFHOST_INPUT_MODALITIES': 'text'}))
        model = catalogue['data'][0]
        self.assertEqual(model['context_length'], 262144)
        self.assertEqual(model['architecture']['input_modalities'], ['text'])
        self.assertIn('tools', model['supported_parameters'])


class DeployScript(unittest.TestCase):
    def run_script(self, request):
        return subprocess.run([sys.executable, '-B', str(HERE / 'deploy.py')], input=json.dumps(request), capture_output=True,
                              text=True, check=False)

    def test_describe_needs_no_modal_and_prints_one_json_line(self):
        result = self.run_script({'action': 'describe', 'appName': NEMOTRON, 'profile': 'nemotron', 'overrides': {'variant': 'fast'}})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1)
        described = json.loads(lines[0])
        self.assertEqual(described['settings']['model'], 'nemotron-3.5-super-vl')
        self.assertEqual(described['settings']['variant'], 'fast')
        self.assertEqual(described['hints']['compact_tokens'], 80000)

    def test_refusals_are_one_safe_json_line(self):
        result = self.run_script({'action': 'describe', 'appName': QWEN, 'profile': 'qwen', 'overrides': {'gpu': 'TPU'}})
        self.assertEqual(result.returncode, 1)
        self.assertIn('unknown gpu', json.loads(result.stdout)['error'])
        result = self.run_script({'action': 'erase'})
        self.assertEqual(json.loads(result.stdout), {'error': 'Unknown action.'})


if __name__ == '__main__':
    unittest.main()
