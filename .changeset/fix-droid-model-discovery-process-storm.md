---
"@runfusion/fusion": patch
---

Fix the Droid runtime model discovery spawning a runaway storm of leaked `droid` processes.

`discoverDroidModels` invoked `droid models --json` / `droid model list --json`, but the droid CLI has no such commands — an unknown subcommand is parsed as a *prompt*, so each call launched a full agent session (a persistent `droid exec --stream-jsonrpc` backend) that never exited. The promise never settled and the process leaked; because the dashboard re-loads the droid extension on every chat-send, these piled up into dozens of orphaned `droid` processes.

Discovery now reads the catalog from `droid exec --help` (which lists `Available Models:` + `Custom Models:` and exits cleanly), parsed via the new `parseDroidModelsFromHelp` helper. A SIGKILL-on-timeout guard (`DROID_MODEL_DISCOVERY_TIMEOUT_MS`) ensures any wedged spawn is killed and the promise always settles, so a single discovery call can never leak a process again. Verified end-to-end against the real binary (46 models incl. custom, 0 leaked processes).
