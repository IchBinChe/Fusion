---
"@runfusion/fusion": minor
---

summary: Task documents and project files are now editable in the Artifacts view, task documents render markdown by default, and the select-to-comment "Add comment" button works again.
category: feature
dev: DocumentsView embeds the shared CodeMirror FileEditor for task-document (PUT /tasks/:id/documents/:key) and project-file (project workspace file API) edits. The Add comment no-op was a CSS bundle-order regression — `.btn:active` out-ordered the equal-specificity trigger rule; the `:active` rules now use `.btn.selection-comment-trigger` (0,3,0) with a test asserting the prefix.
