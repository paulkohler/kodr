# Phase 47: TUI Streaming Status

Phase 47 makes `kodr tui` less opaque during slow local model calls.

The earlier LM Studio experiments showed that a local model can spend a long time processing a prompt before any useful output appears. A line-oriented TUI does not need a full display system, but it does need to say what it is doing.

Each TUI turn now prints request metadata before the model call starts: model, provider, session target, apply mode, tools mode, timeout, and loop budgets. While the call is running, the TUI emits elapsed-time status lines. That is intentionally simple, but it gives the user a heartbeat during long local calls.

Streaming mode now has a real terminal path too. The model client accepts an `onStreamContent` callback for streamed text fragments. `kodr tui --stream` wires that callback to stdout, so chunks appear as they arrive while the normal run artifacts still receive the complete final response.

This phase also kept the EOF fix from Phase 46 in scope: piped TUI input should exit cleanly after the final turn, not throw a readline exception. That matters for scripted local tests and future channel automation.
