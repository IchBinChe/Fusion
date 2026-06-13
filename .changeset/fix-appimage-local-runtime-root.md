---
"@runfusion/fusion": patch
---

Fix "Couldn't start local Fusion" on the Linux AppImage (and any packaged build launched from a desktop launcher). The embedded local runtime now roots its data at the user's home directory (`~/.fusion`) instead of `process.cwd()`, which was `/` or the read-only AppImage mount point and caused database creation to fail with EACCES/EROFS. Set `FUSION_HOME` to override the location.
