---
"@runfusion/fusion": patch
---

Fix the standalone `fn plugin new` scaffold so generated plugins include the required `state: "installed"` field and build unedited with `pnpm build`. This also lets the documented `fn plugin dev . --once` path complete its pre-load build step instead of failing TypeScript validation for a missing `FusionPlugin.state`.

Manual end-to-end spot-check for release validation: `npx @runfusion/fusion@<ver> plugin new proof-point-plugin && cd proof-point-plugin && pnpm install && pnpm build && npx @runfusion/fusion@<ver> plugin dev . --once`.

Registry evidence captured for the original failing release: `npm view @runfusion/fusion@0.43.0 dist.integrity` returned `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`.
