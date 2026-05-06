---
"@runfusion/fusion": minor
---

Add a sender-side "wake recipient immediately" override for messages. The
message composer now offers a checkbox (when sending to an agent) and the
`fn_send_message` agent tool gains a `wake_recipient` boolean parameter.
When set, the recipient agent is woken on receipt regardless of their own
`messageResponseMode` setting. Carried as `metadata.wakeRecipient: true` on
the message; ignored when the recipient is a user.
