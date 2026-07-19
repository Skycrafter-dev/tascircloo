# Box2D 2.3.1 deterministic scalar port

This directory vendors the rigid-body source from Box2D tag `v2.3.1`, commit
`7e633c4fb86a68bf072fb8ae67ea2c060114750e`.

The game ships a JavaScript port reporting Box2D 2.3.1. JavaScript executes the
upstream `float32` algorithm with IEEE-754 binary64 `Number` values, so this
copy is deliberately altered as follows:

- `float32` is defined as `double`.
- numeric `f` suffixes are removed so constants are not rounded through
  binary32 before entering the solver.
- WebAssembly builds disable floating-point contraction and fast-math.

The original Box2D license notices are preserved in every source file and in
`LICENSE`.
