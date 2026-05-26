# Phase 22: Permission Policy

Hooks gave Kodr a lifecycle boundary. Permission policy gives it a policy object that can make allow/deny decisions before tool effects happen.

The first policy layer is intentionally conservative. Defaults preserve existing behavior: file operations are still jailed by the safe-write path logic, verification commands still go through the allowlist, public network fetches still pass through private-address blocking, and writes still dry-run unless explicitly applied.

Configuration can now narrow that behavior for tool calls. A policy can deny reads, writes, apply behavior, commands, network access, or specific network hosts. This is not a replacement for the existing hardening checks; it is an earlier policy gate in front of them.

The integration point is `ToolRunner`, where model-originated tool requests converge. Later phases can expose policy configuration through CLI or project files, but the core contract is now tested.
