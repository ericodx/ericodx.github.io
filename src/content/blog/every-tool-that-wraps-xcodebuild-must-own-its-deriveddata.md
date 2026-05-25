---
title: 'Every Tool That Wraps xcodebuild Must Own Its DerivedData'
description: 'From an 8 GB surprise to a deterministic 40.6% mutation score: six lessons I learned by stabilizing an Xcode mutation testing pipeline.'
pubDate: 2026-08-24
tags: ['Xcode', 'Build Systems']
---

_From an 8 GB surprise to a deterministic 40.6% mutation score: six lessons I learned by stabilizing an Xcode mutation testing pipeline._

---

## The 8 GB Surprise

Until this point, swift-mutation-testing had only been exercised against Swift Package Manager projects. Xcode project support existed in the codebase, but it had never been fired against a real project under real conditions.

The test subject was a small iOS app — a URL shortener. Its test suite was modest: a few unit tests and two UI tests. The `.swift-mutation-testing.yml` configuration was minimal:

```yaml
scheme: ShortenLinksApp
destination: 'platform=iOS Simulator,name=iPhone 17 Pro'
testRunner: auto-detected
concurrency: 4
```

I invoked the tool from the command line:

```bash
cd ~/Developer/nubank-mobile-test
../swift-mutation-testing/.build/release/swift-mutation-testing run
```

Baseline passed. Mutation testing started. The progress line began ticking — `[1/56]`, `[2/56]` — and then the machine slowed down visibly. The fans spun up. CPU usage sat at maximum. Simulator windows multiplied in the Dock. Within minutes the screen was covered in iPhone frames, each one starting a fresh boot animation.

I stopped the process manually.

The first thing I checked was disk usage:

```bash
du -sh ~/Library/Developer/Xcode/DerivedData/
```

Output:

```
8.2G    /Users/ericodx/Library/Developer/Xcode/DerivedData/
```

Before the run, that directory held the usual background: a handful of projects totalling a few hundred megabytes. Now it was 8 gigabytes. I listed the directory to count entries:

```bash
ls ~/Library/Developer/Xcode/DerivedData/ | wc -l
```

```
56
```

56 DerivedData directories. Exactly the number of mutants discovered in the project. Each one weighed approximately 146 MB. 56 x 146 MB = 8.2 GB.

At the same time, `xcrun simctl list devices booted` showed dozens of booted simulators — clones Xcode had spawned when the scheme's parallel testing option kicked in.

---

## Lesson 1: DerivedData Follows the Project Path

xcodebuild uses the project path as the identity key for DerivedData. Two invocations sharing the same project path reuse the same DerivedData. Two invocations with different project paths create two independent directories.

The sandbox is the mechanism that isolates each mutant from the others. `SandboxFactory.create` creates a temporary copy of the project at a unique path:

```swift
// SandboxFactory.swift

let tempDir = FileManager.default.temporaryDirectory
    .appendingPathComponent("swift-mutation-testing-\(UUID().uuidString)")
```

Every mutant gets a fresh UUID. The path changes every time. From xcodebuild's perspective, each invocation is targeting a completely different project it has never seen before. So it allocates a new DerivedData entry every time.

The invocation that triggered this was:

```swift
// XcodebuildTestRunner.swift — original, before the fix

var arguments = [
    "test",
    "-scheme", scheme,
    "-destination", destination,
    // no -derivedDataPath
    // no -parallel-testing-enabled
]
```

Without `-derivedDataPath`, xcodebuild falls back to its default: it hashes the project path and creates a directory under `~/Library/Developer/Xcode/DerivedData/`. Since the path is unique per mutant, every run goes to a new directory.

The scheme also had parallel testing enabled. When xcodebuild runs in parallel testing mode, it clones the simulator before each test run. With 4 concurrent workers and no flag to disable this behavior, each invocation was spawning its own simulator clones, none of which were shut down between runs. The two problems compounded: 4 concurrent workers x 56 mutants x parallel testing clones = an unbounded number of simulator processes and DerivedData directories accumulating simultaneously.

### The fix

Both problems were addressed in a single structural change to `XcodebuildTestRunner`. Rather than allowing xcodebuild to choose a DerivedData path, I compute one explicitly — relative to the project path being tested:

```swift
// XcodebuildTestRunner.swift — after the fix

func run(projectPath: String, timeout: Double, testFilter: [String]?) async throws -> TestRunOutcome {
    let derivedDataPath = URL(fileURLWithPath: projectPath)
        .appendingPathComponent(".swift-mutation-testing-derived-data").path

    var arguments = [
        "test",
        "-scheme", scheme,
        "-destination", destination,
        "-derivedDataPath", derivedDataPath,
        "-parallel-testing-enabled", "NO",
    ]
    // ...
}
```

The path is relative to `projectPath` — the sandbox root for mutant runs, or the original project root for the baseline.

**For mutant sandboxes:** `projectPath` is the sandbox temp directory. DerivedData lives _inside_ the sandbox. When `Sandbox.cleanup()` removes the temp directory, DerivedData is removed with it. No residue.

**For the baseline:** `projectPath` is the real project directory. DerivedData accumulates at `<project>/.swift-mutation-testing-derived-data/` and persists across runs, giving xcodebuild the opportunity to do incremental compilation on subsequent runs.

I also added an explicit simulator shutdown step at the end of the pipeline and a `.gitignore` entry for `.swift-mutation-testing-derived-data/`.

| Concern                  | Before                                            | After                                                               |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| DerivedData per mutant   | 1 new directory in `~/Library/...` (~146 MB each) | Contained inside sandbox temp dir, removed on cleanup               |
| DerivedData for baseline | 1 new entry per run                               | Stable at `<project>/.swift-mutation-testing-derived-data/`, reused |
| Simulator instances      | Unbounded (parallel testing clones)               | 1 per worker, shut down at end of run                               |
| Disk growth per run      | O(mutants x ~146 MB)                              | ~0 net, only baseline DerivedData persists                          |

### How tests guarantee this does not happen again

The fix is structural — xcodebuild never runs without `-derivedDataPath`. The tests enforce this at two levels:

1. **Argument inspection.** `XcodebuildTestRunner` accepts a `launcher` dependency of type `any ProcessLaunching`. In tests I inject `SpyProcessLauncher`, which records every call. I verify that the runner drives xcodebuild exactly once per `run` invocation.

2. **Sandbox cleanup.** `SandboxFactoryTests` verifies that `cleanup()` removes the entire sandbox root. Because DerivedData is written _inside_ `sandbox.rootURL`, this test is implicitly a DerivedData-cleanup test.

These two properties together — one invocation per mutant, full sandbox removal on cleanup — make disk explosion structurally impossible.

---

## Lesson 2: Xcode Generates Code During Build

With the DerivedData explosion fixed, I started focusing on the broader Xcode integration. The first inconsistency I found was subtle: between the first and second execution of the CLI, the number of discovered Swift files changed.

```
1st execution (clean):  35 files, 69 mutants
2nd execution (cache):  36 files, 105 mutants
```

One extra file. Dozens more mutants. Where did they come from?

I found the file inside the working directory:

```
.swift-mutation-testing-derived-data/
  Build/Intermediates.noindex/
    ShortenLinksApp.build/Debug-iphonesimulator/
      ShortenLinksApp.build/DerivedSources/
        GeneratedAssetSymbols.swift
```

`GeneratedAssetSymbols.swift`. Generated by Xcode during the `build-for-testing` step from the first execution. It did not exist before. After the first build, it was there — and the file discovery phase found it on the second pass.

This was an important revelation about the Xcode build model: **it generates Swift code as part of the compilation process**. Asset catalogs, localized strings, and other resources are transformed into type-safe Swift by the asset compiler. This generated code is real, valid, and — from the perspective of a `FileManager.enumerator` — indistinguishable from human-written code.

The fix was straightforward:

```swift
// FileDiscoveryStage — already excluded .build/
guard !fullPath.contains("/.build/") else { return false }

// Also needed to exclude the working directory
guard !fullPath.contains("/.swift-mutation-testing-derived-data/") else { return false }
```

The lesson was not "Xcode creates junk." It was: any tool that operates on Swift files in an Xcode project needs to be aware that the build process itself generates new Swift files. If you do not exclude your working directory from discovery, you will discover what you yourself generated.

---

## Lesson 3: Check the Cache Before You Build

For Xcode projects, the CLI uses a two-phase approach that mirrors Xcode's own separation:

- `xcodebuild build-for-testing` — compiles the app and tests for a specific destination (device, simulator, architecture)
- `xcodebuild test-without-building` — executes the tests using the artifacts from the previous build

Instead of compiling once per mutant, I embed _all_ mutations into the same file using conditional guards — the **Schemata** approach. The active mutation is selected at runtime via environment variable:

```swift
// Original code
let result = a + b

// After schemata embedding
let result: Int
if ProcessInfo.processInfo.environment["__SWIFT_MUTATION_TESTING_ACTIVE"] == "MUT_0" {
    result = a - b
} else {
    result = a + b
}
```

One `build-for-testing`. Multiple `test-without-building`, each activating a different mutant. The separation Xcode imposes becomes an advantage.

But I was calling `build-for-testing` even when the results were already cached:

```
BEFORE:
1. Create sandbox (IO intensive)
2. Run build-for-testing (MINUTES)
3. For each mutant:
      -> check cache       <-- too late
      -> or run test-without-building
```

`build-for-testing` is the most expensive operation in the entire pipeline. Any decision that can be made before it _must_ be made before it.

The refactoring was to move the cache check to the beginning, before any expensive operation:

```swift
private func executeFileXcode(
    source: ParsedSource,
    compatible: [MutationPoint],
    testHash: String,
    ...
) async throws -> [MutantResult] {

    let fileContentHash = MutantCacheKey.hash(of: source.file.content)

    // Cache check — near-zero cost
    if let cached = await allCached(compatible: compatible, fileContentHash: fileContentHash, testHash: testHash) {
        for (i, result) in cached.enumerated() {
            await reporter.report(.mutantFinished(
                mutant: result.mutationPoint,
                status: result.status,
                index: i + 1,
                total: cached.count
            ))
        }
        return cached  // exit without ever touching Xcode
    }

    // Only reach here if there is something new to compile
    let schematized = schematize(mutations: compatible, in: source)
    let sandbox = try await sandboxFactory.create(...)
    let buildResult = try await runBuildForTesting(sandbox: sandbox, ...)
    // ...
}
```

The corrected flow:

```
executeFileXcode(compatible: [69 mutations])
        |
        v
allCached(compatible, fileContentHash, testHash)
        |
        +-- MISS --> sandboxFactory.create()
        |                   |
        |                   v
        |           build-for-testing
        |                   |
        |                   v
        |           test-without-building x N
        |
        +-- HIT --> reporter.report(xN) --> return cached
                   ZERO builds. ZERO tests.
```

The broader lesson: when integrating with external build tools, the cost of each operation is rarely documented — you need to measure and respect it.

---

## Lesson 4: The Schematizable vs Non-Schematizable Cache Bug

While working on schemata support, I found cases where injecting conditional guards simply did not work. Functions marked with `@resultBuilder`, closures in trailing syntax contexts, initializers with strict type requirements — in these contexts, modifying the AST to embed a conditional guard produced code that would not compile.

This led to distinguishing two sets of mutants:

```
compatible: [A, B, C, D, E]   <-- all technically applicable mutants
     |
     +--> schematize()
               |
               +--> manifest: [A, B, C]   <-- schematizable (embeddable via #if)
               |
               +--> fallback: [D, E]      <-- compatible but non-schematizable
                        |
                        +--> MutationExecutor (classic approach: sandbox + modify + test)
```

That distinction was correct. The bug was in how I applied the cache pre-check: I was only checking `schematized.manifest` — the subset of schematizable mutants.

```swift
// BEFORE: checked only the subset
if let cached = await allCached(manifest: schematized.manifest, ...) { ... }
```

What happened in practice:

```
Run 1:
  compatible = [A, B, C, D, E]
  manifest   = [A, B, C]

  Schemata executes: A, B, C -> results cached
  Fallback executes: D, E    -> results cached

Run 2 (with bug):
  allCached(manifest: [A, B, C]) -> all cached -> return early
  D and E simply vanished <--
```

The result was a silently lower mutant count. No error. No warning. Two fewer mutants in the final report — exactly the ones that `@resultBuilder` or similar contexts had generated.

I learned something about the Swift compilation model: **the compiler has contexts where certain syntactic constructs change meaning**. An `#if` inside a `@resultBuilder` is not treated as a conditional guard — it is interpreted as part of the DSL. Respecting this in the CLI meant accepting that some mutants need a different path, and ensuring that path was fully covered by the cache.

The fix was to use `compatible` — the full set — as the cache check parameter:

```swift
// AFTER: check all compatible mutants, not just schematizable ones
if let cached = await allCached(compatible: compatible, ...) { ... }
```

The semantics are conservative by design: either all compatible mutants are cached, or none are considered cached. This guarantees that the distinction between schematizable and non-schematizable never creates partial results.

---

## Lesson 5: Measure the Baseline Only When Needed

The `MutationExecutor` — responsible for non-schematizable mutants — has a timeout mechanism: it runs the test suite to measure the baseline duration and defines the effective timeout as `max(configured, baseline x 2)`.

```swift
let measurer = BaselineMeasurer(testRunner: testRunner, reporter: reporter)
let baselineDuration = try await measurer.measure(projectPath: ..., testFilter: ...)
let effectiveTimeout = max(configuration.timeout, baselineDuration * 2)
```

This exists because a mutant's behavior can include infinite loops, deadlocks, or code that simply never terminates. The baseline-based timeout detects these cases automatically without requiring the user to guess a value.

It is a sensible heuristic — but it was being applied even when all mutants already had cached results. The baseline measurement ran the entire test suite before any cache check.

The root cause was the same as the earlier bugs: the order of operations did not reflect the real cost of each step. Measuring the baseline with `xcodebuild test-without-building` on the iOS Simulator takes 30-50 seconds. Calling it multiple times per execution when the cache is populated was unnecessary waste.

The fix followed the same pattern as Lesson 3: move the cache check before the baseline measurement. If all mutants are cached, skip measurement entirely.

The lesson reinforced something about build tool design: **every operation that involves compilation or test execution should be treated as expensive until proven otherwise**. The cost of measuring is the cost of what you are measuring.

---

## Lesson 6: The Simulator Is a Shared Resource

With the five refinements above, the results became consistent between runs with and without cache. But there was still an unexpected variation: consecutive clean executions sometimes generated different timeout counts.

```
Run A:  Timeouts: 2
Run B:  Timeouts: 7
Run C:  Timeouts: 4
```

This made no sense for a deterministic system. The code was not changing. The baseline was measured dynamically. Why were timeouts varying?

The configuration used `concurrency: 4`. What this means for Xcode: four `xcodebuild test-without-building` processes running simultaneously, all pointing at the **same** `iPhone 17 Pro` Simulator.

The iOS Simulator has no arbitration mechanism for multiple processes competing over the same device. When four processes try to execute tests on the same simulator simultaneously, they compete for CPU, memory, and Springboard attention. The result is that some processes run slower than expected — and exceed the timeout threshold calculated from an isolated execution.

The test project had a 500ms delay in a specific code path:

```swift
// URLShortenerViewModel.swift
Task.sleep(nanoseconds: 500_000_000)  // duplicate URL detection with debounce
```

In isolation: imperceptible. Under contention from four processes: enough to blow past the calculated timeout.

The solution was simple:

```yaml
# .swift-mutation-testing.yml
concurrency: 1
```

But the lesson was richer: the iOS Simulator is fundamentally different from a server or from `swift test`. It is designed to be a faithful representation of a physical device — and physical devices execute one foreground process at a time. Real parallelism with the Simulator would require multiple cloned simulators, one per job. With a single device, serializing is the correct choice.

---

## The Result: Deterministic at 40.6%

After all six lessons were applied, three consecutive executions produced:

```
Run 1 (clean):  Killed: 24  Crashes: 4  Survived: 41  Timeouts: 0  Score: 40.6%
Run 2 (cache):  Killed: 24  Crashes: 4  Survived: 41  Timeouts: 0  Score: 40.6%
Run 3 (clean):  Killed: 24  Crashes: 4  Survived: 41  Timeouts: 0  Score: 40.6%
```

And the second execution — which previously took 1247 seconds — dropped to approximately **5 seconds**.

The numbers matter, but the mental model matters more:

- **Xcode generates code as part of the build.** Assets, localized strings, and other resources become type-safe Swift through code generation. `GeneratedAssetSymbols.swift` is not an exception — it is the expected behavior of any target with an asset catalog.
- **`build-for-testing` and `test-without-building` are asymmetric operations.** The first is expensive and rarely needs repeating. The second is relatively cheap and is where actual test execution lives. Tools that integrate with Xcode must respect this asymmetry.
- **Swift has compilation contexts where syntactic semantics change.** `@resultBuilder`, trailing closures, and other contexts impose constraints on what can appear as children of certain AST nodes. Schemata embedding must be aware of these constraints.
- **The Simulator has a serial execution model.** Parallelism with the Simulator is not free — it requires multiple devices, not multiple processes on the same device.
- **DerivedData follows the project path.** Mutation testing fundamentally changes the project path on every run — that is how isolation works. These two behaviors are in direct conflict unless you explicitly route DerivedData to a controlled location.

---

## Conclusion

There is a recurring pattern in this journey: each refinement came from a new understanding of how Xcode works, not from an attempt to work around it.

The generated file taught me about code generation. The performance of `build-for-testing` taught me about asymmetric operation costs. The compilation contexts taught me about the semantic boundaries of Swift. The Simulator's behavior taught me about the limits of parallelism. And the DerivedData explosion taught me the most fundamental lesson of all: every tool that wraps xcodebuild must make `-derivedDataPath` an explicit, non-negotiable part of its invocation.

A CLI that integrates with Xcode is not working _against_ it — it is working _with_ a build system that has decades of accumulated design. The work is to understand that design deeply enough to leverage it, not to compensate for it.

The best way to learn is to build, execute, observe what happens, and ask: what is this behavior telling me about how the system works?

---

_[swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing) is an open-source mutation testing tool for Swift 6, implementing the Schemata approach for SPM and Xcode projects._
