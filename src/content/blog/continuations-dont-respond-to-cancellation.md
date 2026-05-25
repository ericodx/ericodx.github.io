---
title: "Continuations Don't Respond to Cancellation"
description: 'How a glance at Activity Monitor revealed that withCheckedThrowingContinuation ignores task cancellation — and why external resources always need...'
pubDate: 2026-08-17
tags: ['Concurrency', 'Swift']
---

_How a glance at Activity Monitor revealed that `withCheckedThrowingContinuation` ignores task cancellation — and why external resources always need `withTaskCancellationHandler`._

---

## The Observation

It wasn't a crash. It wasn't a failing test. It was a window open in the background.

During a benchmarking session for `swift-mutation-testing` — the mutation testing tool for Swift 6 that I'm building — Activity Monitor was open next to the terminal. The tool was running 70 mutants in parallel with 15 concurrent workers. Expected behavior: see `swift` processes appear, do their work, disappear.

What happened: the processes appeared. They did their work. The tool finished — report in the terminal, prompt back, everything normal. The `swift` processes remained.

Not a few. Many. Consuming CPU. With no tool asking them to run.

I had to kill them manually.

When the user of a tool needs to open Activity Monitor to perform cleanup after each run, there's a bug. The question was: where.

---

## The First Suspect: Something Obvious Being Overlooked

The first hypothesis was simple: somewhere in the code, a process was being started and never terminated. A lost reference. A missing `defer`. An error path without cleanup.

The search showed that wasn't it. The cleanup code existed. `terminationHandler` fires when the child process dies. `timeoutTask.cancel()` is called right after. Everything looked correct in theory.

But there was something different between "correct in theory" and "correct under Swift Concurrency."

---

## How `ProcessLauncher` Worked

The implementation used `withCheckedThrowingContinuation` to convert Foundation.Process's callback-based API into `async/await`:

```swift
func launchCapturing(...) async throws -> (exitCode: Int32, output: String) {
    return try await withCheckedThrowingContinuation { continuation in
        let process = Process()
        // configure process...

        let timeoutTask = Task {
            try await Task.sleep(for: .seconds(timeout))
            process.terminate()
        }

        process.terminationHandler = { terminated in
            timeoutTask.cancel()
            // read output, clean up temporary file
            continuation.resume(returning: (...))
        }

        try process.run()
    }
}
```

The logic is: the process runs, when it finishes the `terminationHandler` fires, the continuation resumes, the function returns. If it takes too long, the `timeoutTask` sends SIGTERM.

Seems reasonable. The problem isn't in the logic — it's in the contract.

---

## The Contract that `withCheckedThrowingContinuation` Doesn't Have

`withCheckedThrowingContinuation` creates a suspension point where the task waits until `continuation.resume` is called. What it **doesn't do** is respond to cancellation.

In Swift Concurrency, when a task is cancelled — whether by `task.cancel()`, or by the automatic propagation from a `withThrowingTaskGroup` when one of its members throws an error — the task receives a cooperative signal. Functions like `Task.sleep` check this signal and throw `CancellationError`. This is the cooperative model working as expected.

`withCheckedThrowingContinuation` does not check this signal. A task suspended inside it remains suspended indefinitely until `resume` is called manually. If nobody calls `resume` — because the code that would do so depends on the `terminationHandler`, which depends on the process finishing, and the process is still running — the task gets stuck. And the process keeps running.

The concrete scenario:

1. The `withThrowingTaskGroup` in `MutationExecutor` is running 15 tasks in parallel
2. One task throws an error (any error — timeout, IO, compilation failed)
3. The task group propagates cancellation to the remaining 14 tasks
4. Those tasks are suspended in `withCheckedThrowingContinuation`, waiting for `terminationHandler`
5. `terminationHandler` never fires because the `swift test` processes are still running
6. The tasks get stuck; the processes keep consuming CPU

When the tool terminates (because the main task completed or because the user pressed Ctrl+C), the direct child processes may receive SIGHUP — but their children (compilers, runners) may not. And even the direct process, depending on how SPM manages its children internally, may not clean everything up.

---

## The Second Problem: `timeoutTask` Was an Unstructured Task

There was a second problem, more subtle.

```swift
let timeoutTask = Task {
    try await Task.sleep(for: .seconds(timeout))
    process.terminate()
}
```

`Task { }` creates an **unstructured task**. Unstructured tasks do not participate in the parent task's cancellation hierarchy. When the parent task is cancelled, the `timeoutTask` continues to exist, waiting for its sleep of `timeout` seconds.

This means that even in the scenario where the tool "finishes" — report displayed, process terminated — in-flight unstructured tasks maintained references to processes that, in turn, could still have open handles, active threads, file descriptors.

The behavior observed in Activity Monitor made sense: the tool would finish, but `swift` processes would remain for seconds or minutes until the timeout fired — or until the user intervened.

---

## The Fix: `withTaskCancellationHandler`

The solution exists for exactly this pattern: `withTaskCancellationHandler`.

```swift
func launchCapturing(...) async throws -> (exitCode: Int32, output: String) {
    let process = Process()
    // configure process...

    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task {
                try await Task.sleep(for: .seconds(timeout))
                process.terminate()
            }

            process.terminationHandler = { terminated in
                timeoutTask.cancel()
                continuation.resume(returning: (...))
            }

            try process.run()
        }
    } onCancel: {
        process.terminate()
    }
}
```

Two structural changes:

**First:** `process` was moved outside of `withCheckedThrowingContinuation`. This is necessary so that the `onCancel` handler — which is executed outside the continuation, potentially on another thread — has access to the process to terminate it.

**Second:** `withTaskCancellationHandler` guarantees that `onCancel` is invoked exactly when the task is cancelled, whether before entering the body or concurrently while the body is suspended. When `onCancel` calls `process.terminate()`, the process receives SIGTERM, the `terminationHandler` fires, and the `terminationHandler` calls `continuation.resume`. The continuation resumes, the task completes, the cycle closes.

The `timeoutTask` remains unstructured, but now has an important characteristic: when `process.terminate()` is called by `onCancel` and the process dies, `terminationHandler` calls `timeoutTask.cancel()`. The timeout is cancelled before it fires. The reference to the process is released.

The entire lifecycle becomes deterministic: process created -> process terminates (by natural completion, timeout, or task cancellation) -> handler fires -> continuation resumes -> task completes.

---

## What the Fix Doesn't Solve

The fix eliminates the lifecycle bug under Swift Concurrency. But there's a structural problem that remains.

When `process.terminate()` sends SIGTERM to `xcrun swift test`, the signal goes to that specific PID. Upon receiving SIGTERM, `swift test` may exit without waiting for its own children — `swift-driver`, `swift-frontend`, `swift-build-manifest`. These grandchild processes don't receive the signal. They become orphans under PID 1 (launchd), continue running until they complete their work, and show up in Activity Monitor even after the tool has fully terminated.

The correct fix for this problem is different: create a **dedicated process group** for each child process via `setpgid`, and when terminating, send SIGTERM to the entire group via `kill(-pgid, SIGTERM)` — which would propagate the signal to children and grandchildren regardless of tree depth.

This is a larger change, with considerations about race conditions at the time of `setpgid` and about interaction with the terminal's process group. It's documented as a separate milestone.

---

## The General Pattern

The bug has a shape that reappears in any codebase that converts callback-based APIs to Swift Concurrency:

```swift
// Buggy pattern — doesn't respond to cancellation
return try await withCheckedThrowingContinuation { continuation in
    let externalResource = startSomething()
    externalResource.onCompletion = { result in
        continuation.resume(returning: result)
    }
}

// Correct pattern — external process is terminated on cancellation
let externalResource = startSomething()
return try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation { continuation in
        externalResource.onCompletion = { result in
            continuation.resume(returning: result)
        }
    }
} onCancel: {
    externalResource.cancel()
}
```

The rule of thumb: any time `withCheckedThrowingContinuation` manages an external resource with its own lifecycle — a process, a network connection, an I/O operation — `withTaskCancellationHandler` should wrap it. Without it, the external resource has a lifecycle disconnected from Swift's concurrency model.

---

## The Missing Line

Activity Monitor revealed something that no unit test would have caught. The tests verified that the continuation resumed correctly when the process terminated. They didn't verify what happened when the task was cancelled before that.

The fix was to move the `Process` creation outside the continuation and add `withTaskCancellationHandler` with `process.terminate()` in the handler. Two structural changes, no new lines of logic.

Sometimes the simplest bug to fix is the hardest to find — not because the code is complex, but because the right observation point was in a window open in the background.

---

_The complete `ProcessLauncher` code and the process group cleanup milestone are available in the [project repository](https://github.com/ericodx/swift-mutation-testing)._
