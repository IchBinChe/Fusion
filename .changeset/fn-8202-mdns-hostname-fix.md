---
"@runfusion/fusion": patch
---

summary: Stop fn dashboard from making macOS rename its own local hostname over mDNS.
category: fix
dev: node-discovery now advertises a Fusion-owned mDNS host (fusion-<nodeId8>) instead of os.hostname(), avoiding the self-conflict rename; adds global setting `localNetworkDiscoveryEnabled` (default true) to disable LAN auto-discovery in `fn dashboard`/`fn serve`.
