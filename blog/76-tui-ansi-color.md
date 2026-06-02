# Phase 76: TUI ANSI Color

Phase 76 adds zero-dependency ANSI color to `kodr tui`.

The goal was not to build a theme system. It was to make simple terminal turns
easier to scan: status and info in gray, success in green, warnings and pending
reviews in yellow, errors in red, and prompt labels in cyan.

The color layer lives at the TUI presentation boundary. Channel requests,
channel responses, model prompts, JSON output, and artifact files stay plain.
That keeps the shared request path reusable for CLI, TUI, and future web
surfaces.

The color policy follows common terminal conventions:

- color is enabled when the output stream is a TTY
- `NO_COLOR` disables color
- `FORCE_COLOR=1` enables color for tests or explicit user preference

The implementation is a small `src/ansi.mjs` helper with raw ANSI escape codes
and `stripAnsi` for tests. The TUI uses a role-based view wrapper so call sites
ask for success, warning, error, or info output instead of hand-writing escape
codes.
