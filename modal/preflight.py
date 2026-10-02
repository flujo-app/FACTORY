"""Read-only credential/rate discovery. Never print credentials or raw errors."""

import asyncio
import contextlib
import importlib.metadata
import io
import json

import modal


async def discover():
    workspace = modal.Workspace.from_context()
    result = {"readOnly": True, "sdkVersion": importlib.metadata.version("modal"),
              "appBudgetSupported": False, "proxyTokenEndpointScopeSupported": False,
              "budgetPolicyChanged": False}
    try:
        settings = await asyncio.wait_for(workspace.settings.list.aio(), 20)
        result.update({"credentialsAccepted": True, "defaultEnvironment": settings.default_environment})
        rates = await asyncio.wait_for(workspace.billing.rates.aio(), 20)
        # Names and prices only, never an unrestricted object dump.
        result["rates"] = {key: str(value) for key, value in rates.items()
                           if any(word in key.lower() for word in ("l4", "cpu", "memory", "mem_", "ram", "volume", "egress"))}
    except Exception as error:
        result.update({"credentialsAccepted": result.get("credentialsAccepted", False),
                       "discoveryErrorType": type(error).__name__})
    return result


if __name__ == "__main__":
    # SDK diagnostics are private to this process; the only public output is
    # the explicit safe metadata allowlist above.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = asyncio.run(discover())
    print(json.dumps(result))
