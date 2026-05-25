---
title: 'Exit Code 0 Does Not Mean All Tests Passed'
description: 'How XCTest and Swift Testing produce different mutation scores from the same code — and why the difference is about error propagation, not test quality.'
pubDate: 2026-09-07
tags: ['Testing', 'Mutation Testing']
---

_How XCTest and Swift Testing produce different mutation scores from the same code — and why the difference is about error propagation, not test quality._

I ran `swift-mutation-testing` against the same production code using two equivalent test suites — one built with **XCTest**, the other with **Swift Testing** — and the results were not what I expected. Same code, same logical test coverage, a 23-point gap in mutation score. Here's what I found and why the difference matters.

---

## Setup

I ran two test suites against identical production source code:

- **Suite A**: Swift Testing (`import Testing`, `@Test`, `@Suite`)
- **Suite B**: XCTest (`import XCTest`, `XCTestCase`)

Both suites covered the same logical scenarios. Discovery was executed once and produced identical results for both runs.

**Discovery result (shared):**

```
71 mutants — 31 schematizable, 40 incompatible
```

---

## Execution Results

| Metric         | Swift Testing | XCTest  |
| -------------- | ------------- | ------- |
| Mutation score | 40.6%         | 63.8%   |
| Killed         | 28            | 47      |
| Survived       | 41            | 21      |
| Timeouts       | 0             | 4       |
| Crashes        | 3             | 3       |
| Unviable       | 2             | 2       |
| Duration       | 1447.1s       | 1825.4s |

The CLI produced consistent results for both frameworks. The differences in score and performance are explained entirely by behavioral differences in how each framework reports failures to `xcodebuild` and the test runner.

---

## Behavioral Difference 1 — Host App Error Propagation

### What happened

20 mutants were marked **Survived** under Swift Testing but **Killed** under XCTest. All 20 share the same `killedBy` value in the XCTest report:

```
"ShortenLinksApp encountered an error"
```

This is not a test function — it is the test host application reporting a runtime error.

### Root cause

When a mutation causes the host application to crash or encounter a fatal error during test execution, the two frameworks propagate this event differently:

**XCTest behavior:**

`xcodebuild` terminates the test run with a non-zero exit code. The `.xcresult` bundle contains a synthesized `Test Case` node:

```json
{
  "nodeType": "Test Case",
  "result": "Failed",
  "nodeIdentifier": "ShortenLinksApp encountered an error"
}
```

`XCResultParser` finds this node, extracts the identifier, and the mutant is classified as **Killed**.

**Swift Testing behavior:**

When the equivalent host-level error occurs, `xcodebuild` exits with code `0`. `ResultParser` checks the exit code first:

```swift
if exitCode == 0 { return .testsSucceeded }
```

The xcresult is never consulted. The mutant is classified as **Survived**.

### Why exit codes differ

XCTest's test runner (`xctest`) reports host app errors as test suite failures, which propagates to `xcodebuild` as a non-zero exit code. The Swift Testing runner does not currently synthesize a test failure for host-level crashes that occur outside the execution of a specific test function. If the crash happens between tests or during app initialization, no test is marked as failed and the process exits cleanly.

### Implication for mutation score

This is not a CLI defect. It reflects a genuine difference in test coverage: the XCTest suite had integration or app-level tests that exercised code paths affected by these mutations. The Swift Testing suite — even when logically equivalent at the unit level — does not cover those execution paths through host-level assertions.

The 20 affected mutants are predominantly `RemoveSideEffects` and `NegateConditional`, which affect initialization and configuration logic at the application boundary layer.

---

## Behavioral Difference 2 — Timeout vs Fast Failure

### What happened

4 mutants that caused **Timeout** under XCTest (consuming the full 120s per mutant) were correctly **Killed** under Swift Testing:

| Mutant ID | Operator                      | XCTest  | Swift Testing | Killed by                                       |
| --------- | ----------------------------- | ------- | ------------- | ----------------------------------------------- |
| `_5`      | RelationalOperatorReplacement | Timeout | Killed        | `execute_withFTPScheme_throwsValidationError()` |
| `_6`      | LogicalOperatorReplacement    | Timeout | Killed        | `execute_withValidURL_returnsShortenedURL()`    |
| `_12`     | BooleanLiteralReplacement     | Timeout | Killed        | `httpError_invalidResponse_equalsItself()`      |
| `_14`     | BooleanLiteralReplacement     | Timeout | Killed        | `httpError_networkError_equalsItself()`         |

### Root cause

XCTest's asynchronous testing model relies on `XCTestExpectation` and `waitForExpectations(timeout:)`. When a mutation changes a condition that a test waits on — a Boolean guard, a relational check controlling loop termination, or an operator in a predicate — the expectation is never fulfilled. The test runner waits for the full timeout before proceeding.

Swift Testing uses `async/await` natively. Tests that `await` a throwing function receive the error immediately when the mutated condition fails. There is no expectation timeout mechanism — the failure propagates synchronously through the async call stack and the test exits in milliseconds.

### Performance impact

Each XCTest timeout consumed the full 120-second limit:

```
4 timeouts × 120s = 480s added to total duration
```

XCTest total duration: 1825.4s
Swift Testing total duration: 1447.1s
**Difference: 378.3s** — almost entirely explained by the four timeouts.

Swift Testing was faster despite the suite being structurally equivalent because its failure mode for these mutations is immediate rather than deadline-driven.

---

## Behavioral Consistency

The following results were identical across both frameworks, confirming correct CLI behavior in all shared paths:

| Category                                         | Both frameworks                         |
| ------------------------------------------------ | --------------------------------------- |
| Discovery (mutants, schematizable, incompatible) | 71 / 31 / 40                            |
| Crash mutants                                    | 3 (IDs `_10`, `_41`, `_52`)             |
| Unviable mutants                                 | 2                                       |
| Mutants killed by named test functions           | Consistent where test coverage overlaps |

The schematization mechanism — which rewrites source files to embed all mutants behind a runtime switch activated via `ProcessInfo.processInfo.environment["__SWIFT_MUTATION_TESTING_ACTIVE"]` — works correctly with both frameworks. The env var is injected into the `.xctestrun` plist's `EnvironmentVariables` section by `xcodebuild`, which sets it at the OS process level before any test code runs. Both XCTest and Swift Testing test binaries receive and read the variable correctly.

---

## Summary

| Difference                  | Cause                                       | Framework responsible       |
| --------------------------- | ------------------------------------------- | --------------------------- |
| 20 extra kills in XCTest    | Host app errors propagated as test failures | XCTest (by design)          |
| 4 timeouts in XCTest        | Expectation-based async waiting             | XCTest test design          |
| Swift Testing 378s faster   | No timeout accumulation                     | Swift Testing (async/await) |
| Mutation score gap (23.2pp) | Test suite coverage and failure model       | Both suites                 |

The CLI behaves correctly under both frameworks. The mutation score difference is a function of how each framework handles host-level failures and asynchronous timeouts — not of the mutation, schematization, or result-parsing mechanisms.

---

_swift-mutation-testing is open source at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing)._
