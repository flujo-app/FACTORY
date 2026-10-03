# Local pinned-model preparation

Status at **06:40 UTC, October 3, 2026**: the explicit local resume is running.
The first weight shard has reached its canonical filename, and the next is
transferring. The complete public snapshot has **not** passed validation yet.
There is no new Modal deployment, GPU boot, inference or native Flow receipt.
The shared paid ledger remains revision 19: 30 conservatively rounded partial
cents, all US$100 held, zero unallocated, final spend unknown.

The target is `Qwen/Qwen2.5-Coder-7B-Instruct` at
`c03e6d358207e414f1eca0bb1891e29f1db0e242`. Its existing public manifest requires
13 files, including four weight shards, totaling **15,242,805,878 bytes**.
The existing validator must read every required file and check its digest and
the index's 339 tensor references after the SDK download pool finishes.
See [the model definition](modal/README.md) for the exact receipt and filesystem
limits. A filename, download return or progress count cannot establish readiness.

The initial local operation ran from **06:08:24.472 to 06:30:06.953 UTC**.
Its last progress observation reported 4,288,675,840 incomplete bytes and
1,690,479 canonical bytes across five files. At the observed transfer rate, the
initial 3600-second local envelope could not reliably fit the whole snapshot.
A separately reviewed stop helper recorded its intent, verified the actual
Python writer, retained its native process handle and stopped that writer.
The original launcher and Node collector then closed naturally. All partial
files and original logs, source, plan and marker remain preserved.

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

The new operation was admitted at **06:35:36.145 UTC** after independent source
review, explicit hash-bound resume authorization and read-only preflight.
Its first observation reopened **4,330,618,880 incomplete bytes**. At 270 seconds
it reported 4,879,351,255 canonical bytes across six files and 335,544,320
incomplete bytes. These are transfer observations; full-file digest acceptance
is still pending.

The resume reuses the private cache and owned Hub 0.36.0 installation, with
anonymous ordinary HTTP and one download worker. It validates successful Range
responses before appending and refuses oversized partial files. A native
exclusive cache lock disables soft-lock fallback. The direct base interpreter
uses `-I -S -B` and adds only the owned virtual environment's packages, giving
the controller the actual writer PID. Credential discovery and telemetry are
disabled. Original attempt records are checked again after completion.

The **9000-second deadline applies only to this local resume**. Production Modal
configuration and its 3600-second prefetch deadline are unchanged. The local
20 GiB disk reserve and 2 GiB observed process-peak bound are checked during work;
the memory observation is not a hard operating-system quota. Observed progress
peaks remained below 68 MB. Mounted Volume behavior, cloud transfer duration,
GPU loading and inference still require their own live qualification.

Frozen resume worker SHA-256:
`5c7e8aa5811bfe22a988de29916459b5067de5ddbfca47c7275883a263c082d5`.
Collector SHA-256:
`edb280846bf45787ba579a4e576756a4d85f661ad9aad43f6adfde6168f23b50`.
Plan SHA-256:
`caef6f9c8cdddfa01cc2043cabdbe2a7034db23abdc8780b46fe44d6da0c316b`.
They and the private admission, review and authorization are preserved in
`.factory/model-local-20261003-resume-1`. Earlier unexecuted drafts are archived
separately. Syntax checks and an isolated installed-lock API probe passed before
dispatch; they do not substitute for the pending public artifact scan.
