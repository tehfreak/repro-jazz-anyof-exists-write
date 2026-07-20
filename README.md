# repro-jazz-anyof-exists-write

Repro for a row-level permission bug in jazz. On the write path, an `anyOf(...)` whose branches
contain `exists` (or `inherits`) checks is evaluated as `allOf(...)`. A write that should pass one
branch gets denied unless every other branch's `exists` also holds.

## Status

Reproduced against `jazz-tools@2.0.0-alpha.53` (native `jazz-napi@2.0.0-alpha.53`). Not reported
upstream yet.

## What happens

The repro defines an insert policy on `docs` and seeds only `gate_a` for the acting user, then
tries to insert as that user. Four shapes of the same two `exists` checks:

```
ok   single exists, gate_a seeded             want allowed  got allowed
BUG  anyOf([gate_a, gate_b]), gate_a seeded   want allowed  got denied
ok   allOf([gate_a, gate_b]), gate_a seeded   want denied   got denied
ok   allOf([gate_a, gate_b]), both seeded     want allowed  got allowed

VERDICT: BROKEN
```

A single `exists` works. `allOf` of two works both ways. But `anyOf([gate_a.exists, gate_b.exists])`
denies the write even though `gate_a` holds, because the two `exists` end up ANDed together.

Reads are not affected. The select path evaluates the same policy correctly. This is write only
(insert, and update `with_check` / `using`), so the local write check and the server authorization
check disagree on the same policy.

## Run it

```
npm install
npm run typecheck
npm run repro
```

## Why it's a bug

The write path splits a policy into simple parts (evaluated inline) plus a flat list of complex
clauses (EXISTS, INHERITS) that get graph-evaluated. The split drops the boolean structure, and
the flat list is then required to pass in full:

```
crates/jazz-tools/src/query_manager/policy.rs:2013      all_complex.extend(result.complex_clauses)
crates/jazz-tools/src/query_manager/policy.rs:2020      SimpleEvalResult { passed: true, complex_clauses: all_complex }
crates/jazz-tools/src/query_manager/writes.rs:1513      if !graph.result() { return false }
```

In the `Or` arm of `evaluate_simple_recursive`, every passing branch contributes its complex
clauses to one `Vec`. The caller in `writes.rs` then requires all of them, so `anyOf` becomes
`allOf` for any branch carrying an `exists`.

A branch made only of complex clauses is the trap. Its simple parts pass vacuously, so it never
gets filtered out, and its `exists` clauses always leak into the shared AND. A branch that also
has a simple predicate (say `allOf([ownerLiteral, subscriptionExists])`) is filtered out when the
literal fails, which is why an owner-style branch can look fine while a co-owner-style branch
(`allOf([adminExists, subscriptionExists])`, two exists, no literal) breaks the sibling branch.

## Suggested fix

Evaluate the whole write policy with the recursive, graph-capable evaluator that the read path
already uses (`PolicyContextEvaluator::evaluate_expr_with_context` in
`crates/jazz-tools/src/query_manager/graph_nodes/policy_eval.rs`), where `And` is `all`, `Or` is
`any`, and each `Exists` builds its own subgraph. That preserves the boolean structure and also
removes the divergence between the local write check and the server authorization check.

The narrower alternative is to keep the fast-path split but carry the And/Or tree through
`SimpleEvalResult` instead of a flat `Vec`, and have `writes.rs` evaluate `Or` as `any` rather
than requiring every collected clause.

## CI

`.github/workflows/reproduce.yml` typechecks, runs the repro, and asserts the verdict. The job is
green while it prints `VERDICT: BROKEN` and goes red if it prints `VERDICT: WORKS`, so it flips
the moment jazz starts evaluating `anyOf` of `exists` correctly on writes.
