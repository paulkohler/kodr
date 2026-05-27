# Todo CLI (JSON-backed)

A small ESM example app that persists todos to a JSON file.

## Usage

```sh
# add a todo
node src/cli.mjs add "Buy milk"

# list todos
node src/cli.mjs list

# mark done by id
node src/cli.mjs done <id>

# delete by id
node src/cli.mjs delete <id>
```

## Choose the JSON file

Use `--file` to control where the todo JSON is stored:

```sh
node src/cli.mjs --file ./todos.json add "Write docs"
node src/cli.mjs --file ./todos.json list
```

## Tests

```sh
npm test
```
