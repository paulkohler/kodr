# Todo CLI Example

A minimal command‑line todo app built with Kodr.

## Install / run

```sh
npm install   # (no deps)
node src/cli.mjs add "Buy milk" --file ./example.json
node src/cli.mjs list --file ./example.json
node src/cli.mjs done 1 --file ./example.json
node src/cli.mjs delete 1 --file ./example.json
```

## Commands

- `add <text>` – add a new todo item.
- `list` – list all items.
- `done <id>` – mark an item as done.
- `delete <id>` – remove an item.

## License

MIT