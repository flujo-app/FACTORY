# Local pinned-model preparation

Status at **07:29 UTC, October 3, 2026**: the local download and its complete
public artifact check passed. A separate process then independently read and
validated the complete snapshot once. Both operations closed successfully.
There is no new Modal deployment, GPU boot, inference or native Flow receipt.
The shared paid ledger remains revision 19: 30 conservatively rounded partial
cents, all US$100 held, zero unallocated, final spend unknown.

The target is `Qwen/Qwen2.5-Coder-7B-Instruct` at
`c03e6d358207e414f1eca0bb1891e29f1db0e242`. Its existing public manifest requires
13 files, including four weight shards, totaling **15,242,805,878 bytes**.
The existing validator read every required file and checked its digest and
the index's 339 tensor references after the SDK download pool finished.
See [the model definition](modal/README.md) for the exact receipt and filesystem
limits. A filename, download return or progress count cannot establish readiness.

The initial local operation ran from **06:08:24.472 to 06:30:06.953 UTC**.
Its last progress observation reported 4,288,675,840 incomplete bytes and
1,690,479 canonical bytes across five files. At the observed transfer rate, the
initial 3600-second local envelope could not reliably fit the whole snapshot.
A separately reviewed stop helper recorded its intent, verified the actual
Python writer, retained its native process handle and stopped that writer.
The original launcher and Node collector then closed naturally. Partial files
were retained for the explicit resume, which subsequently completed and renamed
them to canonical files. Original logs, source, plan and marker remain preserved.

Windows used two Python process IDs: launcher 39964 and actual writer 51476.
The writer marker and original stdout identify 51476; the original Node child
receipt identifies 39964. The interrupted execution is preserved at
`.factory/model-local-20261003-r2/download-execution.private.json`, SHA-256
`fa93eafa4b23f2ad91629f7c661ae201da6fdfba7b7e6cb5b5b8e4e8dab074c9`.
Its source/history/owner preservation checks passed. Separate post-stop audit
at SHA-256 `eef56471777c319cd505638be87d46d87c431a751a749e7bfa047db9744dee76`
confirmed both Python processes and the original collector were absent, all
29 accounting/history files and all 60 owner paths remained stable, and the
paid ledger stayed unchanged.

The resume was admitted at **06:35:36.145 UTC** after independent source review,
explicit hash-bound resume authorization and read-only preflight. Its actual
execution ran from **06:35:36.541 to 07:27:01.693 UTC** and exited 0 with an
accepted receipt. The whole resume measured **3084.96 seconds**; this includes
transfer and validation, rather than measuring either phase alone. One HTTP
Range response was checked before appending at offset **4,330,618,880 bytes**.
The final proof covers all 13 files, four shards and **15,242,805,878 bytes**.
Observed process peak memory was **78,102,528 bytes**, with **122,391,560,192
bytes** free disk at the terminal observation.

The exact execution is
`.factory/model-local-20261003-resume-1/download-execution.private.json`, SHA-256
`ea0948c0b10d86a1effbfe8f99369be5ca8d600b553e2a155f7a1dd67589c5b2`.
Its source/history/owner preservation checks passed. The actual direct Python
writer 30308 and Node collector 54092 closed and were observed absent before
independent validation.

The resume reuses the private cache and owned Hub 0.36.0 installation, with
anonymous ordinary HTTP and one download worker. It validates successful Range
responses before appending and refuses oversized partial files. A native
exclusive cache lock disables soft-lock fallback. The direct base interpreter
uses `-I -S -B` and adds only the owned virtual environment's packages, giving
the controller the actual writer PID. Credential discovery and telemetry are
disabled. Original attempt records were checked again after completion.

The **9000-second deadline applies only to this local resume**. Production Modal
configuration and its 3600-second prefetch deadline are unchanged. The local
20 GiB disk reserve and 2 GiB observed process-peak bound are checked during work;
the memory observation is not a hard operating-system quota. Mounted Volume
behavior, cloud transfer duration, GPU loading and inference still require
their own live qualification.

Frozen resume worker SHA-256:
`5c7e8aa5811bfe22a988de29916459b5067de5ddbfca47c7275883a263c082d5`.
Collector SHA-256:
`edb280846bf45787ba579a4e576756a4d85f661ad9aad43f6adfde6168f23b50`.
Plan SHA-256:
`caef6f9c8cdddfa01cc2043cabdbe2a7034db23abdc8780b46fe44d6da0c316b`.
They and the private admission, review and authorization are preserved in
`.factory/model-local-20261003-resume-1`. Earlier unexecuted drafts are archived
separately. Syntax checks and an isolated installed-lock API probe passed before
dispatch; they are separate from the subsequent real public artifact checks.

## Independent full snapshot validation

A separately reviewed, immutable one-use admission started direct Python process
4872 after the resume had closed. It called the real public
`validate_model_artifacts` exactly once under the same native Windows cache lock,
with soft fallback disabled and the existing lock file preserved. The validator
was compiled from its verified source bytes, avoiding a cached bytecode module.
It streamed the complete required snapshot with a maximum read size of 1 MiB and
returned the same manifest, revision, file, shard, byte and tensor proof.

The actual scan measured **61.598455 seconds wall time**, **32.9375 seconds CPU**,
and **32,272,384 bytes peak process memory** (30.8 MiB). OS observations measured
**15,242,839,988 transferred read bytes** over **14,567 reads**. These include
small process/validator reads as well as the model files. There was no model
loading or inference. The successful execution report was finalized at
**07:28:57.662 UTC**, after the scan closed with exit 0 and its direct child
was observed absent.

Execution:
`.factory/independent-local-fullscan-622bfb6a-25bc-4d82-af31-6fe3631da1c7/execution.private.json`,
SHA-256 `ed86aacb5747cfec8bcfc76345c3a1c623c42f891b2a68bbba77d9c539bf797a`.
Its admission remained consumed. All 54 runtime pins, 29 accounting/history
files, 60 owner paths, 15 original records and nine source witnesses stayed
unchanged before and after. Paid revision 19 still holds all US$100, with zero
available and final billing unknown. The separate terminal reread audit has
SHA-256 `8a7294b9db00512a9a1c9b906df624097e5acbf5bfe9732392651eb7553e424e`.

This establishes the exact local bytes at the observed time. Mounted Modal
Volume validation, Linux filesystem behavior, GPU/engine startup, direct model
generation, native FLUJO Flow execution and development-speed improvement each
remain separate acceptance work.
