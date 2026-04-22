# Hermes Runtime Plugin

> **Status:** Scaffolded - Full implementation deferred to FN-2264

Provides a Hermes AI runtime plugin for Fusion, enabling AI agent execution capabilities for task automation.

## Overview

This plugin registers the Hermes runtime with the Fusion plugin system. The Hermes runtime is designed to provide AI-powered task execution capabilities for Fusion tasks.

**Note:** The runtime behavior is intentionally deferred. Any runtime invocation will return a "not implemented" signal referencing FN-2264 for the full implementation.

## Features

- **Hermes Runtime Registration**: Registers the Hermes runtime with the Fusion plugin system
- **Runtime Discovery**: Exposes runtime metadata for plugin discovery pipeline
- **Runtime Factory**: Provides factory function for runtime instance creation (placeholder)

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-hermes-runtime ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin install /path/to/fusion-plugin-hermes-runtime
```

## Current Status

| Component | Status |
|-----------|--------|
| Plugin Scaffold | ✅ Complete |
| Runtime Registration | ✅ Complete |
| Runtime Behavior | ⏳ Deferred to FN-2264 |

## Runtime Registration

The plugin registers a runtime with the following metadata:

- **Runtime ID:** `hermes-runtime`
- **Name:** `Hermes AI Runtime`
- **Description:** AI agent execution runtime for Fusion tasks
- **Version:** `0.1.0`

### Deferred Implementation

The runtime factory currently returns a placeholder object. When `execute()` is called, it throws an error referencing FN-2264:

```
Error: Hermes runtime is not yet implemented. Full implementation deferred to FN-2264.
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

### Test Coverage

The plugin includes comprehensive tests covering:

- Plugin manifest identity verification
- Runtime registration presence and metadata consistency
- Deferred implementation behavior (placeholder, error on execute)
- Plugin lifecycle hooks (onLoad, onUnload)

## API

### Plugin Manifest

```json
{
  "id": "fusion-plugin-hermes-runtime",
  "name": "Hermes Runtime Plugin",
  "version": "0.1.0",
  "description": "Hermes AI runtime plugin for Fusion",
  "author": "Fusion Team",
  "homepage": "https://github.com/gsxdsm/fusion",
  "runtime": {
    "runtimeId": "hermes-runtime",
    "name": "Hermes AI Runtime",
    "description": "AI agent execution runtime for Fusion tasks",
    "version": "0.1.0"
  }
}
```

### Exports

The plugin exports the following for testing and verification:

- `default` - The FusionPlugin instance
- `hermesRuntimeMetadata` - Runtime manifest metadata object
- `hermesRuntimeFactory` - Factory function for creating runtime instances
- `HERMES_RUNTIME_ID` - Runtime ID constant (`"hermes-runtime"`)

## Related

- [FN-2264](https://github.com/gsxdsm/fusion/issues/FN-2264) - Full Hermes runtime implementation

## License

MIT
