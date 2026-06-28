---
"@runfusion/fusion": patch
---

summary: Import Tasks view now fills the full height of the screen for Issues and Pull Requests.
category: fix
dev: Embedded GitHubImportModal `.github-import-modal__body` gets `flex: 1` outside the <=640px block so the flex/height chain fills `.project-content`.
