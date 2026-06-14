# Phase 142: Watch Repairs You Can Actually Use

`kodr watch` has always been able to detect failing tests and propose a repair.
What it couldn't do was let you act on that repair. After generating a proposal,
it printed:

```
[watch] Repair proposed as pending review. Use /accept or /reject in TUI.
```

But `kodr watch` runs standalone. The TUI was a suggestion, not a path.

## What changed

In TTY mode (interactive terminal), after generating a repair proposal, the
watch loop now shows what would change and asks:

```
[watch] Repair proposed (2 files): src/math.mjs, test/math.test.mjs
[watch] Accept repair? [y/N]
```

Type `y` and the repair is applied immediately. Type `n` (or just press Enter)
and it's discarded, with the watch loop ready for the next file change.

Under the hood, accepting calls the same `apply-proposal` channel request the
TUI uses for `/accept`. The proposed writes land on disk; `kodr undo` still
works to reverse them.

## What didn't change

Non-TTY mode (piped stdin, CI, watch from within TUI) keeps the existing
pending-review message. The repair is still generated; it's just not
auto-prompted. If a TUI integration is ever wired up, it can pick up the
proposal from there.

## The no-progress guard message

The no-progress guard message also got more specific. Previously: "No repair
proposed after multiple attempts." Now it names how many attempts failed, so
you know when the guard is actually the reason the watch loop stopped trying:

```
[watch] No repair proposed after 2 attempts — waiting for a file change before retrying.
```

## Daily-driver shape

The full `kodr watch` loop is now:
1. File changes → tests run
2. Tests fail → model proposes a repair → changed files listed → "Accept [y/N]?"
3. Accept → writes land, tests re-run on next change
4. Reject → discard, watch for next change
5. No proposal after 2+ attempts → wait for file change
6. 3 repair attempts → wait for file change (no-progress guard)
