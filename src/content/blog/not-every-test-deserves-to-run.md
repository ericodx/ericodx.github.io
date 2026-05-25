---
title: 'Not Every Test Deserves to Run'
description: "How a static call graph turned 30,000 test executions into 6,000 — and what it can't catch."
pubDate: 2026-07-13
tags: ['Testing', 'Performance']
---

_How a static call graph turned 30,000 test executions into 6,000 — and what it can't catch._

## The question that started everything

I've been thinking about test quality for a while. Code coverage tells you which lines were executed — it doesn't tell you whether your tests would catch a bug if one appeared. You can have 100% coverage and still ship a silent failure.

Mutation testing is the answer to that. The idea is disarmingly simple: introduce a small, deliberate defect into your code — a _mutant_ — and check whether your tests catch it. If the tests pass with broken code, they're not doing their job.

The problem is speed.

---

## The naïve approach and why it falls apart

In the classic implementation, mutation testing works like this:

```
for every mutant:
    modify the source file
    run the entire test suite
    check if tests failed (mutant killed) or passed (mutant survived)
    restore the original file
```

That's `O(mutants × tests)`. A modest Swift project might have 200 mutants and 150 tests. That's 30,000 test-file pairs. Each `swift test` invocation takes several seconds just to compile and bootstrap. You're looking at hours of CI time for a single mutation testing run.

I started wondering: do I actually need to run _all_ tests for every mutant? If a function is only exercised by three tests, why run the other 147?

That intuition became the POC.

---

## The hypothesis: not every test is equal

The idea is straightforward — build a static map of which tests can _reach_ which functions, then use that map to filter the test selection per mutant.

If `calculateDiscount` is only called by `testApplyDiscount` and `testFreeShippingThreshold`, there's no point running `testUserLogin` against a mutant inside `calculateDiscount`. It can't possibly detect it.

This is call graph filtering. And validating it — both its speedup and its correctness — was the entire point of the POC.

---

## Choosing SwiftSyntax as the foundation

The first decision was how to analyze Swift source code. The options were:

- **Regex/text scanning** — fast to implement, fragile, breaks on any non-trivial syntax
- **SourceKit** — Apple's tooling layer, powerful but complex to integrate and poorly documented for this use case
- **SwiftSyntax** — Apple's official AST library, used by the Swift compiler itself

SwiftSyntax was the clear choice. It gives you a fully-typed, lossless representation of the source code and a `SyntaxVisitor` protocol that lets you walk the tree node by node. The API is verbose at times, but it's reliable and handles every edge case the Swift language throws at it.

Adding it as the sole dependency was a conscious call. The project's constraint was explicit: no external dependencies unless strictly necessary. SwiftSyntax crossed that bar.

```swift
dependencies: [
    .package(url: "https://github.com/swiftlang/swift-syntax.git", from: "602.0.0"),
]
```

---

## Building the call graph

The core data structure is a `CallGraph`:

```swift
struct CallGraph: Sendable {
    var edges: [FunctionID: Set<FunctionID>]
    var declarations: [FunctionID: String]
    var testFunctions: [FunctionID]
}
```

`edges` maps every function to the set of functions it calls. `declarations` maps every function to the file that contains it. `testFunctions` is the list of entry points — functions annotated with `@Test` or prefixed with `test`.

`CallGraphVisitor` walks each file's AST and populates this structure. It detects call sites by looking at `FunctionCallExprSyntax` nodes, extracting the callee name from either a `DeclReferenceExprSyntax` (bare function call) or a `MemberAccessExprSyntax` (method call).

Once the graph is built, computing reachability is a BFS from each test function:

```swift
func buildReachability(graph: CallGraph) -> [FunctionID: Set<FunctionID>] {
    var reachability: [FunctionID: Set<FunctionID>] = [:]

    for test in graph.testFunctions {
        var visited: Set<FunctionID> = []
        var queue: [FunctionID] = [test]

        while !queue.isEmpty {
            let current = queue.removeFirst()
            guard !visited.contains(current) else { continue }
            visited.insert(current)

            let directCalls = graph.edges[current] ?? []
            for call in directCalls {
                let matches = graph.declarations.keys.filter { $0.name == call.name }
                queue.append(contentsOf: matches)
            }
        }

        reachability[test] = visited
    }

    return reachability
}
```

The inverse query — "which tests reach this function?" — is a simple filter over the reachability map. That's the selection mechanism for every mutant.

---

## Discovering mutations

The second visitor, `MutantDiscoveryVisitor`, scans source files for mutation opportunities. The POC implements two operators:

**Relational Operator Replacement** swaps comparison operators:

| Original | Replacement |
| -------- | ----------- |
| `>`      | `>=`        |
| `>=`     | `>`         |
| `<`      | `<=`        |
| `<=`     | `<`         |
| `==`     | `!=`        |
| `!=`     | `==`        |

**Boolean Literal Replacement** flips `true` to `false` and vice versa.

These two operators alone surface a meaningful class of bugs — off-by-one errors and inverted conditions are among the most common defects in production code. They made for a focused, validatable scope for the POC.

Each mutation is captured as a `MutationPoint`:

```swift
struct MutationPoint: Sendable {
    let filePath: String
    let containingFunction: String
    let operatorName: String
    let description: String
    let position: AbsolutePosition
    let original: String
    let replacement: String
}
```

The `containingFunction` field is what connects a mutant to the call graph. It's how I know which function to look up in the reachability map.

---

## The mutation application problem

Here's where I made a deliberate trade-off that came back to bite me.

Applying a mutation properly requires rewriting the AST — find the exact node, replace it, serialize the tree back to source. SwiftSyntax supports this, but it adds significant complexity: you need to track byte offsets, handle trivia (whitespace and comments), and ensure the serialization is round-trip stable.

For a POC focused on validating the call graph idea, I chose text substitution instead:

```swift
let mutated = original.replacingOccurrences(
    of: " \(mutant.original) ",
    with: " \(mutant.replacement) "
)
```

It's fragile. A token like `>=` appearing as part of a longer expression or inside a string literal could be incorrectly matched. I padded it with spaces to reduce false positives, but that's a heuristic, not a solution.

The decision was intentional and bounded: the fixture project under `Fixtures/SampleProject` was controlled, so the fragility never surfaced. In a real tool, AST-level rewriting is non-negotiable.

---

## Swift 6 and strict concurrency

The project targets Swift 6 with strict concurrency checks enabled. This was not optional — it's the baseline for any new Swift code targeting Apple platforms.

The most immediate consequence: everything that crosses a concurrency boundary must be `Sendable`. All value types in the pipeline — `MutationPoint`, `CallGraph`, `FunctionID`, `TestRunResult` — are structs conforming to `Sendable`. No shared mutable state, no `DispatchQueue`, no Combine.

The test runner introduced the most interesting challenge. Launching a subprocess (`swift test`) and waiting for its completion is inherently async:

```swift
await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    process.terminationHandler = { _ in
        continuation.resume()
    }
}
```

`Process.terminationHandler` is a completion callback — the old concurrency world. Wrapping it in `withCheckedContinuation` bridges it into async/await cleanly, without introducing actors or any other indirection.

The timeout logic is a separate `Task` that sleeps for the configured duration and terminates the process if it's still running. When the process finishes normally, I cancel the timeout task. It's a clean pattern that composes well with structured concurrency.

---

## Running the comparison

The pipeline runs twice for every mutant: once in filtered mode (call graph selection), once in naïve mode (entire suite). The results are collected in parallel arrays and compared at the end.

The metrics that matter:

- **Test execution reduction** — average number of tests run per mutant in filtered mode vs. total suite size
- **Speedup** — total wall-clock time, naïve divided by filtered
- **Divergences** — cases where the two modes disagree on whether a mutant was killed

Divergences are the integrity check. A filtered run that misses a killed mutant means the call graph has a gap — a test was selected that shouldn't have been, or a test that should have been selected was missed. In the fixture project, divergences were zero.

```
Total tests in project:              10
Avg tests per mutant (filtered):     2 of 10
Test execution reduction:            80%

Total time — naïve:      45.3s
Total time — call graph: 9.1s
Speedup:                 4.9×

✓ Results agree in 100% of cases
```

An 80% reduction in test executions yielding nearly a 5× speedup. The hypothesis held.

---

## What I got wrong (and why it's fine)

Static call graph analysis has a fundamental ceiling: it doesn't understand runtime behavior. Protocols dispatch dynamically. Subclasses can override methods. A test that calls a protocol method might reach any conforming type, and the static graph has no way to know which one.

This means the filtered mode can produce false negatives in real-world codebases — mutants marked as `noCoverage` that are actually reachable. The POC's fixture project used concrete types and direct calls, which kept the graph accurate.

There's also the `SchemataScopeAnalyzer` — a component that checks whether a function is compatible with schemata-based mutation (embedding all mutants inside runtime conditionals rather than recompiling per mutant). Functions with `@resultBuilder`, `@ViewBuilder`, or `@SceneBuilder` attributes are excluded because their bodies are transformed in ways that make conditional injection unreliable. This was built in anticipation of a next step that the POC never reached.

---

## What this POC actually proved

The goal was never to ship a production mutation testing tool. It was to answer two questions:

1. **Is call graph filtering fast enough to matter?** Yes. Even in a small project, the reduction is significant. In a large codebase with hundreds of tests, the difference would be an order of magnitude.

2. **Is it correct enough to trust?** For concrete, non-polymorphic call trees: yes. For real-world Swift code with protocols and class hierarchies: more work is needed.

The next step would be replacing text substitution with proper AST rewriting using `SyntaxRewriter`, and augmenting the call graph with type information from SourceKit-LSP to handle dynamic dispatch. But that's a different project.

This one answered what it set out to answer.

---

_The full source code is available at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing). The fixture project is included — you can run it locally with `swift run` and see the comparison yourself._
