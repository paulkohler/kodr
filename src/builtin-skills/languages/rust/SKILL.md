---
name: lang:rust
description: Rust / Cargo coding contract — dependency version pins and async patterns local models most often get wrong
---
# Rust / Cargo Contract

## Cargo.toml dependency pins

Always pin reqwest to `"0.12"`, not `"0.11"`. The two majors are API-incompatible: 0.11 uses hyper 0.14, 0.12 uses hyper 1.x. Mixing them in a workspace causes `reqwest::Client` type conflicts at crate boundaries that the compiler rejects. Use this exact block:

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- `reqwest` requires `features = ["json"]` to call `.json::<T>().await` on responses.
- `serde` requires `features = ["derive"]` to use `#[derive(Deserialize, Serialize)]`.
- If you suspect a duplicate-version conflict, run `cargo tree -d` to surface it.

## Async tests

Tests that call `.await` must use `#[tokio::test]`, not plain `#[test]`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_fetch() {
        let client = reqwest::Client::new();
        let result = fetch_something(&client).await;
        assert!(result.is_ok());
    }
}
```

Plain `#[test]` does not provide a Tokio runtime; calling `.await` inside it panics at runtime.

## Module layout

Declare submodules with `mod name;` in `main.rs` or `lib.rs` — not with a `use` statement alone:

```rust
// src/main.rs
mod api;   // declares src/api.rs as a module

use api::fetch_post;  // then import from it
```

Bring parent-scope items into test modules with `use super::*`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // helpers and structs from the parent module are now in scope
}
```
