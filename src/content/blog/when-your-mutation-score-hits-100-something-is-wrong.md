---
title: 'When Your Mutation Score Hits 100%, Something Is Wrong'
description: 'From a parser bug to a six-state taxonomy: the design decisions that turn raw test output into an honest mutation score.'
pubDate: 2026-09-21
tags: ['Mutation Testing', 'Testing']
---

_From a parser bug to a six-state taxonomy: the design decisions that turn raw test output into an honest mutation score._

---

You know that feeling when you run your test suite and get a glorious "100% coverage"? In the world of mutation testing, seeing "100% Mutants Killed" should be the equivalent of beating the game. But when it happens on your first attempt? Well, any self-respecting software engineer's instincts fire immediately: _something is very wrong here_.

That is exactly what happened while I was refining [swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing), a tool built in Swift to measure how effective your test suites really are by injecting deliberate faults --- mutants --- into your codebase.

The premise was simple: if a mutant survives your tests, your suite has holes. If the tests fail, the mutant is "killed," and your suite is robust.

But when I ran the CLI for the first time against a real project, the terminal stared back at me with:

```
Killed: 100% / Survived: 0
```

"My code is not that perfect," I thought. And that is when the hunt began.

---

## The First Suspect: The Blind Parser

Digging through the project's architecture, my eyes quickly turned to the `TestOutputParser`.

When `swift test` runs and a test fails natively, XCTest produces a well-formatted string: `"Test Case 'test_name' failed"`. But what happens when the mutant injection generates an error that is not an assertion failure? What if the mutation (say, changing a `+` to `-`) breaks the syntax and the code does not even compile? Or if an `Array` accesses an out-of-bounds index and triggers a `Fatal error` from the operating system?

In those cases, the `swift test` process returned a non-zero exit code without the classic XCTest pattern. What did my parser do?

It shrugged and said: _"Well, it failed for an unknown reason. Therefore... Killed!"_

As a consequence, **every compilation error or silent crash was being reported as a resounding success of the test suite.**

---

## The First Fix (Or So I Thought)

"Simple!" I thought. "Anything that falls outside the pattern or fails to build should be classified as a syntax error."

I modified the `TestOutputParser` to apply a fallback: if the process failed without the clean XCTest output, I would classify it as `.compileError`.

Confident, I ran the CLI against the target project again. The result changed drastically:

```
Killed: 0 / Survived: 2 / CompileErrors: 1042 / Timeouts: 0
```

_Wait. 1,042 compile errors? And ZERO killed?_

Then a brilliant question surfaced: _"The fact that the build did not execute does not mean the mutant was successfully killed, since it is impossible to test the condition."_

And suddenly, I realized that my "fix" had swung from one extreme to the other, masking an even more interesting scenario.

---

## When a Crash Is Actually a Trophy

Strongly typed languages like Swift are not as forgiving as JavaScript or Ruby. If you swap an arithmetic operator for a logical one between two integers in Swift, the code **does not compile**. Period.

I had been treating compile errors as irrelevant failures. But what about mutants that passed the build phase, ran the test suite, broke the entire runtime, and caused a `Segfault` or `Fatal error`?

My previous implementation categorized those runtime crashes as compile errors. But think about it: if the mutant compiled, entered execution, and the application died during the tests... **the test failed! The mutant was effectively annihilated!** That is not a compiler deficiency --- it is proof that the fatal injection worked.

The real heroes ("killed") were being buried under a pile of false compile errors.

---

## The Razor's Edge

I rebuilt the strategy in the `TestOutputParser`. Instead of assuming the result, I started listening to the log's pulse.

I searched for the magic words: `"Test Suite started"`, `"Test run started"`.

If I saw that string in the console, I would know one thing with absolute certainty: **the mutant compiled**. From that point on, any unmapped error, `Fatal error`, or abrupt termination would earn the well-deserved red crown of `.failed(killedBy: "crash")`.

If the start string was not in the terminal output, then --- and only then --- I would accept the compiler's fatal verdict that the syntax was, in fact, invalid.

---

## Does the Compiler Count? The Philosophy Behind the Score

With the numbers stabilized, another philosophical question arose. Since Swift's powerful compiler blocks the bizarre majority of mutants (generating legitimate compile errors), should those kills count toward inflating the final mutation score?

The logic is seductive: "The compiler broke the mutant, so the system protected me."

I went to analyze what the academic literature and industry frameworks (PITest for Java, Stryker.NET for C#) defend in their guidelines. And there was the answer: the **mutation score does not measure the strength of the language. It measures the strength of your assertions.**

If I counted compile errors as successes in the final score, a developer who wrote _no tests at all_ would score 90% just because the language blocked the garbage at compile time. The metric would not guarantee quality; it would breed apathy.

So I decided to keep compiler-caused deaths **excluded from the score entirely**. They indicate mutants that were "stillborn" --- without utility for the report.

---

## A Final Touch Inspired by Rust

While researching, I noticed how `cargo-mutants` handles this in the **Rust** ecosystem --- one of the most feared (and loved) languages for its static checkers. In Rust, they reject the superficial term "compile error." Instead, they brilliantly call those mutants **unviable**.

Without a second thought, I rewrote the vocabulary. I took a search tool and replaced every trace of `CompileError` in the codebase with `Unviable`. Clean, expressive, semantic, and precise.

That naming decision would prove foundational. It was not just a label change --- it was a design statement about what the tool can and cannot tell you about your tests.

---

## The Six States of a Mutant

The detective story above forced me to think carefully about every possible outcome of running tests against mutated code. A binary killed/survived model could not capture the reality. The result was a six-state taxonomy, each state with a clear role in the score formula.

Every mutation passes through a `TestRunner`, which executes the test suite with the modified code and returns a `TestRunOutcome`:

```swift
enum TestRunOutcome: Sendable, Equatable {
    case passed
    case failed(killedBy: String)
    case crashed
    case unviable
    case timedOut
}
```

The `MutationExecutor` then maps that outcome to a `MutantStatus` --- the domain vocabulary:

```swift
enum MutantStatus: Sendable, Equatable {
    case killed(by: String)
    case killedByCrash
    case survived
    case unviable
    case timeout
    case noCoverage
}
```

Two distinct enums with distinct purposes. `TestRunOutcome` is the runner's vocabulary --- what the process observed. `MutantStatus` is the domain's vocabulary --- what the mutation means for test quality.

Here is each state, why it exists, and how it affects the score.

---

### 1. killed(by:) --- The Ideal Case

The test suite failed, and I can identify which test detected the mutation.

This is the result you want to see. It means at least one test in your suite noticed the behavior changed --- and broke.

The `killedBy` field carries the test name. This matters for two reasons. **Traceability:** in the final report, you know exactly which test covers that line. If a mutant is caught by a single test, that is valuable information --- that test is doing important work. **Caching:** the `MutantCacheKey` uses the state of test files for invalidation. Carrying the killer test's name lets me verify whether a cached result is still valid.

```swift
case .failed(let killedBy):
    return .killed(by: killedBy)
```

---

### 2. killedByCrash --- Death by Collapse

The process terminated abnormally --- with a signal, trap, or non-zero exit code without a recognizable failure message --- before completing all tests.

A mutation can introduce corruption that the compiler does not catch but the runtime does not forgive. An out-of-bounds array access with a modified index. A division by zero that was previously impossible. A force unwrap on something that can now be nil.

The decision: **a crash is a kill.** The mutation produced detectable behavior different from the original. The goal of mutation testing is to verify whether your tests can distinguish correct code from modified code. A crash is the most dramatic distinction possible --- the entire program stopped.

```swift
case .crashed:
    return .killedByCrash
```

---

### 3. survived --- The Mutant That Escaped

The test suite passed with the mutated code. No test detected the change.

This is the result you do not want to see --- and the most informative when it appears. A surviving mutant means one of three things:

1. **Coverage gap.** No test executes that line with values that exercise the modified logic.
2. **Tests passing for the wrong reason.** The tests verify something, but not the behavior the mutation perturbed.
3. **Equivalent mutant.** The modified code has the same observable behavior as the original in that context.

The third case --- equivalent mutants --- is the hardest problem in mutation testing. There is no general algorithmic solution. The tool cannot know whether `a > b` and `a >= b` are semantically equivalent in your business context. It can only report that the mutant survived.

```swift
case .passed:
    return .survived
```

---

### 4. unviable --- The Mutant That Never Was

The mutated code does not compile, or the process terminated for a reason that is neither a test failure nor a crash. This is the design decision the detective story above led me to.

Mutations create syntactic transformations that are valid in the original context but can produce invalid code when applied. `RemoveSideEffects` might remove a declaration that other lines depend on. `SwapTernary` might invert branches with incompatible types.

An unviable mutant says nothing about your test suite. It says the mutation produced syntactically incoherent code at that point. Counting it as killed would artificially inflate the score. Counting it as survived would penalize the score for reasons outside the developer's control. So it is **excluded entirely** --- absent from both numerator and denominator.

```swift
case .unviable:
    return .unviable
```

---

### 5. timeout --- The Mutant That Never Finishes

The test process did not complete within the maximum allowed time (default: `max(timeout, baselineDuration * 2)`).

A mutation can introduce an infinite loop, transform a termination condition into one that is never satisfied, or create reentrance that deadlocks a serial queue.

The tool measures the suite's execution time without mutations (the baseline) and uses `max(configured_timeout, baseline * 2)` as the limit. This avoids false timeouts on slow machines --- if your suite normally takes 8 seconds, the limit will be 16, not a fixed 60.

**Timeout enters the denominator but not the numerator.** A timeout is ambiguous. The mutant may have created an infinite loop --- which would be detectable and semantically interesting. But the tool cannot confirm this with certainty. Counting it as a kill would be too optimistic; counting it as survived would be too pessimistic. The decision was to treat it as "inconclusive."

```swift
case .timedOut:
    return .timeout
```

---

### 6. noCoverage --- The Ghost Mutant

No source file corresponds to the path recorded in the mutation point.

This is the rarest and most technical case. The `MutantDiscoveryStage` generates `MutationPoint`s with file references. If a file was moved, deleted, or if there was inconsistency between the discovery phase and the execution phase, the mutation point targets a path that no longer exists.

```swift
guard let source = sourcesByPath[mutant.filePath] else {
    return MutantResult(mutationPoint: mutant, status: .noCoverage, testDuration: 0)
}
```

**noCoverage enters the denominator.** The mutant was identified and a valid mutation point exists, but it could not be executed. This penalizes the score honestly --- there is code the tool could not test.

---

## The Complete Map

```
TestRunOutcome          ->   MutantStatus        ->   Score role
--------------------------------------------------------------
passed                  ->   survived            ->   denominator only
failed(killedBy:)       ->   killed(by:)         ->   numerator + denominator
crashed                 ->   killedByCrash       ->   numerator + denominator
unviable                ->   unviable            ->   excluded
timedOut                ->   timeout             ->   denominator only
(source not found)      ->   noCoverage          ->   denominator only
```

---

## The Score Formula

```
score = (killed + crashes) / (killed + crashes + survived + timeouts + noCoverage) * 100
```

```swift
var score: Double {
    let numerator = killed.count + crashes.count
    let denominator = numerator + survived.count + timeouts.count + noCoverage.count
    return Double(numerator) / Double(denominator) * 100
}
```

Breaking it down by intent:

- **Numerator:** mutants that produced detectable evidence of different behavior. Your tests (or the runtime, via crash) noticed the change.
- **Denominator:** all mutants that were or should have been tested. This is the honest count of "things the tool tried to evaluate."
- **Excluded (`unviable`):** artifacts of the tool, not information about your tests. A stillborn mutant that the compiler rejected tells you nothing about whether your assertions are strong enough.

A score of 100% does not mean your code is perfect. It means that for every syntactic transformation the tool generated, your tests produced a signal --- a failure or a crash. It is the best available proxy for "your tests can distinguish correct code from incorrect code."

But if you see 100% on your first run, do what I did: suspect the parser before you celebrate.

---

## Why Granularity Matters More Than the Number

The temptation in any quality tool is to collapse everything into a single number. "You have X% coverage" or "You have Y% mutation score."

But the real value is in the granularity. A report showing 12 surviving mutants in `PaymentProcessor.swift` and 3 timeouts in `NetworkRetry.swift` is more useful than a number saying 84%.

The six states were designed to preserve that information without artificially inflating the score with results the tool cannot interpret with confidence.

The central rule was simple: **only count as killed what your tests actually detected.** Crashes count because behavior changed in an observable way. Unviable does not count because it is the tool, not the tests, that detected the problem. Timeout does not count as a kill because I cannot be certain what happened.

It is a conservative taxonomy by design --- and conservative is, here, the right choice.

At the end of this intense journey --- from the infamous "100% false kills" to the final surgery of the unviable status --- the log now smiles back with perfect honesty:

```
Killed: 1 / Survived: 1 / Unviable: 1042 / Timeouts: 0 / NoCoverage: 0
```

When your mutation testing shows you 100%, be suspicious. And after you fix the parsers, celebrate.

---

_swift-mutation-testing is open source at [github.com/ericodx/swift-mutation-testing](https://github.com/ericodx/swift-mutation-testing)._
