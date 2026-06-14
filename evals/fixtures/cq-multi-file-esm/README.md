# cq-multi-file-esm

Multi-file ESM coordination. Code-quality trap fixture (phase 140): the model
must write three coordinated ES module files — a Store class, a Cache class
that imports Store, and node:test tests — without slipping into CommonJS
(`require`/`module.exports`) or inventing test APIs (`t.assert()`).

Multi-file coordination under a single prompt is more trap-prone because
the model manages multiple import chains and writes both source and tests
in one turn.
