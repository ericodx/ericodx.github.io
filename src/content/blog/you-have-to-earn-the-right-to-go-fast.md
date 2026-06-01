---
title: 'You Have to Earn the Right to Go Fast'
description: 'How a missing .sorted taught me that concurrency correctness and performance are separate problems.'
pubDate: 2026-08-03
tags: ['Concurrency', 'Performance']
---

_How a missing `.sorted` taught me that concurrency correctness and performance are separate problems._

I made my clone detector parallel. On the next run, it reported different clones than the run before. Same code. Same files. Different results.

The bug wasn't in the detection logic. It was one missing line — a `.sorted` I hadn't added after introducing `TaskGroup`. Tasks don't complete in the order you submit them. My detector used array indices to track which file a token came from. When the order shifted between runs, the indices shifted with it, and the output became non-deterministic.

That's when I understood that concurrency correctness and performance are separate problems, and you can't solve them simultaneously. You have to earn the right to go fast.

## Why I Started Synchronous

When I designed the pipeline for **swift-cpd**, the right move was to defer concurrency. Not because parallelism was hard, but because I had three open questions: where is the actual bottleneck, is the algorithm stable, and will my tests still be reliable? Adding concurrency before answering those would have turned every bug into a potential race condition.

The measurement confirmed that tokenization was the expensive part — SwiftSyntax parses full ASTs, and a typical file of ~274 tokens costs roughly 7ms in debug. Normalization was cheap. I/O was not the problem. My theory had been right, but I needed the data before I could act on it.

I spent weeks building a correct, well-tested, synchronous implementation. When the migration finally happened, it took hours — not days. Every type was already `Sendable` because the architecture naturally produced immutable value types. The test suite caught the ordering bug immediately. The foundation did its job.

## The Problem: One File at a Time

The pipeline has four stages:

```text
Source Files → Tokenizer → Normalizer → Detector → Results
```

The **Tokenizer** is the bottleneck. Seven milliseconds per file sounds fine until you have hundreds of files. And every file is completely independent — there is no reason to wait for `FileA.swift` before starting `FileB.swift`. I was leaving performance on the table, and now I had the numbers to prove it.

## Three Layers of Speed

I attacked the problem from three angles: parallel execution, incremental caching, and actor-based state management. All built on Swift 6 strict concurrency — no escape hatches.

### Layer 1: TaskGroup for Parallel Tokenization

The first win was the most obvious. Each file gets its own task, and the Swift runtime decides the concurrency level based on available cores:

```swift
func processFiles(_ files: [String], cache: FileCache) async throws -> [FileTokens] {
    try await withThrowingTaskGroup(of: FileTokens.self) { group in
        for file in files {
            group.addTask {
                try await tokenizeFile(file, cache: cache)
            }
        }

        var results: [FileTokens] = []
        for try await result in group {
            results.append(result)
        }

        return results.sorted { $0.file < $1.file }
    }
}
```

That `.sorted` at the end is the line that makes the tool trustworthy. `TaskGroup` doesn't guarantee completion order — tasks finish whenever they finish. My clone detector uses array indices internally to track which file a token came from. Without sorting, running the same analysis twice produces different output. I almost shipped that version.

### Layer 2: SHA256-Based Incremental Cache

Parallelism helps, but you know what's faster than processing a file in parallel? Not processing it at all.

Most of the time, the vast majority of files haven't changed since the last run. Re-tokenizing them is pure waste. I built an incremental cache using SHA256 digests computed with Apple's CryptoKit — no external dependencies:

```swift
struct FileHasher: Sendable {
    func hash(contentsOf filePath: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
```

The cache key is file path plus SHA256 of contents. Changed file? Different hash, cache miss, re-tokenize. This is the part where "cache invalidation is hard" stops being true — when your key is a cryptographic hash of the content, there's nothing to invalidate. Just math.

The cache persists to disk as JSON in a `.swiftcpd-cache/` directory — survives between runs, CI pipelines, and context switches.

### Layer 3: Actor for Thread-Safe Cache

Multiple tasks running in parallel, all reading from and writing to the same cache. The old answer was a class with a lock and thread-safety documentation that someone would eventually violate. The Swift 6 answer is an actor:

```swift
actor FileCache {
    private var entries: [String: CacheEntry] = [:]

    func lookup(file: String, contentHash: String) -> CacheEntry? {
        guard let entry = entries[file], entry.contentHash == contentHash else {
            return nil
        }
        return entry
    }

    func store(file: String, entry: CacheEntry) {
        entries[file] = entry
    }

    func load(from directory: String) {
        let fileURL = URL(fileURLWithPath: directory).appendingPathComponent("cache.json")
        guard
            FileManager.default.fileExists(atPath: fileURL.path),
            let data = try? Data(contentsOf: fileURL),
            let decoded = try? JSONDecoder().decode([String: CacheEntry].self, from: data)
        else { return }
        entries = decoded
    }

    func save(to directory: String) {
        let directoryURL = URL(fileURLWithPath: directory)
        if !FileManager.default.fileExists(atPath: directoryURL.path) {
            try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        }
        guard let data = try? JSONEncoder().encode(entries) else { return }
        let fileURL = directoryURL.appendingPathComponent("cache.json")
        try? data.write(to: fileURL)
    }
}
```

`FileCache` is 46 lines including whitespace. I spent more time debating whether to use an actor than actually implementing it. The compiler enforces that all access to `entries` goes through the serial executor — if you try to access it without `await`, the code doesn't compile. Data races become compile-time errors, not crashes that surface months later.

### How the Three Layers Compose

```swift
private func tokenizeFile(_ filePath: String, cache: FileCache) async throws -> FileTokens {
    let contentHash = try hasher.hash(contentsOf: filePath)
    let source = try String(contentsOfFile: filePath, encoding: .utf8)

    if let cached = await cache.lookup(file: filePath, contentHash: contentHash) {
        return FileTokens(file: filePath, source: source, tokens: cached.tokens, normalizedTokens: cached.normalizedTokens)
    }

    let tokens = tokenizer.tokenize(source: source, file: filePath)
    let normalizedTokens = normalizer.normalize(tokens)

    let entry = CacheEntry(contentHash: contentHash, tokens: tokens, normalizedTokens: normalizedTokens)
    await cache.store(file: filePath, entry: entry)

    return FileTokens(file: filePath, source: source, tokens: tokens, normalizedTokens: normalizedTokens)
}
```

Cache hit: returns in microseconds. Cache miss: tokenizes, stores, returns. Actor isolates the shared state, `TaskGroup` handles the parallelism. The three layers meet here in a function that's easy to read and hard to get wrong.

## The Numbers

All measurements are wall-clock time as seen by a real user — no benchmarking harness, just `Date()` built into the CLI's analysis pipeline. Fifty Swift files, each containing ~274 tokens.

### Debug Build

| Metric                           | Before             | After            | Improvement     |
| -------------------------------- | ------------------ | ---------------- | --------------- |
| **Tokenization** (50 files)      | 355ms (sequential) | 142ms (parallel) | **2.5x faster** |
| **File processing** (warm cache) | 422ms (cold)       | 2ms (cached)     | **199x faster** |

### Release Build

| Metric                           | Before              | After             | Improvement      |
| -------------------------------- | ------------------- | ----------------- | ---------------- |
| **Tokenization** (50 files)      | 9.76ms (sequential) | 1.79ms (parallel) | **5.5x faster**  |
| **File processing** (warm cache) | 75.73ms (cold)      | 1.77ms (cached)   | **42.8x faster** |

The tokenization speedup climbs from 2.5x in debug to 5.5x in release. In debug, task scheduling overhead is proportionally large compared to unoptimized work per task. In release, the per-task work is fast enough that the overhead becomes negligible. You see the real speedup: 1.79ms for 50 files in parallel — thirty-six microseconds per file. At that rate, a 10,000-file codebase tokenizes in under a second.

The cache numbers are equally stark. A 42.8x improvement on warm runs because the only remaining cost is computing SHA256 hashes and reading a JSON file. On incremental runs where fewer than 5% of files changed, the tool feels instant.

## How It All Fits Together

```
┌─────────────────────────────────────────────────────────────┐
│                    AnalysisPipeline                         │
│                                                             │
│  ┌──────────┐    ┌───────────────────────────────────────┐  │
│  │FileHasher│───▶│         FileCache (actor)             │  │
│  │ (SHA256) │    │  ┌─────────┐  ┌──────────────────┐    │  │
│  └──────────┘    │  │ lookup  │  │ store + persist   │   │  │
│                  │  └────┬────┘  └────────▲──────────┘   │  │
│                  └───────┼────────────────┼──────────────┘  │
│                          │                │                 │
│                    cache hit         cache miss             │
│                          │                │                 │
│                          ▼                ▼                 │
│                   ┌────────────┐   ┌──────────────┐         │
│                   │  cached    │   │  TaskGroup   │         │
│                   │ FileTokens │   │  tokenize +  │         │
│                   └─────┬──────┘   │  normalize   │         │
│                         │          └──────┬───────┘         │
│                         ▼                 ▼                 │
│                  ┌──────────────────────────────┐           │
│                  │ sort by file path            │           │
│                  │ (determinism guarantee)      │           │
│                  └──────────────┬───────────────┘           │
│                                ▼                            │
│                  ┌──────────────────────────────┐           │
│                  │   CloneDetector.detect()     │           │
│                  │   (synchronous, sequential)  │           │
│                  └──────────────┬───────────────┘           │
│                                ▼                            │
│                         [CloneGroup]                        │
└─────────────────────────────────────────────────────────────┘
```

Notice that `CloneDetector.detect()` is still synchronous. It operates on the complete collection of all files and has sequential dependencies between its sub-phases. Parallelizing it would add complexity for minimal gain. Not everything should be concurrent — the decision to keep this stage synchronous was as deliberate as the decision to parallelize tokenization.

## What This Changed

The easy part of this project was the performance numbers. The hard part was learning when not to reach for a tool.

I used to think about concurrency as something you add when things are slow. What I built here changed that. The ordering bug taught me that parallelism creates correctness obligations, not just performance opportunities — and those obligations have to be paid before you see the benefit. The actor implementation taught me that the right concurrency primitive can be smaller than the problem it solves. The synchronous migration taught me that measurement isn't just about performance; it's about earning confidence before increasing complexity.

Swift 6 strict concurrency accelerates all of this. When `Sendable` is a compiler constraint, you can't accidentally share mutable state across task boundaries — the unsafe path doesn't compile. The type system pushes you toward architectures where incorrect concurrent code is inexpressible rather than merely unlikely. That's a different kind of safety than test coverage provides, and it scales differently: it holds regardless of how many callers you add, how many tasks you spawn, or how far the code drifts from the original design.

I think about that pressure now when I reach for any shared state: can the type system own this invariant instead of a test? The answer is usually yes, and it's usually simpler than I expect.

---

_Benchmarks measured on Apple Silicon M4 Max (arm64), macOS 26, Swift 6.2. All measurements taken with 50 files containing ~274 tokens each._

_swift-cpd is open source at [github.com/ericodx/swift-cpd](https://github.com/ericodx/swift-cpd)._
