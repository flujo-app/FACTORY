"""Prepare an owned local image context. This does not build or launch anything.

The exact compiler image built from Dockerfile.compiler is the retained native
build input. Debian package resolution in that first build is not reproducible;
retain its image ID and dpkg inventory before reusing it. No model is included.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib

SOURCE_COMMIT = "2d08f31aa58c2c7b49304d0367ab51ae9aaccb11"
FACTORY_COMMIT = "0a72966f8b175ad44cff476ed2c59b73ba18c066"
PYTHON_IMAGE = "python:3.12.13-slim-bookworm@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af"
UV_IMAGE = "ghcr.io/astral-sh/uv:0.11.21@sha256:6f1fa8fc4040ad7197d7e652057219871e5f6640abfe2b790f1419fdb2319e6b"
WHEEL_URL = "https://files.pythonhosted.org/packages/0b/2c/87f3254fd8ffd29e4c02732eee68a83a1d3c346ae39bc6822dcbcb697f2b/wheel-0.45.1-py3-none-any.whl"
WHEEL_HASH = "708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248"


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, factory, destination, *, factory_commit=FACTORY_COMMIT):
    source, factory, destination = map(Path, (source, factory, destination))
    if git(source, "rev-parse", "HEAD").decode().strip() != SOURCE_COMMIT:
        raise ValueError("Current coherent owner source commit is required")
    if git(source, "status", "--porcelain"):
        raise ValueError("Owner source must be clean; only committed files are exported")
    if re.fullmatch(r"[0-9a-f]{40}", factory_commit) is None:
        raise ValueError("An exact reviewed Factory commit is required")
    if git(factory, "rev-parse", "HEAD").decode().strip() != factory_commit:
        raise ValueError("Reviewed Factory source commit is required")
    destination.mkdir(parents=True, exist_ok=False)
    context = destination / "context"
    context.mkdir()
    source_context = context / "communityai-source"
    source_context.mkdir()
    archive = destination / "communityai-source.tar"
    subprocess.run(["git", "-c", "core.autocrlf=false", "-C", str(source), "archive", "--format=tar", "-o", str(archive.resolve()),
                    SOURCE_COMMIT, "pyproject.toml", "uv.lock", "README.md", "src", "Dockerfile.factory-runtime"],
                   check=True)
    with tarfile.open(archive) as bundle:
        bundle.extractall(source_context, filter="data")
    if (source_context / "uv.lock").read_bytes() != git(source, "show", f"{SOURCE_COMMIT}:uv.lock"):
        raise ValueError("Exported lock differs from the exact committed blob")
    factory_context = context / "factory"
    factory_context.mkdir()
    for name in ("communityai_bootstrap.py", "communityai_runtime.py", "communityai_runtime_watchdog.py",
                 "communityai-model-manifest.json"):
        # Git blobs preserve exact reviewed bytes, including the manifest's
        # raw-file pin, independently of dirty files or checkout line endings.
        (factory_context / name).write_bytes(git(factory, "show", f"{factory_commit}:modal/{name}"))
    lock = tomllib.loads((source_context / "uv.lock").read_text(encoding="utf-8"))
    setuptools = next(item for item in lock["package"] if item["name"] == "setuptools")
    artifact = next(item for item in setuptools["wheels"] if "py3-none-any" in item["url"])
    requirements = (f"setuptools @ {artifact['url']} --hash={artifact['hash']}\n"
                    f"wheel @ {WHEEL_URL} --hash=sha256:{WHEEL_HASH}\n")
    (context / "build-tools.txt").write_text(requirements, encoding="utf-8", newline="\n")
    compiler = f'''FROM {UV_IMAGE} AS uv
FROM {PYTHON_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
COPY build-tools.txt /opt/build-tools.txt
ENV DEBIAN_FRONTEND=noninteractive UV_NO_CACHE=1 UV_LINK_MODE=copy
RUN apt-get update \\
    && apt-get install --no-install-recommends --yes build-essential ca-certificates libgomp1 \\
    && uv pip install --system --no-deps --require-hashes -r /opt/build-tools.txt \\
    && python -c 'import platform, setuptools, wheel; assert platform.python_version() == "3.12.13"; assert setuptools.__version__ == "{setuptools['version']}"; assert wheel.__version__ == "0.45.1"' \\
    && mkdir -p /opt/factory-build-inputs \\
    && dpkg-query -W > /opt/factory-build-inputs/dpkg.txt \\
    && gcc --version > /opt/factory-build-inputs/gcc.txt \\
    && uv --version > /opt/factory-build-inputs/uv.txt \\
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.description="Owned local CommunityAI compiler input; retain image ID and package inventory"
'''
    (context / "Dockerfile.compiler").write_text(compiler, encoding="utf-8", newline="\n")
    # The build owner supplies the exact locally retained compiler image tag,
    # checks its image ID before and after build, and retains both build receipts.
    recipe_path = "modal/Dockerfile.communityai-runtime"
    runtime = git(factory, "show", f"{factory_commit}:{recipe_path}")
    (context / "Dockerfile.runtime").write_bytes(runtime)
    (context / ".dockerignore").write_text("**/__pycache__/\n**/*.pyc\n", encoding="utf-8", newline="\n")
    files = {str(path.relative_to(context)).replace("\\", "/"): sha(path)
             for path in sorted(context.rglob("*")) if path.is_file()}
    source_label = re.search(r'^SOURCE_COMMIT = "([0-9a-f]{40})"',
                             (factory_context / "communityai_runtime.py").read_text(), re.MULTILINE)[1]
    record = {"source_commit": SOURCE_COMMIT, "factory_commit": factory_commit,
              "factory_recipe_git_path": recipe_path,
              "factory_recipe_git_blob_sha256": hashlib.sha256(runtime).hexdigest(),
              "source_archive_sha256": sha(archive), "source_lock_sha256": sha(source_context / "uv.lock"),
              "owner_working_lock_sha256": sha(source / "uv.lock"),
              "python_image": PYTHON_IMAGE, "uv_image": UV_IMAGE,
              "setuptools_version": setuptools["version"], "setuptools_artifact": artifact,
              "wheel_version": "0.45.1", "wheel_url": WHEEL_URL, "wheel_sha256": WHEEL_HASH,
              "context_files": files, "compiler_package_resolution": "not_pinned_until_local_image_retained",
              "image_built": False, "deployment_verified": False,
              "factory_runtime_source_label": source_label,
              "source_label_matches_export": source_label == SOURCE_COMMIT}
    (destination / "inputs.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--factory", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--factory-commit", default=FACTORY_COMMIT)
    args = parser.parse_args()
    record = prepare(args.source, args.factory, args.destination, factory_commit=args.factory_commit)
    print(json.dumps({"destination": str(Path(args.destination).resolve()),
                      "source_commit": record["source_commit"],
                      "source_lock_sha256": record["source_lock_sha256"],
                      "context_file_count": len(record["context_files"])}))
