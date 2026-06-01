---
title: 'Invalidate Only What Changed'
description: 'How granular per-file test hashing and killer-test-aware cache invalidation turned mutation testing from a nightly batch job into an interactive tool.'
pubDate: 2026-10-19
tags: ['Mutation Testing', 'Performance']
---

_How granular per-file test hashing and killer-test-aware cache invalidation turned mutation testing from a nightly batch job into an interactive tool._

Every time I ran my mutation testing tool on a codebase where only two files had changed, it re-tested everything. Hundreds of mutants, most of them identical to the last run. The results were cached, but the cache key was too coarse — any test change invalidated every cached result.

Mutation testing is slow by nature. The tool introduces hundreds of small code changes, builds the project, runs the test suite against each one, and checks whether the tests catch the difference. Even with schematization — embedding all mutations in a single build behind a runtime switch — a full run on a mid-size project can take several minutes.

That's fine for the first run. The problem is what happens on the second.

---

## How the cache works today

`swift-mutation-testing` caches every result. After a run, each mutant's outcome (killed, survived, timed out, unviable, no coverage) is written to `.swift-mutation-testing-cache/results.json`. On the next run, mutants whose cache entry is still valid skip the build and test cycle entirely.

A cache entry is keyed by six values:

- **Source file content hash** — SHA256 of the file containing the mutation
- **Test files hash** — SHA256 of all test files concatenated
- **Mutation position** — byte offset in the source file
- **Original token** — the code before mutation (e.g. `>=`)
- **Mutated token** — the code after mutation (e.g. `>`)
- **Operator identifier** — which mutation operator generated this mutant

If any of these values change, the cache entry is considered stale and the mutant is re-executed.

The first five make intuitive sense. If the source file changed, the mutation might land on different code. If the position shifted, it's a different mutation. If the tokens changed, it's a different operator. All of these invalidate at the individual mutant level — only the affected entries are discarded.

The sixth value is the problem.

---

## The monolithic test hash

The test files hash is computed once per run. The tool collects every `.swift` file in every test directory, reads their contents, sorts by path, concatenates everything into a single string, and hashes it.

One hash. All test files. All test content. One SHA256.

This means that if you change a single assertion in a single test file, the hash changes. And because the hash is part of every cache key, every cache entry becomes stale. Every mutant is re-executed from scratch.

Change one test → re-run everything.

In a project with 200 mutants and a 5-minute run, fixing a single test to kill a survived mutant costs you another 5 minutes. The cache, which was supposed to save time, saves nothing.

---

## When the cache actually helps

The cache works well in one specific scenario: you change source code but not tests.

If you refactor a function, the source file hash changes for mutants in that file. Those mutants are re-executed. But mutants in other files still have valid cache entries — their source hash hasn't changed and the test hash hasn't changed either. The second run only processes the mutants in files you touched.

This is the happy path. In practice, the most common reason to re-run mutation testing is the opposite: you changed tests, not source code. You looked at the survived mutants report, wrote or strengthened a test, and want to verify that the mutation is now caught. That's the workflow the cache should accelerate — and it's exactly the one it doesn't.

---

## The real-world impact

Consider a typical workflow:

1. Run `swift-mutation-testing` on a module. 200 mutants, 160 killed, 30 survived, 10 with no coverage. Takes 5 minutes.
2. Open the report. Pick a survived mutant. Write a test to kill it.
3. Run again. The tool recomputes the test hash, finds it changed, discards the entire cache. 200 mutants re-executed. Another 5 minutes.
4. Check the report. The mutant is killed. Pick another survivor. Write another test.
5. Run again. Full 5 minutes.

Each iteration costs the full run time. Over a session of improving test coverage, you might run the tool 5-10 times. That's 25-50 minutes of execution where the vast majority of mutants haven't changed and don't need re-testing.

---

## What I know but don't use

Here's the thing: the tool already knows which test killed each mutant.

When a mutant is killed, the result parser extracts the name of the failing test. For XCTest, it's something like `ValidatorTests.testAgeCheck`. For Swift Testing, it's the test function name. This information is stored in the cache as part of the `killed(by:)` status.

So the cache entry for a killed mutant says: "this mutant was killed by `ValidatorTests.testAgeCheck`." If that specific test hasn't changed, the result is still valid. There's no reason to re-run it.

The tool has the data. It just doesn't use it for invalidation.

---

## The opportunity

Not all cached results need the same treatment when tests change.

A **killed** mutant was caught by a specific test. If that test hasn't changed, the kill is still valid. Only if the killing test was modified or deleted does the result need re-validation.

A **survived** mutant was missed by every test. If any test changed — especially if a new test was added — the mutant might now be caught. These need re-execution whenever the test suite changes.

An **unviable** mutant didn't compile. Tests are irrelevant. The result is always valid as long as the source file hasn't changed.

A **no coverage** mutant was never exercised. Like survived, any test change might bring it under coverage.

In a healthy project with an 80% kill rate, the vast majority of mutants fall in the "killed" category. If you change one test file that was responsible for killing 12 mutants, only those 12 kills need re-validation — plus the 30 survived and 10 no-coverage mutants that might now be caught. That's 52 mutants instead of 200. The other 148 killed mutants, whose killing tests are untouched, stay cached.

On a project with a 5-minute full run, that's roughly a 74% reduction in re-execution time. The feedback loop between "write a test" and "verify it kills the mutant" drops from minutes to seconds.

---

## The workflow I want

1. Run `swift-mutation-testing`. Full run, 5 minutes. Cache populated.
2. Write a test targeting a survived mutant.
3. Run again. The tool detects that one test file changed. It re-runs the ~50 affected mutants — the ones killed by tests in that file, plus all survived and no-coverage mutants. Takes under a minute.
4. Check the result. The mutant is killed. Pick another survivor.
5. Run again. Same fast cycle.

The mutation score updates correctly because the tool re-validates everything that could have changed and trusts only what it can prove hasn't.

This is the difference between mutation testing as a batch process you run once and walk away from, and mutation testing as an interactive tool you use while writing tests. The data to make this work is already in the cache. The question is how to use it.

---

## How I implemented it

The implementation landed in five phases, each independently shippable and testable.

### Phase 1 — Per-file test hashing

The monolithic `testFilesHash` was replaced by a `[String: String]` map — relative path to SHA256 hash — computed by `TestFilesHasher.hashPerFile(projectPath:)`. The tool now knows the hash of each individual test file.

A new `TestFileDiff` struct captures the delta between runs:

```swift
struct TestFileDiff: Sendable {
    let added: Set<String>
    let modified: Set<String>
    let removed: Set<String>
    var hasChanges: Bool { !added.isEmpty || !modified.isEmpty || !removed.isEmpty }
}
```

The diff is computed by `CacheStore.changedTestFiles(current:)`, which compares the stored `CacheMetadata` (persisted alongside the cache entries) against the current hashes. Added files appear only in current, removed files only in stored, modified files appear in both with different hashes.

### Phase 2 — Killer test resolution

When a mutant is killed, the result parser already extracts the failing test name. I added a `KillerTestFileResolver` that maps that name back to a file path:

1. **XCTest format** (`ClassName.testMethod`) → search for `ClassName.swift` in test paths
2. **Swift Testing format** (`testName`) → search for `func testName` or `@Test.*testName` in test file contents
3. **Fallback** → `nil` (conservatively invalidated on any test change)

The resolved file path is stored alongside the cache entry in `killerTestFile: String?`. This is the data that enables granular invalidation.

### Phase 3 — Granular invalidation

The `testFilesHash` field was removed from `MutantCacheKey`. The key now identifies a mutant purely by source content:

```swift
struct MutantCacheKey: Hashable, Sendable, Codable {
    let fileContentHash: String      // SHA256 of the source file
    let operatorIdentifier: String   // which mutation operator
    let utf8Offset: Int              // byte position in the file
    let originalText: String         // code before mutation
    let mutatedText: String          // code after mutation
}
```

Test-related invalidation is handled separately by `CacheStore.invalidate(diff:)`, which runs before any cache lookups:

| Cached status   | Invalidation rule                                                 |
| --------------- | ----------------------------------------------------------------- |
| `killed(by: X)` | Remove only if the file containing test X was modified or deleted |
| `killedByCrash` | Never invalidate (test-independent)                               |
| `survived`      | Remove on any test change                                         |
| `noCoverage`    | Remove on any test change                                         |
| `timeout`       | Remove on any test change                                         |
| `unviable`      | Never invalidate (build failure, test-independent)                |

This is the core of the optimization. In a project with 80% kill rate, the majority of mutants are killed — and most of those kills are by tests that didn't change. Only the small subset affected by the modified test file needs re-execution.

### Phase 4 — Edge cases

Several scenarios required careful handling:

- **Deleted test file:** killed entries pointing to it are invalidated; survived/timeout/noCoverage are invalidated (file set changed)
- **Added test file:** survived/timeout/noCoverage are invalidated (new test might catch them); killed entries are untouched
- **Renamed test file:** old path removed, new path added — killed entries pointing to old path are invalidated
- **Unknown killer (`nil`):** conservatively invalidated on any test change
- **Old cache format migration:** entries without `killerTestFile` are treated as `nil` and conservatively invalidated on first run

### Phase 5 — Fast path restoration

The `allCached` fast path was updated to work with the new key format. After `invalidate(diff:)` runs, remaining entries are all valid. If every mutant's key is still in the cache, the build and test cycle is skipped entirely — results are returned directly from cache.

The orchestration in `MutantExecutor.execute()` follows this sequence:

```
1. Load cache from disk
2. Compute per-file test hashes
3. Compute TestFileDiff (added/modified/removed)
4. Invalidate stale entries
5. Check allCached fast path → skip build if 100% hit
6. Run build + test for non-cached mutants
7. Persist cache + metadata
```

---

## Measured results

Real-world numbers from the `swift-mutation-testing` project itself (1041 mutants):

| Run                     | Killed | Survived | Timeouts | Unviable | Duration    | Cache         |
| ----------------------- | ------ | -------- | -------- | -------- | ----------- | ------------- |
| 1 (cold)                | 856    | 91       | 15       | 79       | **93m 58s** | —             |
| 2 (warm, tests changed) | 870    | 76       | 12       | 83       | **19m 44s** | 79% reduction |
| 3 (warm, tests changed) | 874    | 72       | 10       | 85       | **16m 34s** | 82% reduction |

Run 1 is a cold start — no cache, full execution. Run 2 happens after adding tests to kill survived mutants. With the old monolithic hash, this would be another 94-minute full run. With granular invalidation, it takes under 20 minutes — the tool re-executes only the mutants whose killing test changed, plus all survived/timeout mutants that might now be caught.

Run 3 continues the same pattern. More tests added, more survivors killed, but most of the 874 killed mutants are served from cache because their killing tests are untouched.

The unviable count grows slightly across runs (79 → 83 → 85) because `unviable` is a permanent cache status — once a mutant fails to compile, that result is never invalidated. Some mutants that were previously classified as `timeout` get reclassified as `unviable` upon re-execution when the build itself fails to produce test output. This is correct behavior: the total mutant count (1041) remains constant across all runs.

### Time savings breakdown

| Metric                             | Value                             |
| ---------------------------------- | --------------------------------- |
| Full run (cold cache)              | 93m 58s                           |
| Second run (granular cache)        | 19m 44s                           |
| Third run (granular cache)         | 16m 34s                           |
| Cumulative time saved (3 runs)     | ~151 minutes vs ~282 minutes      |
| Average cache hit rate (warm runs) | ~80% of mutants served from cache |

In a typical test-writing session with 5-10 iterations, granular cache invalidation reduces total mutation testing time from hours to minutes. The feedback loop between "write a test" and "verify it kills the mutant" drops from a full re-run to a partial execution focused on the mutants that actually need re-testing.

---

## What this means in practice

The cache is no longer an all-or-nothing optimization. It works in the scenario that matters most: iterating on tests.

Before: change one test → re-run 1041 mutants → wait 94 minutes.

After: change one test → re-run ~200 mutants → wait 17 minutes.

The tool tracks which test killed each mutant, hashes test files individually, and invalidates only what needs invalidation. Killed mutants whose killing test is unchanged stay cached. Survived and timeout mutants are always re-tested when tests change. Unviable mutants are never re-tested.

This turns mutation testing from a nightly batch job into an interactive development tool. You write a test, run the tool, see the result, iterate. The cache makes each iteration fast enough to stay in flow.

---

_swift-mutation-testing is open source at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing)._
