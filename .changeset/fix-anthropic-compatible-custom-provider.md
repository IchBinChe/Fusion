---
"@runfusion/fusion": patch
---

Fix anthropic-compatible custom providers failing with "No API provider registered for api: anthropic".

`resolveCustomProviderApiType` mapped the `anthropic-compatible` provider type to the api key `"anthropic"`, but pi-ai registers the Anthropic Messages API under `"anthropic-messages"`. Any custom provider configured as `anthropic-compatible` (self-hosted Claude proxy, gateway, etc.) therefore selected a model whose `api` did not match a registered provider and threw at stream time. Mapped it to `"anthropic-messages"` and added a regression assertion alongside the existing openai-compatible / openai-responses coverage.
