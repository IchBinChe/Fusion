---
"@runfusion/fusion": patch
---

Add a defensive guard in `Database` constructor that throws when opening a database at a path whose last two segments are both `.fusion`. This catches caller bugs where a `.fusion` directory is passed in place of a project root (causing `.fusion/.fusion/fusion.db` to be silently created). Future regressions of this class of bug now fail loudly at the originating call site instead of leaving stray nested directories.
