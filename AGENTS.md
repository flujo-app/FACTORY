# Local CI before GitHub

Before pushing a change, opening or updating a PR, or dispatching a release for
FACTORY or an integrated repository, run the relevant CI jobs locally on both
Windows and Linux. Use a clean source snapshot, clean dependency install, the
supported Node versions, and the same test, build, package, and smoke commands
as the repository's workflows. Record the commands, versions, and results in
the PR or release notes. GitHub Actions is the confirmation gate after local
success, not the first place to try the change.

For FACTORY, match `.github/workflows/public-sdk.yml` on both platforms: `npm
ci`, production dependency audit, the focused public SDK tests, a fresh install
of `npm pack` output, swarm creation, CLI help, and installed MCP stdio smoke.
Run the supported Node 22.17 and Node 24 lines. On this Windows host, use an
exact supported Node binary; for Linux, a disposable local Docker container
with a tracked-source archive avoids platform-mixed `node_modules` and local
runtime files.

For FLUJO and other integrated repositories, read their current workflows and
run the equivalent Windows and Linux jobs locally before sending changes to
GitHub. If a required platform, service, or check cannot run locally, report
the missing gate and hold the remote change until the user changes this rule.
Do not represent a narrower test as full CI parity.
