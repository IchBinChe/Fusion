---
"@gsxdsm/fusion": minor
---

Add multi-project CLI commands and --project flag

- New `kb project` subcommand: list, add, remove, show, set-default, detect
- Global `--project <name>` flag for all task operations
- Project context resolution: flag → default → auto-detect
- Cross-project task management without changing directories
