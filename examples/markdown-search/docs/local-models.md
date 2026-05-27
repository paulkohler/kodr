# Local Models

This document describes how Kodr interacts with local OpenAI-compatible model servers.

- Default LM Studio base URL: `http://localhost:1234/v1`.
- Model timeout: `600000ms`.
- The harness treats model output as untrusted and validates all inputs through workspace safety checks before any file writes or network calls.
- Local models are accessed via the `koder probe` command for connectivity verification.