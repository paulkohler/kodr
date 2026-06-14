# Phase 144: The Lost /quit

Piping commands to `kodr tui` should work. You should be able to write a
script that drives the TUI non-interactively:

```bash
printf '/status\n/quit\n' | kodr tui
```

It didn't. `/status` ran fine. `/quit` was silently dropped. The TUI exited
with an EOF reason and no "bye" message.

## Why it happened

`rl.question()` registers a one-time `'line'` listener each call. Readline
processes buffered pipe data immediately — it doesn't wait for you to call
`rl.question()` before emitting `'line'` events. The sequence:

1. Two lines arrive from the pipe (`/status\n/quit\n`)
2. Readline buffers both and starts emitting `'line'` events
3. First `rl.question()` captures `/status`
4. `handleTuiLine('/status')` runs (synchronous — fast)
5. `/quit` `'line'` event fires during the brief moment between `handleTuiLine`
   returning and the next `rl.question()` being registered
6. Nobody is listening → `/quit` fires into the void
7. Readline reaches EOF → emits `'close'`
8. Next `rl.question()` throws "readline was closed"
9. TUI exits with `reason: 'eof'`

This race exists for any fast synchronous command followed by a second piped
command. A slow model turn makes it much worse — `/quit` would land while the
model is still generating and would always be dropped.

## The fix

Replace `rl.question()` with the readline async iterator:

```js
for await (const line of rl) {
    // process line
}
```

The async iterator queues every `'line'` event internally. Lines that arrive
while `handleTuiLine()` is awaiting are buffered, not lost. They're consumed
on the next `for await` iteration, in order.

For interactive (TTY) use, `rl.setPrompt()` + `rl.prompt()` replaces the
prompt display. For piped use, the prompt string is written manually. Both
paths produce the same output as before — the change is invisible from outside.

## After

```bash
$ printf '/status\n/quit\n' | kodr tui
kodr 0.0.144
assistant> session: new
...

user> assistant> session=new
model=qwen/qwen3.6-35b-a3b
...
user> assistant> bye
```

`/quit` is now processed. Scripted TUI sessions work.
