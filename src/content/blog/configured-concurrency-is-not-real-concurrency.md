---
title: 'Configured Concurrency Is Not Real Concurrency'
description: 'From discovering that parallel tasks were secretly queued to diagnosing four layers of non-determinism in Xcode simulator execution — and the architectural...'
pubDate: 2026-11-02
tags: ['Concurrency', 'Xcode', 'Testing']
---

_From discovering that parallel tasks were secretly queued to diagnosing four layers of non-determinism in Xcode simulator execution — and the architectural redesign that made mutation testing results reproducible._

---

There are bugs that hide behind correct results. These are the worst kind. Not because they cause obvious failures, but because the absence of failure convinces you that everything is fine — while the system silently wastes resources, performs unnecessary work, and ignores the concurrency you believed you had implemented.

This is the story of how I built a mutation testing executor for Xcode projects, how it passed every test, produced validated results, and was still fundamentally broken inside.

---

## What Mutation Testing Is and Why It Is Slow by Nature

Mutation testing is a technique for measuring the quality of a test suite. The idea is simple: take the source code, introduce a small, intentional change — a mutant — and check if any test fails. If the tests detect the change, the mutant was _killed_. If no test notices, the mutant _survived_, indicating a gap in test coverage.

The problem is that each mutant must be tested in isolation. With fifty mutants in a project, you need to run the test suite fifty times — once for each variation of the code. For Xcode projects, where each build cycle can take 30 seconds to several minutes, the cost becomes prohibitive quickly.

The classic solution is called **Schemata**: instead of creating a binary per mutant, you embed all mutants in the same binary using a switch controlled by an environment variable. Compile once, test N times.

```swift
switch __swiftMutationTestingID {
case "swift-mutation-testing_0":
    // mutant: == became !=
    let result = a != b
    return result
case "swift-mutation-testing_1":
    // mutant: + became -
    let result = a - b
    return result
default:
    // original code
    let result = a + b
    return result
}
```

With schematized code, the flow became:

1. Generate a schematized file with all mutants for that file
2. Create an isolated copy of the project (sandbox) with the modified file
3. `xcodebuild build-for-testing` — compile once
4. For each mutant: `xcodebuild test-without-building` with the environment variable activating the specific mutant
5. Parse the result and move on

The results matched expectations. Tests passed. The code shipped.

And then the question came: _why is this still so slow?_

---

## The Investigation

With concurrency configured for 4 parallel workers and 40 mutants, I expected the total time to be roughly `build_time + (40/4) * test_time`. Instead, the measured time was nearly identical to sequential execution: `build_time + 40 * test_time`.

Concurrency was configured correctly. The `withThrowingTaskGroup` was there. Tasks were launched in parallel. And yet the time did not decrease.

I opened the Xcode executor code and read carefully:

```swift
private func runSchemataMutationsXcode(
    manifest: [(mutantID: String, mutationPoint: MutationPoint)],
    context: XcodeTestRunContext,
    ...
) async throws -> [MutantResult] {

    try await withThrowingTaskGroup(of: MutantResult.self) { group in
        while activeTasks < concurrency, let (mutantID, mutationPoint) = iterator.next() {
            group.addTask {
                try await self.runAndReportXcode(
                    mutantID: mutantID,
                    mutationPoint: mutationPoint,
                    context: context,  // same context for all tasks
                    ...
                )
            }
        }
    }
}
```

Nothing wrong at first glance. Until you look inside `runAndReportXcode` and reach `launchXcodeTestRun`:

```swift
let (exitCode, output) = try await launcher.launchCapturing(
    executableURL: xcodebuildURL,
    arguments: [
        "test-without-building",
        "-xctestrun", activatedURL.path,
        "-destination", context.destination,  // same value in all tasks
        ...
    ],
    ...
)
```

`context.destination` was identical for every concurrent task. Every `test-without-building` call was pointing at **the same simulator**.

---

## The Simulator That Does Not Share Attention

An iOS simulator is a process. A process that runs one test runner at a time. When you try to install and run tests on a simulator that is already running tests, xcodebuild does not fail — it waits. It queues the request internally and executes when the simulator becomes available.

What looked like concurrency was actually a serial queue disguised as a task group. I launched 4 workers in parallel. All 4 arrived at the simulator simultaneously. xcodebuild serialized the access. One ran while three waited. The next ran while two waited. And so on, sequentially, with zero parallelism gain.

The system was correct in its results because serialization ensured each mutant ran in isolation. But all the concurrency work was being silently undone by xcodebuild itself.

**The concurrency configured in `configuration.concurrency` was completely ineffective for Xcode.**

---

## SimulatorPool: Actual Parallel Execution

The solution is what I called the **SimulatorPool**: before starting tests, clone the base simulator N times — where N is the desired concurrency level. Each worker gets an exclusive simulator. When it finishes, it returns the simulator to the pool.

```swift
actor SimulatorPool {
    func setUp() async throws
    // xcrun simctl clone <baseUDID> "XMR-Worker-N" x N
    // xcrun simctl boot <cloneUDID> x N (in parallel)

    func acquire() async -> SimulatorSlot  // suspends if none available
    func release(_ slot: SimulatorSlot) async
    func tearDown() async  // shutdown + delete all clones
}
```

With this, each `test-without-building` points at a different simulator. Real concurrency. No implicit queue.

---

## The XCBBuildService Problem

With the simulator problem solved, the next question arose: what about builds? The current flow built a sandbox and ran `build-for-testing` for each source file separately. With 10 source files, 10 builds. Sequential.

The natural idea was to parallelize: process multiple files simultaneously, each with its own sandbox. I implemented it, tested it — and then investigated the actual behavior of xcodebuild before confirming the approach.

I found two problems that completely invalidated the parallel approach.

**Problem 1: The XCBBuildService daemon.** Since Xcode 9, all invocations of `xcodebuild` communicate with a persistent daemon called `XCBBuildService`. This daemon manages the build graph for each project. When two `xcodebuild` processes request builds of the same `.xcodeproj` simultaneously, the daemon receives both requests — and may serialize the builds for the same target and configuration internally, regardless of whether you specified different `-derivedDataPath` values.

**Problem 2: The symlink that wrote back.** The `SandboxFactory` created a symlink to the `.xcodeproj` directory inside each sandbox. The idea made sense: the project is large, symlinks are fast, and the `.xcodeproj` would not be modified. Except that xcodebuild _does_ modify the `.xcodeproj` during the build — it writes to `xcuserdata/` and `xcshareddata/` inside the project directory. With a symlink pointing to the original, those writes went directly to the real project on disk. With two parallel builds, two simultaneous writes to the same directory — a concrete race condition, not theoretical.

---

## Unified Build

If I could not parallelize the builds, the answer was to perform **a single build** for everything.

Instead of schematizing each file separately and compiling one by one, I schematized all files with mutants at once, created a single sandbox with all of them, and ran `build-for-testing` once for the entire project. The `.xctestrun` produced embeds all variations from all files. After that, the simulator pool executes all mutants in parallel — with no additional builds.

The gain is not just performance. It is architectural correctness: a single build, no contention on the xcbuild daemon, no race conditions on disk.

This approach did create one new problem: the `SchemataGenerator` prefixed each schematized file with a global variable declaration:

```swift
nonisolated(unsafe) let __swiftMutationTestingID: String? =
    ProcessInfo.processInfo.environment["__SWIFT_MUTATION_TESTING_ACTIVE"]
```

When each file was compiled in isolation, this worked. But with all schematized files in a single build within the same Swift module, each file declared the same global variable — a compilation error from redeclaration. The fix was to extract that declaration into a dedicated support file, `__SMTSupport.swift`, injected once into the sandbox.

---

## Four Layers of Non-Determinism

With the SimulatorPool in place and the unified build working, I ran validation passes. And the results fluctuated between runs.

The investigation revealed not one, but four overlapping causes of instability. Each layer interacts with the others, creating a system where the result of one execution depends on the history of previous executions.

### The Numbers

Test project: Xcode, 71 mutants (31 schematizable, 40 incompatible). Identical discovery across all versions. No cache.

**Swift Testing -- Three Consecutive Runs (v1.0.0)**

| Run | Score     | Killed | Survived | Unviable | Duration  |
| --- | --------- | ------ | -------- | -------- | --------- |
| 1   | 65.2%     | 45     | 24       | 2        | 1872s     |
| 2   | 65.2%     | 45     | 24       | 2        | 1820s     |
| 3   | **40.6%** | **28** | **41**   | 2        | **1367s** |

The third run lost **17 kills** and was 27% faster — less effective work.

**Dev Post-Fix -- Three Consecutive Runs**

| Run | Score     | Killed | Survived | Unviable | Duration  |
| --- | --------- | ------ | -------- | -------- | --------- |
| 1   | 41.3%     | 26     | 37       | 8        | 1333s     |
| 2   | **69.4%** | **43** | 19       | 9        | **1812s** |
| 3   | 37.7%     | 23     | 38       | 10       | 1355s     |

Variation of **31.7 percentage points** — worse than before the fix. The pattern shifted from monotonic degradation to **random fluctuation** (41 -> 69 -> 37).

The strongest correlation in both patterns is **duration vs. score**. Fast runs (~1333-1367s) consistently produce low scores. Slow runs (~1812-1872s) produce high scores. Tests that finish too quickly are not executing correctly.

### Layer 1: Simulator Contamination (Intra-Execution)

The SimulatorPool manages N cloned simulators for parallel execution. The flow for each mutant is:

```
1. pool.acquire(slot)
2. xcodebuild test-without-building -destination slot.destination
3. process terminates -> terminationHandler
4. pool.release(slot)
```

In v1.0.0, `xcodebuild` terminates but its child processes (test runners, helpers) remain connected to the simulator. When the slot is reused, the next `xcodebuild` finds processes from the previous execution still active.

Let `S_i` be the simulator state in slot `i` before executing mutant `m_k`. Ideally:

`S_i(m_k) = S_0  for all k`

Where `S_0` is the clean initial state. But without child process cleanup:

`S_i(m_k) = S_0 + sum(R_0..R_{k-1})`

Where `R_j` is the residue from mutant `j`'s execution in that slot. The residue is stochastic — it depends on which child processes survive and for how long:

`R_j ~ Bernoulli(p_escape)`

If `p_escape` is the probability of a child process surviving the parent's termination, the probability of contamination after `n` executions in the same slot is:

`P(contaminated) = 1 - (1 - p_escape)^n`

For `p_escape = 0.1` and `n = 10` executions per slot: `P ~ 0.65`.

The `kill(-pid, SIGKILL)` in the terminationHandler resets `R_j = 0`, eliminating this layer.

### Layer 2: xcresult Truncation (Kill Timing)

The `xcodebuild` produces an **xcresult bundle** — a file on disk with detailed test results. The `ResultParser` uses `xcresulttool` to read this bundle.

The problem: the process that **finalizes** the xcresult bundle may be a child of `xcodebuild`. When the kill occurs in the terminationHandler, it kills the child before it finishes writing the bundle.

Let `T_write` be the time needed to finalize the xcresult after the parent terminates, and `T_kill` the delay between parent termination and kill execution:

`Result = correct if T_kill > T_write, truncated if T_kill < T_write`

In the terminationHandler, `T_kill ~ 0` — the kill is immediate. But `T_write` varies with bundle size and system load:

`T_write ~ Uniform(50ms, 500ms)`

Since `T_kill << T_write`, truncation is nearly certain. The key is **how each framework reports failures**:

|                   | Primary failure channel            | Timing relative to kill                   |
| ----------------- | ---------------------------------- | ----------------------------------------- |
| **XCTest**        | xcresult bundle (written by child) | After parent terminates -> **vulnerable** |
| **Swift Testing** | stdout (written by parent)         | Before kill -> **immune**                 |

For XCTest: `P(correct classification after kill) ~ 0`

For Swift Testing: `P(correct classification) ~ 1` (result depends only on stdout)

### Layer 3: Simulator Leaks (Inter-Execution)

The most subtle discovery. `SimulatorPool.tearDown()` — which shuts down and deletes cloned simulators — was called only on the success path:

```swift
let pool = try await makePool(launcher: launcher)
try await pool.setUp()

// ... multiple try await that can throw ...

await pool.tearDown()  // never executed if any throw above
```

If any step fails (build, test, sandbox), the simulators become orphans. Each failed execution accumulates simulators on the system. Degradation with `N` active simulators affects `simctl` response time and resource usage:

`T_test(N_sim) = T_test_base * (1 + alpha * N_sim)`

When `T_test` exceeds the configured timeout, mutants that would be killed get classified as timeout or crash. This explains the v1.0.0 pattern: **two stable runs (65.2%) followed by abrupt degradation (40.6%)**. The third run inherits orphaned simulators from partial failures in previous runs, crossing a degradation threshold.

### Layer 4: XCTest Parallel Interference

After fixing layers 1-3, Swift Testing became perfectly stable. XCTest did not.

Diagnostic by concurrency level:

| Concurrency | Run 1                 | Run 2                 | Variation  |
| ----------- | --------------------- | --------------------- | ---------- |
| 1           | 40.6% (28K/41S) 1785s | 40.6% (28K/41S) 1809s | **0pp**    |
| 2           | 56.5% (39K/30S) 1894s | 40.6% (28K/41S) 1533s | **15.9pp** |

With concurrency=1: **perfectly stable**. With concurrency=2: **already unstable**.

Unlike layers 1-3 (which involve sequential accumulation), layer 4 is **simultaneous interference** between simulators running XCTest in parallel. The stable result (concurrency=1, 40.6%) is the **true score**. The 56.5% with 2 simulators had 11 false kills — tests that failed due to inter-simulator interference, not mutation detection.

`FPR_parallel = K_interference / K_observed = 11 / 39 = 28.2%`

Swift Testing is resilient to this interference — it works correctly at any parallelism level.

### How the Layers Amplify Each Other

The four layers are not independent — they form feedback loops:

```
Simulator leaks (Layer 3)
  -> degraded system
    -> slower tests
      -> more timeouts and crashes
        -> more executor errors
          -> more orphaned simulators (feedback loop)
            -> contamination more likely (Layer 1)
              -> incorrect results

Aggressive kill (fix for Layer 1)
  -> truncates xcresult (Layer 2)
    -> killed mutants -> survived/unviable
      -> incorrect score
```

---

## Mutant-by-Mutant Analysis

Comparing the JSON reports revealed that the nature of the changes differed from expectations.

**XCTest v1.0.0 -> Dev: No Killed -> Survived transitions**

| Transition           | Count  |
| -------------------- | ------ |
| Killed -> Crash      | 4      |
| Killed -> Unviable   | 5      |
| Survived -> Crash    | 3      |
| Survived -> Unviable | 2      |
| **Total changes**    | **14** |

Zero mutants went from Killed to Survived. The regression came **entirely** from mutants that were executable and now crash or are unviable.

**Swift Testing v1.0.0 -> Dev: Artificial kill gains**

| Transition           | Count  |
| -------------------- | ------ |
| Survived -> Killed   | 15     |
| Killed -> Crash      | 9      |
| Killed -> Unviable   | 4      |
| Survived -> Unviable | 3      |
| **Total changes**    | **32** |

The 15 new kills all came from `"ShortenLinksApp encountered an error"` — the app crashes on load and the framework classifies it as killed. These are not tests detecting mutations; they are initialization crashes of mutated SwiftUI views.

**False negative rate** (mutants classified as survived when they should be killed):

For XCTest-dev: `FNR >= 9 / 25 = 36%`

For Testing v1.0.0 degraded: `FNR = 17 / 45 = 37.8%`

In both cases, more than a third of real kills were lost to infrastructure problems.

---

## The Fixes

### Fix 1: Launcher Separation (Layers 1 + 2)

The initial approach of `launchCapturingDeferred` — an API where the caller controls when to call `cleanup()` — did not work. Despite appearing correct in theory, results remained inconsistent (31.7pp variation). The abstraction tried to serve two masters with a single parameterized implementation.

The definitive solution was to **separate launchers by platform**:

**`XcodeProcessLauncher`** — v1.0.0 behavior, no kill in terminationHandler:

```swift
process.terminationHandler = { terminated in
    timeoutTask.cancel()
    capture.fileHandle.closeFile()
    let output = (try? String(contentsOf: capture.tempURL, encoding: .utf8)) ?? ""
    try? FileManager.default.removeItem(at: capture.tempURL)
    continuation.resume(returning: (exitCode: exitCode, output: output))
}
```

The `xcodebuild` children terminate naturally after writing the xcresult. The `ResultParser` reads the complete bundle.

**`SPMProcessLauncher`** — aggressive child kill + escaped process sweep:

```swift
process.terminationHandler = { terminated in
    timeoutTask.cancel()
    kill(-terminated.processIdentifier, SIGKILL)
    killEscapedChildren(sandboxPath: sandboxPath)
    capture.fileHandle.closeFile()
    let output = (try? String(contentsOf: capture.tempURL, encoding: .utf8)) ?? ""
    try? FileManager.default.removeItem(at: capture.tempURL)
    continuation.resume(returning: (exitCode: exitCode, output: output))
}
```

Selection happens at the composition root:

```swift
let executionLauncher: any ProcessLaunching = switch configuration.build.projectType {
    case .xcode: XcodeProcessLauncher()
    case .spm: SPMProcessLauncher()
}
```

### Fix 2: Guaranteed tearDown (Layer 3)

`pool.tearDown()` is now called on both the success and error paths:

```swift
let results: [ExecutionResult]
do {
    results = try await runAllMutants(...)
} catch {
    await pool.tearDown()   // guarantees cleanup on error
    try? sandbox.cleanup()
    throw error
}

await pool.tearDown()       // cleanup on success
try? sandbox.cleanup()
```

This eliminates orphaned simulator accumulation between executions, breaking the degradation feedback loop.

### Fix 3: XCTest Concurrency Constraint (Layer 4)

The tool now supports a `testingFramework` option (CLI: `--testing-framework`, config: `testingFramework:`):

```yaml
testingFramework: xctest # or swift-testing (default)
```

When `testingFramework: xctest` and the project is Xcode, concurrency is forced to 1 by the `ConfigurationResolver`, regardless of the configured value. The `init` command auto-detects the framework by analyzing imports in test files (`import XCTest` vs `import Testing`).

---

## Validation: Deterministic Results

### Xcode + Swift Testing -- Consistency Restored

| Run | Score | Killed | Survived | Duration |
| --- | ----- | ------ | -------- | -------- |
| 1   | 40.6% | 28     | 41       | 1397.3s  |
| 2   | 40.6% | 28     | 41       | 1397.8s  |
| 3   | 40.6% | 28     | 41       | 1401.7s  |

Variation: **0 percentage points**. Duration variation: ~4s. Performance gain of ~24% over v1.0.0 (average 1399s vs 1850s).

### Xcode + XCTest -- Stabilized at Concurrency 1

| Concurrency | Run 1                 | Run 2                 | Variation |
| ----------- | --------------------- | --------------------- | --------- |
| 1           | 40.6% (28K/41S) 1785s | 40.6% (28K/41S) 1809s | **0pp**   |

Variation: **0 percentage points**. The true mutation score is 40.6%, free of infrastructure noise.

---

## The Final Architecture

The redesigned Xcode executor:

1. Schematize all files at once, with a shared support file for the global variable
2. A single `build-for-testing` for the entire project
3. SimulatorPool with N clones for N genuinely parallel workers
4. `test-without-building` with stdout-first parsing, xcresulttool only when needed
5. Platform-specific process launchers: `XcodeProcessLauncher` (no child kill) and `SPMProcessLauncher` (aggressive cleanup)
6. Guaranteed `tearDown` on both success and error paths
7. Auto-detected `testingFramework` constraining XCTest to concurrency 1

---

## Conclusion

Every problem in this investigation followed the same pattern: a reasonable assumption that proved incorrect when confronted with the actual behavior of the system.

Launching tasks in parallel does not mean they execute in parallel — not when the shared resource serializes access. Different `-derivedDataPath` values do not fully isolate two parallel builds — not when the xcbuild daemon and symlinks create write paths to the original project. A process killed immediately after termination does not leave a clean state — not when its children are still writing results to disk.

None of these problems appear in unit tests because unit tests use mocks. Mocks have no xcbuild daemon, no real simulators, no macOS filesystem behavior. They respond as expected — and that is exactly where false positives hide.

In systems that execute thousands of processes in sequence — mutation testing, CI pipelines, test farms — resource leaks are correctness bugs, not performance bugs. Each unreleased resource is a bit of entropy injected into future results. And process cleanup semantics cannot be generalized — different platforms demand different strategies.

Sometimes the most important work is not adding code. It is discovering why the code you already have is wasting the work you thought it was doing.

---

_swift-mutation-testing is open source at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing)._
