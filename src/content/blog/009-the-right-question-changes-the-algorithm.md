---
title: 'The Right Question Changes the Algorithm'
description: 'When parallelism wasn''t enough, I stopped asking "how do I run more mutants at once?" and started asking "how do I eliminate redundant compilations?" --...'
pubDate: 2026-02-21
tags: ['Performance', 'Mutation Testing']
---

_When parallelism wasn't enough, I stopped asking "how do I run more mutants at once?" and started asking "how do I eliminate redundant compilations?" -- and then the system taught me a lesson about the gap between projections and reality._

---

## The Ceiling That Parallelism Cannot Break

I had already parallelized my mutation testing pipeline. The parallel executor cut 41% off the total time — from 164 seconds down to 96. A real, measurable, correct gain.

And, at the same time, completely insufficient.

For a project where `swift test` takes 20 seconds -- not a large project, just a modest one -- projecting the numbers is depressing:

```
500 mutants x 20s per run / 15 cores = ~11 minutes
```

Eleven minutes per mutation run. In CI, where you don't control the environment and often have fewer than 15 cores available, it could be 30 minutes or more. Nobody waits 30 minutes for test quality feedback.

Parallelism helped. But the real problem was never the serialization of runs -- it was the cost of **recompilation per mutant**.

Each mutant requires:

1. Creating a sandbox with the modified file
2. Running `swift build` -- full compilation
3. Running `swift test`
4. Discarding the sandbox

Step 2 dominates. And it happens N times, once for every mutant.

The right question was never: _how do I run more mutants in parallel?_

It was: **how do I eliminate the redundant compilations?**

---

## The Intuition: Embed Everything in a Single Build

Imagine that instead of modifying a file once per mutant, you modify the file a single time with **all mutants embedded simultaneously**, each protected by a runtime condition:

```swift
func calculateDiscount(_ price: Double, _ quantity: Int) -> Double {
    switch __mutationTestID {
    case "mutationTest_0":
        // mutant: price * 0.1 -> price * 0.0 (ArithmeticOperatorReplacement)
        if quantity > 10 {
            return price * 0.0
        }
        return price

    case "mutationTest_1":
        // mutant: > -> >= (RelationalOperatorReplacement)
        if quantity >= 10 {
            return price * 0.1
        }
        return price

    default:
        // original code
        if quantity > 10 {
            return price * 0.1
        }
        return price
    }
}
```

Compile **once**. Then, for each mutant, run the tests with a different environment variable:

```bash
__MUTATION_TEST_ACTIVE=mutationTest_0 swift test  # test mutant 0
__MUTATION_TEST_ACTIVE=mutationTest_1 swift test  # test mutant 1
# no variable = original code (baseline)
```

This pattern has a name: **Mutant Schemata**. The idea has existed in the mutation testing literature since the 1990s. The execution in Swift 6 is where the story gets interesting.

---

## Obstacle 1: Not Every Function Body Is Schematizable

The first version of `SchemataGenerator` instrumented any function that had mutations. Simple, direct, wrong.

There are functions that Swift compiles differently, where injecting an arbitrary `switch` is not valid -- or worse, compiles but silently produces incorrect behavior.

### Result Builders

```swift
@ViewBuilder
var body: some View {
    if isLoading {
        ProgressView()
    } else {
        ContentView()
    }
}
```

Functions with `@resultBuilder`, `@ViewBuilder`, or `@SceneBuilder` are transformed by the compiler before generating code. The body you write is not the body the compiler processes. Injecting a `switch __mutationTestID` into a `@ViewBuilder` produces a compilation error -- the body builder doesn't know what to do with an arbitrary control statement in the middle of its DSL.

### Single-Expression Implicit Returns

```swift
func isEven(_ n: Int) -> Bool { n % 2 == 0 }
```

Functions with a single statement that is not an explicit `return` use implicit return. A `switch` with five cases is not a single expression -- the compiler refuses.

The solution was `SchemataScopeAnalyzer`: a visitor that walks the AST before generation and marks incompatible functions:

```swift
private final class IncompatibleFunctionVisitor: TypeScopeVisitor {
    var incompatibleIDs: Set<FunctionID> = []

    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind {
        let id = FunctionID(
            moduleName: "",
            typeName: typeNameStack.last,
            functionName: node.name.text,
            parameterLabels: node.signature.parameterClause.parameters.map {
                $0.firstName.text
            }
        )

        if hasBuilderAttribute(node.attributes) || hasSingleImplicitReturn(node.body) {
            incompatibleIDs.insert(id)
        }

        return .visitChildren
    }
}
```

Mutants in incompatible functions are not discarded -- they are delegated to the standard executor (individual recompilation). Schemata and the classic executor coexist in the same run.

---

## Obstacle 2: Swift 6 and the Activation Variable

The variable `__mutationTestID` needs to exist in every instrumented file. It's what the `switch` reads to know which mutant to activate:

```swift
nonisolated(unsafe) let __mutationTestID: String? =
    ProcessInfo.processInfo.environment["__MUTATION_TEST_ACTIVE"]
```

Every detail of this declaration was forced by the compiler.

**`nonisolated(unsafe)`** -- without this, Swift 6 refuses. A global `let` that reads `ProcessInfo.processInfo.environment` at the declaration point is accessed by all concurrent tasks. The compiler cannot prove the access is safe without explicit isolation. `nonisolated(unsafe)` says: _I know what I'm doing; this read happens once during process initialization, before any concurrency._

If you write just `let __mutationTestID = ...`, you get:

```
error: reference to var '__mutationTestID' is not concurrency-safe
because it involves shared mutable state
```

**`String?`** -- the variable is optional because, during tests of the original code (baseline, with no mutant active), the environment variable is not set. The `switch __mutationTestID` falls through to `default` and executes the original code. Perfect.

This declaration is injected as a prefix in every file instrumented by `SchemataGenerator`:

```swift
let activationDecl =
    "nonisolated(unsafe) let __mutationTestID: String? = " +
    "ProcessInfo.processInfo.environment[\"__MUTATION_TEST_ACTIVE\"]\n\n"

return SchematizedSource(source: activationDecl + rewritten.description, manifest: manifest)
```

---

## Obstacle 3: The Manifest Bug

`SchemataGenerator` produces two things: the instrumented source code and a **manifest** -- the list of mutants that were actually embedded in the code.

In the first implementation, the manifest was built naively: it took all received mutants and included them directly.

```swift
// Wrong implementation
let manifest = mutations.enumerated().map {
    (mutantID: "mutationTest_\($0)", mutationPoint: $1)
}
```

The problem: not every mutant can be embedded in a function. Mutants in simple computed properties, in implicit `init`s, or in code outside any function body **pass through the `SchemataScopeAnalyzer` filter** (they are not incompatible due to builder attributes) but also **don't end up inside any function body** that `FunctionBodyCollector` can map.

These mutants appeared in the manifest but weren't in the instrumented code. When the executor tried to activate `mutationTest_7`, the `switch` executed the `default` -- the original code. The mutant "ran," the tests passed, and it was marked as **survived**. A systematic false negative.

The test that revealed the bug:

```swift
@Test func givenMutationOutsideAnyFunctionBody_whenGenerating_thenManifestIsEmpty() {
    let source = ParsedSourceFixture.make("""
        let globalValue = 1 + 2
        """)
    let mutation = MutationPoint(
        filePath: source.file.path,
        utf8Offset: 20,
        operatorIdentifier: "ArithmeticOperatorReplacement",
        replacement: "-"
    )

    let result = SchemataGenerator().generate(source: source, mutations: [mutation])

    #expect(result.manifest.isEmpty)
}
```

The fix: build the manifest **only from mutants that were actually instrumented**, tracking which IDs were successfully mapped to a function body:

```swift
var instrumentedIDs: Set<String> = []
for item in indexed {
    guard let bodyOffset = collector.enclosingBodyOffset(for: item.mutation.utf8Offset) else {
        continue  // mutant outside a function: not instrumented
    }
    mutationsByBodyOffset[bodyOffset, default: []].append((item.id, item.mutation))
    instrumentedIDs.insert(item.id)
}

let manifest =
    indexed
    .filter { instrumentedIDs.contains($0.id) }
    .map { (mutantID: $0.id, mutationPoint: $0.mutation) }
```

Small change. Enormous consequence for the correctness of results.

---

## Obstacle 4: Injecting the Environment Variable into the Process

The parallel executor used `ProcessLauncher.launchCapturing` without any support for custom environment variables. Honoring the contract `__MUTATION_TEST_ACTIVE=mutationTest_3 swift test` required changing the signature.

The change is surgical but has a Swift 6 subtlety:

```swift
func launchCapturing(
    executableURL: URL,
    arguments: [String],
    environment: [String: String]? = nil,   // new parameter
    workingDirectoryURL: URL,
    timeout: Double
) async throws -> (exitCode: Int32, output: String) {
    let mergedEnvironment = environment.map {
        ProcessInfo.processInfo.environment.merging($0) { _, new in new }
    }
    // ...
    if let env = mergedEnvironment {
        process.environment = env
    }
}
```

The received `environment` is _additive_, not a replacement. If you pass only `["__MUTATION_TEST_ACTIVE": "mutationTest_3"]` to the process without preserving the parent environment, the child process loses `PATH`, `HOME`, `SDKROOT`, and all the context needed for `xcrun swift test` to work. The `.merging` with `{ _, new in new }` ensures custom variables override the parent environment when there's a conflict, but the parent environment is preserved entirely.

---

## Obstacles 5-7: The Craft of Making It Fit

Three more obstacles were less conceptual and more operational, but each taught something.

**Duplication detection.** The pre-commit hook `swift-cpd` flagged that all AST visitors -- `IncompatibleFunctionVisitor`, `FunctionBodyLocator`, and the two in `CallGraphBuilder` -- shared identical `typeNameStack` management: six `visit`/`visitPost` pairs for Actor, Class, Enum, Extension, Protocol, and Struct. The fix was extracting a `TypeScopeVisitor` base class. Each visitor went from 80+ lines to under 20.

**Atomic commits.** Committing only the new `TypeScopeVisitor.swift` without the refactored consumers caused CPD to detect _new_ clones -- between the base class and the not-yet-updated visitors. Structural refactorings need to be committed atomically. The ideal of "one file per commit" breaks when a codebase invariant (no duplication) can only hold with all files consistent.

**Function length.** `executeFile` had 62 lines; SwiftLint enforces 50. The solution was extracting `runSchemataMutations` -- a function with a single responsibility: given a manifest and an already-compiled sandbox, execute each mutant and return results. No fallback logic, no partition decisions. The orchestration method handles policy; the extracted function handles mechanics.

---

## The Complete Flow

With all obstacles resolved, `SchemataCompilationUnit` orchestrates like this:

```
For each file with mutants:
    1. SchemataScopeAnalyzer -> identify incompatible functions
    2. Partition -> compatible[] / incompatible[]
    3. incompatible -> MutationExecutor (individual recompilation)
    4. SchemataGenerator(compatible) -> SchematizedSource + manifest
    5. If manifest empty -> MutationExecutor(compatible) (fallback)
    6. SandboxFactory -> create sandbox with instrumented file
    7. swift build -> compile ONCE
    8. If build failed -> MutationExecutor(compatible) (fallback)
    9. For each (mutantID, mutationPoint) in manifest:
           __MUTATION_TEST_ACTIVE=mutantID swift test -> result
```

The fallback at two points (empty manifest, failed build) ensures no mutant is lost. The final result mixes schemata results with classic executor results -- the consumer (`main.swift`) receives a single `[MutantResult]` without needing to know which path each mutant took.

---

## 225 Tests. All Passing.

The new components added 17 tests across three suites: `SchemataScopeAnalyzerTests` (six cases covering each incompatibility type), `SchemataGeneratorTests` (seven cases including the manifest bug regression), and `SchemataCompilationUnitTests` (four cases with mocked `ProcessLauncher`). Combined with the existing suite:

```
Test run with 225 tests in 39 suites passed after 0.049 seconds.
```

---

## The Performance Projections

With schemata active (`--fast`), the equation changes fundamentally:

| Metric                | Classic executor   | With schemata    |
| --------------------- | ------------------ | ---------------- |
| Compilations per file | N (one per mutant) | 1                |
| Test executions       | N                  | N                |
| Dominant cost         | `swift build` x N  | `swift test` x N |

For a file with 10 mutants and `swift build` at 8 seconds, `swift test` at 3 seconds:

```
Classic executor: (8 + 3) x 10 = 110 seconds
Schemata:          8 + (3 x 10) = 38 seconds
Speedup: 2.9x
```

For 50 mutants in the same file:

```
Classic executor: (8 + 3) x 50 = 550 seconds
Schemata:          8 + (3 x 50) = 158 seconds
Speedup: 3.5x
```

The speedup grows with the number of mutants per file. And it grows even more when combined with the parallel executor -- because what's being parallelized now are `swift test` runs (fast), not `swift build + swift test` (slow).

The projection for the parallel schemata combination was even more ambitious:

```
Estimated time = (70 mutants / 15 workers) x 0.36s/run
              ~ 4.7 slots x 0.36s
              ~ 1.7s of runs
              + 3 compilations x ~1.7s each
              = ~7s total
```

Conservatively, with system and scheduling overhead:

```
Parallel schemata: ~22s
Sequential schemata: 113s
Expected speedup: ~5x
```

The numbers made perfect sense. The plan was clear: extract the loop body into a `runSingleTestRun` function, replace the `for...in` with a task group using bounded concurrency, add cache integration so the second run costs almost nothing. Three commits. Done.

---

## The Dangerous Moment

There is a moment, in any performance project, when the numbers on the whiteboard make perfect sense. You have the equation. The factors fit together. The projected speedup seems almost conservative.

That moment is dangerous.

Not because the math is wrong -- it rarely is. But because the math describes a system that doesn't exist yet, and the real system has layers that the model ignores.

This is the story of a 5x bet that hit a lock no paper benchmark had predicted.

---

## The Number That Appeared on Screen

The implementation followed the plan. `runSingleTestRun` became an isolated function, receiving the mutant ID, the mutation point, the sandbox where the schematized binary lived, and the hashes for the cache key. The task group followed the same bounded pattern from `MutationExecutor` -- fill up to the concurrency limit, then add a new task for each result collected.

```swift
try await withThrowingTaskGroup(of: MutantResult.self) { group in
    var activeTasks = 0
    var iterator = manifest.makeIterator()

    while activeTasks < concurrency, let (mutantID, mutationPoint) = iterator.next() {
        group.addTask {
            try await self.runSingleTestRun(
                mutantID: mutantID,
                mutationPoint: mutationPoint,
                sandbox: sandbox,
                fileContentHash: fileContentHash,
                testHash: testHash
            )
        }
        activeTasks += 1
    }

    for try await result in group {
        results.append(result)
        if let (mutantID, mutationPoint) = iterator.next() {
            group.addTask {
                try await self.runSingleTestRun(...)
            }
        }
    }
}
```

The build passed. All 206 tests passed.

Time to measure.

```
Run 1: 106.1s
Run 2: 108.7s
Run 3: 114.9s
Average: 109.9s
```

Silence.

Sequential schemata was 113.1 seconds. Parallel schemata came in at 109.9 seconds.

A gain of 3%.

Not 5x. Not 22 seconds. Three percent -- within the variance margin of any benchmark run.

The implementation was correct. The result was wrong. What had happened?

---

## The SPM Lock Nobody Drew on the Whiteboard

The hypothesis arrived while watching the Activity Monitor logs during execution. Fifteen `swift test` processes active at the same time -- but in bursts, not constant parallel. There was a wait pattern. The processes started, stayed busy for a moment, and then a subset of them progressed while the others waited.

The culprit: `.build/manifest.db`.

The Swift Package Manager, before executing anything, acquires an exclusive lock on this file to check whether the project needs to be recompiled. It's a fast operation -- less than a second under normal conditions. But "less than a second per process" with 15 concurrent processes sharing the same sandbox directory becomes systematic serialization.

```
Ideal (model):
[P1 ----------------]
[P2 ----------------]
[P3 ----------------]
...

Real (with lock):
[P1 -> lock -> ---- run ---]
              [P2 -> lock -> ---- run ---]
                            [P3 -> lock -> ---- run ---]
```

The test runs weren't running in parallel. They were queuing to acquire the lock, then running in near-perfect sequence.

The shared sandbox -- which seemed like an advantage (the already-compiled binary, available to all workers) -- was exactly the problem. SPM was not designed for multiple concurrent processes in the same build directory.

---

## An Honest Assessment

The experiment revealed two separate things about schemata:

**First:** the test run parallelization strategy is correct and would work if the SPM lock didn't exist. The task group, the bounded concurrency, the cache integration -- all correctly implemented, verified by tests.

**Second:** the architecture of "all workers share the same sandbox" is incompatible with how SPM manages state. It's not a bug. It's a design limitation that only became visible under high concurrency conditions.

The cache, at least, behaved as expected. On the second run with `--fast` (warm cache):

```
Time: 5.8s
```

Versus the parallel executor with warm cache:

```
Time: 0.4s
```

Both numbers make sense. The parallel executor, with a hot cache, doesn't even start compilations -- it goes straight to cached results, cost is almost zero beyond I/O. Schemata, even with all mutants in cache, still needs to compile the schematized binary per file before reaching the point where the cache key can be consulted. That's 3 compilations x ~1.7s = ~5 seconds of fixed cost that the cache cannot eliminate.

---

## The Next Problem Is Isolation

The next problem to solve is no longer about concurrency. It's about isolation.

Two hypotheses are being sketched, still without benchmarks.

### Hypothesis 1: Direct Test Binary Execution

What happens if `swift test` is removed from the equation completely?

The Swift Testing binary is a real executable, compiled to `.build/debug/<target>.xctest/Contents/MacOS/<target>` (or equivalent on Linux). It can be executed directly, passing the mutant activation environment variables.

Without `swift test`, there's no SPM. Without SPM, there's no lock. Each worker launches the binary directly, without serialization.

The cost would be pure test execution time -- no SPM scaffolding overhead -- with true concurrency across all 15 workers.

This would eliminate the current bottleneck. The projection of ~7s could be achievable. But there are unknowns: does the test binary have environment dependencies that `swift test` resolves automatically? Would test resources like `Bundle.module` and fixtures break? Would projects with integration tests that depend on external services behave differently?

These are questions only an experiment can answer.

### Hypothesis 2: Cache Verification Before Schemata Compilation

The current path, even with a warm cache, always compiles the schematized binary per file before consulting the cache mutant by mutant. This creates a fixed cost of ~1.7s per file -- irreducible by the current cache.

The idea: before starting the schematized compilation of a file, check whether **all** mutants for that file already have cached results. If so, return the results directly, without compiling anything.

This would transform the schemata warm cache from 5.8s to something comparable to the parallel executor -- maybe 0.5-1s, the cost of cache store lookups.

The complication: the compile-or-not decision per file requires an aggregate cache query -- "are all mutants for this file cached?" -- that the current cache store doesn't support. It would be an addition to the cache protocol, not just the execution flow.

---

## What Remains

The parallel schemata is implemented and correct. The cache is integrated. All 206 tests pass.

The measured speedup was 3% -- not 5x. The bottleneck is the SPM lock on the shared build directory. The designed solution doesn't solve this problem because it assumes concurrency where the system imposes serialization.

This doesn't make the implementation useless. The task group and cache integration are foundation for the next iteration. The direct binary execution hypothesis could unlock the real speedup. But that requires a separate experiment, with metrics, before committing to a new architecture.

The pattern repeats: beautiful numbers on the whiteboard, more complicated reality in execution, more interesting hypotheses than the originals.

That's how tools evolve.

---

_The code is available at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing). The `--fast` flag activates schemata mode._
