---
title: 'The Best Error Handling Is Not Generating the Error'
description: 'From timeouts and retries to filters and separation — two cases where preventing the problem replaced handling it'
pubDate: 2026-12-21
tags: ['Error Handling']
---

_From timeouts and retries to filters and separation — two cases where preventing the problem replaced handling it_

---

## The Principle

The best way to handle a problem is to make it impossible to occur.

This sounds obvious in the abstract, but in practice I kept catching myself writing increasingly sophisticated error handling for problems that should never have existed. Two cases from building a Swift mutation testing tool made this pattern concrete for me: infinite loops caused by mutations, and inconsistent test results caused by a shared process launcher. In both cases, I had working mitigations — timeouts, retries, deferred cleanup — and in both cases, the real fix was to prevent the problem at its source.

---

## Case 1: When `i + 1` Becomes `i - 1`

### The Symptom

During mutation testing runs on Swift Package Manager projects, Activity Monitor showed systematic CPU spikes — the `swiftpm-testing-helper` process hitting **499.7% CPU** (5 saturated cores). The pattern was consistent: intense spikes followed by drops when the timeout finally killed the process.

The `swiftpm-testing-helper` is the process that `swift test` spawns to run tests. When the code under test enters an infinite loop, the helper stays trapped executing that loop until the parent process expires by timeout. With hundreds of mutants running in sequence, each one that causes an infinite loop wastes the full timeout duration at maximum CPU.

### The First Mitigation: Reduce the Timeout

I reduced the default timeout for SPM projects from 120s to 30s. SPM projects are typically libraries with fast unit tests — a test taking more than 30s is almost certainly stuck in an infinite loop.

```
Before: mutant with infinite loop -> 120s at 100% CPU -> timeout -> next mutant
After:  mutant with infinite loop -> 30s at 100% CPU  -> timeout -> next mutant
```

This cut the impact per mutant by 75%, but didn't eliminate the problem. With 20 mutants causing loops, that's still 10 minutes of wasted CPU. The natural question: **can I identify these mutants before running them?**

### Which Mutations Cause Infinite Loops?

The tool has 7 mutation operators. Not all of them are dangerous in all contexts. What matters is the **combination of operator and loop context**.

**Pattern 1 — Progress Inversion (ArithmeticOperatorReplacement):**

```swift
var i = 0
while i < items.count {
    handle(items[i])
    i = i + 1    // mutation: i = i - 1
}
```

When `+` becomes `-`, the counter diverges toward negative infinity. The loop never terminates. This is the most common and most predictable pattern.

**Pattern 2 — Progress Removal (RemoveSideEffects):**

```swift
while !queue.isEmpty {
    queue.removeFirst()    // mutation: (removed)
}
```

When `queue.removeFirst()` is removed, the queue never drains. The condition stays true forever. The removed function looks like a dispensable side effect, but it's actually the loop's **termination mechanism**.

**Pattern 3 — Always-True Condition (RelationalOperatorReplacement):**

```swift
var i = 0
while i < 10 {    // mutation: i != 10
    i += 2
}
```

When `<` becomes `!=`, the loop depends on `i` hitting exactly 10. With increment 2, `i` goes 8 -> 10 — it works. With increment 3, `i` goes 9 -> 12, skipping 10 — infinite loop. This pattern is less predictable because it depends on runtime values.

### Risk Classification by Operator

| Risk         | Operator                      | Rationale                                                                          |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------- |
| **CRITICAL** | ArithmeticOperatorReplacement | Counter inversion almost certainly causes infinite loop                            |
| **HIGH**     | RemoveSideEffects             | Removes the loop's termination mechanism                                           |
| **MEDIUM**   | RelationalOperatorReplacement | Depends on runtime values; most condition mutations prevent loop entry             |
| **LOW**      | NegateConditional             | In while conditions, usually prevents entry; in internal guards, may prevent break |
| **NONE**     | SwapTernary                   | Does not affect loop control flow                                                  |

### The Crucial Distinction: Condition vs Body

For while loops, mutations in the **condition** and in the **body** have opposite risk profiles:

- **Condition**: `while i < 10` -> `while !(i < 10)` — the negated condition is false when `i = 0`, the loop **never executes**. Most condition mutations _reduce_ iterations.
- **Body**: `i = i + 1` -> `i = i - 1` — progress is inverted, the loop **never terminates**. Body mutations that affect control variables typically _increase_ iterations to infinity.

Also worth noting: `for-in` loops in Swift iterate over a finite sequence. No matter what the body does, the loop runs exactly `collection.count` times. Mutations inside `for-in` bodies cannot cause infinite loops because termination is guaranteed by the loop structure, not the body.

### The Solution: InfiniteLoopFilter

I evaluated and discarded data-flow analysis — tracking which variables control loop termination and filtering only mutations that affect those variables. In a language with mutability, closures, and references, that's computationally expensive and prone to false negatives. For a filter that runs during the discovery phase (which must be fast), the cost doesn't justify itself.

Instead, I adopted a **positional filter by operator** that operates on two simple axes:

1. **Position**: is the mutation inside the body of a `while` or `repeat-while`?
2. **Operator**: is it ArithmeticOperatorReplacement or RemoveSideEffects?

If both conditions are true, the mutation is filtered out.

The implementation follows the existing pattern. The tool already had a `SuppressionFilter` that removes mutations inside scopes marked with `@SwiftMutationTestingDisabled`. The new filter plugs into the same pipeline:

```
Discovery Pipeline:
  operators.mutations(in:) -> SuppressionFilter -> InfiniteLoopFilter -> output
```

An `InfiniteLoopBodyVisitor` walks the AST and collects the byte ranges of while and repeat-while **bodies** (ignoring conditions and for-in loops):

```swift
final class InfiniteLoopBodyVisitor: SyntaxVisitor {
    private(set) var loopBodyRanges: [Range<AbsolutePosition>] = []

    override func visit(_ node: WhileStmtSyntax) -> SyntaxVisitorContinueKind {
        loopBodyRanges.append(node.body.position ..< node.body.endPosition)
        return .visitChildren  // captures nested loops
    }

    override func visit(_ node: RepeatStmtSyntax) -> SyntaxVisitorContinueKind {
        loopBodyRanges.append(node.body.position ..< node.body.endPosition)
        return .visitChildren
    }
}
```

The `InfiniteLoopFilter` then checks each mutation point against these ranges, but only for the risky operators:

```swift
struct InfiniteLoopFilter: Sendable {
    private static let riskyOperators: Set<String> = [
        "ArithmeticOperatorReplacement",
        "RemoveSideEffects",
    ]

    func filter(
        _ mutationPoints: [MutationPoint],
        loopBodyRanges: [Range<AbsolutePosition>]
    ) -> [MutationPoint] {
        guard !loopBodyRanges.isEmpty else { return mutationPoints }

        return mutationPoints.filter { point in
            guard Self.riskyOperators.contains(point.operatorIdentifier)
            else { return true }
            let position = AbsolutePosition(utf8Offset: point.utf8Offset)
            return !loopBodyRanges.contains { $0.contains(position) }
        }
    }
}
```

### The Trade-off

This filter accepts false positives: it will filter `let result = a + b` inside a while loop even if that expression doesn't affect the loop. These are mutations that won't be tested. The impact on mutation score is proportional to the amount of arithmetic code inside while loops — typically a small fraction of total mutations.

It also accepts false negatives: `RelationalOperatorReplacement` in conditions that widen the range, or `NegateConditional` on internal guards that contain `break`. The timeout remains as a safety net for these cases.

The key insight: **an imperfect filter is preferable to no filter, as long as the safety net exists for what escapes it.**

| Scenario                               | Without filter    | With filter                   |
| -------------------------------------- | ----------------- | ----------------------------- |
| `i + 1` -> `i - 1` in while            | 30s CPU + timeout | Not executed                  |
| `queue.removeFirst()` removed in while | 30s CPU + timeout | Not executed                  |
| `a + b` -> `a - b` in while (harmless) | Runs normally     | Not executed (false positive) |
| `<` -> `!=` in while condition         | May loop (30s)    | Runs (accepted risk)          |

---

## Case 2: When One Launcher Serves Two Masters

### The Symptom

Mutation testing depends on a simple premise: given the same code, the same tests, and the same project, the result should be the same. A mutant is killed or survived — it shouldn't depend on luck.

That premise was violated. The same binary, run three consecutive times against the same Xcode project with Swift Testing, produced:

| Run | Score | Killed | Survived | Duration |
| --- | ----- | ------ | -------- | -------- |
| 1   | 41.3% | 26     | 37       | 1333s    |
| 2   | 69.4% | 43     | 19       | 1812s    |
| 3   | 37.7% | 23     | 38       | 1355s    |

A variation of **31.7 percentage points**. Run 2 detected almost twice as many mutants as Run 3. Same project, same hardware, same configuration, consecutive runs.

The correlation was consistent across all scenarios: **short duration -> low score**. Runs around 1333-1367s produced scores of 37-41%. Runs around 1812-1872s produced scores of 65-69%. Tests that finish quickly without detecting mutations are tests that didn't execute correctly.

### The Root Cause: One Launcher, Two Semantics

The tool uses a `ProcessLauncher` — the component responsible for running external processes (`xcodebuild`, `swift test`) and managing their lifecycle. When I added SPM support, the launcher needed a change: kill child processes (`kill(-pid, SIGKILL)`) in the termination handler. Without this, `swiftpm-testing-helper` processes escaped the process group and saturated the CPU.

The problem: that same kill produces **opposite effects** depending on the platform:

**For SPM — the kill is necessary.** SPM reports test failures via stdout. The output is written by the parent process before terminating. When the termination handler fires, the output is already captured. Killing children doesn't affect the result.

**For Xcode — the kill is destructive.** XCTest reports failures via xcresult bundles — files written by child processes of `xcodebuild`. The kill terminates those children before they finish writing, truncating the bundle. The `ResultParser` finds no failure records and classifies the mutant as survived.

```
xcodebuild terminates
  -> child finalizing xcresult bundle...
     -> kill(-pid, SIGKILL) kills the child
        -> xcresult truncated
           -> ResultParser finds no failures
              -> mutant killed -> survived (incorrect)
```

I tried a compromise: `launchCapturingDeferred` — a new API where the termination handler doesn't kill children. The kill was encapsulated in a `cleanup()` closure that the caller invokes at the right time. In theory, this preserves both benefits. In practice, results continued to vary by 31.7 percentage points. The compromise didn't work.

### Why the Compromise Failed

The `launchCapturingDeferred` tried to serve two masters with a single parameterized implementation. But the semantics are fundamentally different:

| Aspect                    | Xcode                   | SPM                              |
| ------------------------- | ----------------------- | -------------------------------- |
| When to kill children     | After reading xcresult  | Immediately                      |
| Who depends on cleanup    | ResultParser (xcresult) | Nobody (stdout already captured) |
| Consequence of early kill | Incorrect result        | None                             |
| Consequence of late kill  | Simulator contamination | Accumulated processes            |
| Result artifact           | xcresult bundle (disk)  | stdout (memory)                  |

These are two distinct process lifecycles. Trying to unify them in a generic API introduces accidental complexity — the caller needs to know when to call `cleanup()`, and the correct timing depends on which platform is running. The abstraction doesn't hide complexity; it distributes it.

### The Solution: Separate Launchers

Instead of one generic launcher with parameterized behavior, I created two launchers with explicit semantics. The `ProcessLaunching` protocol already exists as the abstraction. The separation happens at the implementation level:

```swift
let launcher: any ProcessLaunching = switch configuration.build.projectType {
    case .xcode: XcodeProcessLauncher()
    case .spm: SPMProcessLauncher()
}

let executor = MutantExecutor(configuration: configuration, launcher: launcher)
```

The `XcodeProcessLauncher` captures output and resumes without killing children — the original stable behavior. The `SPMProcessLauncher` kills children immediately via `kill(-pid, SIGKILL)`, because stdout is already captured and there's no xcresult to protect.

The `MutantExecutor`, `TestExecutionStage`, and `IncompatibleMutantExecutor` don't know which launcher they're using. They depend on the `ProcessLaunching` abstraction, not the implementation. This is textbook Dependency Inversion — and it aligns with every SOLID principle:

- **Single Responsibility**: each launcher manages processes for one platform
- **Open/Closed**: new platforms are supported by adding implementations, not modifying existing ones
- **Liskov Substitution**: both launchers are interchangeable through the protocol
- **Interface Segregation**: the protocol exposes only `launch()` and `launchCapturing()` — no platform-specific methods like `launchCapturingDeferred()`

The protocol itself becomes cleaner:

```swift
protocol ProcessLaunching: Sendable {
    func launch(
        executableURL: URL, arguments: [String],
        workingDirectoryURL: URL, timeout: Double
    ) async throws -> Int32

    func launchCapturing(
        executableURL: URL, arguments: [String],
        environment: [String: String]?, additionalEnvironment: [String: String],
        workingDirectoryURL: URL, timeout: Double
    ) async throws -> (exitCode: Int32, output: String)
}
```

Two methods. No cleanup closures. No deferred state.

### Validation

Three consecutive runs with the separated launchers (Xcode + Swift Testing):

| Run | Score | Killed | Survived | Duration |
| --- | ----- | ------ | -------- | -------- |
| 1   | 40.6% | 28     | 41       | 1397.3s  |
| 2   | 40.6% | 28     | 41       | 1397.8s  |
| 3   | 40.6% | 28     | 41       | 1401.7s  |

Variation: **0 percentage points**. Duration variation: ~4 seconds. A ~24% performance improvement over v1.0.0 (average 1399s vs 1850s). The numbers match the first result from v1.0.0 exactly (40.6%, 28K/41S), confirming that the `XcodeProcessLauncher` faithfully reproduces the original behavior.

---

## The Connecting Principle

In both cases, the error was being _handled_ when it should have been _prevented_:

| Problem                                   | Handling (before)                                 | Prevention (after)                                        |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| Infinite loops from mutations             | Timeout kills the process after 30s of wasted CPU | InfiniteLoopFilter removes the mutation at discovery time |
| Inconsistent results from shared launcher | Deferred cleanup, retries, timing workarounds     | Separate launchers with correct semantics per platform    |

The handling approach worked — tests did eventually complete, results were eventually produced. But "working" isn't the same as "correct." The timeout caught the infinite loop, but at a cost of 30 seconds of saturated CPU per mutant. The deferred cleanup preserved some xcresult bundles, but results still varied by 31.7 percentage points between runs.

Prevention eliminates the cost entirely. The InfiniteLoopFilter adds one AST walk during discovery — negligible compared to the seconds of CPU it saves per filtered mutant. The launcher separation removes code (the `launchCapturingDeferred` API, the `cleanup()` closure, the `CapturedOutput` type) rather than adding it.

There's a pattern here worth naming: **when you find yourself building increasingly sophisticated error handling for the same category of problem, step back and ask whether the problem can be made structurally impossible.** Not every problem can be prevented — but the ones that can are worth the investment, because prevention scales in a way that handling never does.

---

## Conclusion

The best error handling is the one you never need to write. A filter that prevents infinite loop mutations from being generated costs less than a single timeout that catches one. A clean separation between platform-specific process launchers produces more reliable results than any amount of timing-sensitive cleanup logic.

Both solutions share a deeper trait: they move the defense upstream. Instead of reacting to problems during test execution (where the cost is high and the feedback loop is long), they prevent problems during discovery or composition (where the cost is near zero and the design is explicit).

The timeout still exists. The process management still handles edge cases. But they're safety nets now, not primary mechanisms. And that's exactly what they should be.

---

Source code: [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing)
