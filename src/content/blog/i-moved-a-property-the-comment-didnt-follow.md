---
title: 'I Moved a Property. The Comment Didn’t Follow.'
description: 'I moved a property three positions down in a Swift struct. The comment above it ended up attached to a completely different method. The code compiled. The...'
pubDate: 2026-07-06
tags: ['Swift', 'Code Quality']
---

I moved a property three positions down in a Swift struct. The comment above it ended up attached to a completely different method. The code compiled. The tests passed. And if I hadn't caught it manually, it would have silently corrupted documentation across hundreds of files in a real codebase.

That was the moment I understood that working with source code as data is a fundamentally different problem than writing application logic. You're not manipulating text. You're navigating a living tree of semantic nodes — and every node carries invisible cargo that travels with it whether you want it to or not.

**[swift-marshal](https://github.com/ericodx/swift-marshal)** reorganizes members within Swift types. This is the story of the problems I didn't anticipate, and the decisions I made — and discarded — along the way.

## SwiftSyntax: two tools, two jobs

[SwiftSyntax](https://github.com/apple/swift-syntax) represents Swift source code as a typed tree where every node knows what it is — a function declaration, a property, an initializer — rather than what it looks like as characters.

Two primitives do most of the work. `SyntaxVisitor` walks the tree and fires callbacks as it enters each node. `SyntaxRewriter` transforms it immutably, producing a new tree with changes applied. The return value from each `visit` method shapes traversal: `.visitChildren` keeps descending, `.skipChildren` prunes that branch.

```swift
// Sources/SwiftMarshal/Core/Visitors/UnifiedTypeDiscoveryVisitor.swift

final class UnifiedTypeDiscoveryVisitor<Builder: TypeOutputBuilder>: SyntaxVisitor {

    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
        let members = discoverMembers(in: node.memberBlock)
        let position = node.positionAfterSkippingLeadingTrivia
        record(
            name: node.name.text,
            kind: .structType,
            position: position,
            members: members,
            memberBlock: node.memberBlock
        )
        return .visitChildren
    }
}
```

Simple model. Sharp edges.

## The nesting problem

The first edge: attribution. When you visit a `StructDeclSyntax`, the visitor descends into its children — including any nested types and their members.

```swift
struct Outer {
    var outerProperty: Int  // ✓ Member of Outer

    struct Inner {
        var innerProperty: Int  // ✗ Member of Inner, not Outer
    }
}
```

A naive traversal happily records `innerProperty` as a member of `Outer`. The output looks plausible and is completely wrong.

My first instinct was to track which type contexts I'd entered using a Set of node IDs. That works, but it's more machinery than the problem demands. The right answer is a depth counter:

```swift
// Sources/SwiftMarshal/Core/Visitors/UnifiedMemberDiscoveryVisitor.swift

final class UnifiedMemberDiscoveryVisitor<Builder: MemberOutputBuilder>: SyntaxVisitor {

    private var depth = 0

    override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
        guard depth == 0 else { return .skipChildren }
        let isStatic = node.modifiers.contains { $0.name.tokenKind == .keyword(.static) }
        let kind: MemberKind = isStatic ? .typeProperty : .instanceProperty
        // ... records the member
        return .skipChildren
    }

    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
        recordNestedTypeIfNeeded(...)
        depth += 1
        return .visitChildren
    }

    override func visitPost(_: StructDeclSyntax) {
        depth -= 1
    }
}
```

`visitPost` fires on exit — depth increments going in, decrements coming out. Only members at `depth == 0` get captured. Nested types are recorded as members of the parent, but their own members stay out of scope. It took me longer than I'd like to admit to stop reaching for a more sophisticated data structure.

## Scaling to real codebases

Processing one file in 10ms is fine. Processing 10,000 files sequentially is 100 seconds. Not acceptable for a CLI.

`withThrowingTaskGroup` fans out work across all available cores:

```swift
// Sources/SwiftMarshal/Pipeline/PipelineCoordinator.swift

actor PipelineCoordinator {

    func checkFiles(_ paths: [String]) async throws -> [CheckResult] {
        let pipeline = ParseStage()
            .then(ClassifyStage())
            .then(ReorderStage(configuration: configuration))

        return try await withThrowingTaskGroup(of: CheckResult.self) { group in
            for path in paths {
                group.addTask {
                    try await self.checkSingleFile(path: path, pipeline: pipeline)
                }
            }

            var results: [CheckResult] = []
            for try await result in group {
                results.append(result)
            }
            return results
        }
    }
}
```

Each file gets an independent task. The Swift runtime decides concurrency level based on available cores. For file writes, a dedicated actor serializes operations — without it, concurrent writes to the same path are a race condition:

```swift
// Sources/SwiftMarshal/Infrastructure/Files/FileIOActor.swift

actor FileIOActor {
    func read(at path: String) throws -> String {
        try FileReadingHelper.read(at: path)
    }

    func write(_ content: String, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        try content.write(to: url, atomically: true, encoding: .utf8)
    }
}
```

No locks, no manual coordination. The actor model handles serialization by construction.

## How it all fits together

```
┌────────────────────────────────────────────────────────────────┐
│                      PipelineCoordinator                       │
│                         (actor)                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │              withThrowingTaskGroup                        │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                    │ │
│  │  │ Task 1  │  │ Task 2  │  │ Task N  │   (parallel)       │ │
│  │  │ file1   │  │ file2   │  │ fileN   │                    │ │
│  │  └────┬────┘  └────┬────┘  └────┬────┘                    │ │
│  └───────┼────────────┼────────────┼─────────────────────────┘ │
│          │            │            │                           │
│          ▼            ▼            ▼                           │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                    Pipeline (per file)                    │ │
│  │                                                           │ │
│  │   ParseStage ──► ClassifyStage ──► ReorderStage           │ │
│  │       │              │                  │                 │ │
│  │       ▼              ▼                  ▼                 │ │
│  │   SwiftSyntax    SyntaxVisitor     ReorderEngine          │ │
│  │   Parser         (depth track)      (rule match)          │ │
│  │                                                           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                    FileIOActor                            │ │
│  │              (serialized I/O operations)                  │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

## Swift 6's `Sendable` constraint

Swift 6 strict concurrency requires data crossing task boundaries to be `Sendable`. `SyntaxVisitor` isn't — which looks like a problem in a concurrent context.

The temptation is `@unchecked Sendable`. I nearly went there. But the design sidesteps the problem entirely: each task creates its own visitor, uses it, and discards it. Nothing is shared across task boundaries, so the compiler has nothing to prove. Marking a type `@unchecked Sendable` buys you silence, not safety — and it took about ten minutes of sitting with the problem to see that I didn't need to share visitors at all.

What _does_ cross boundaries is the data flowing between pipeline stages, enforced at the protocol level:

```swift
// Sources/SwiftMarshal/Pipeline/Stages/Protocols/Stage.swift

protocol Stage<Input, Output>: Sendable {
    associatedtype Input: Sendable
    associatedtype Output: Sendable
    func process(_ input: Input) throws -> Output
}
```

Isolation by design, not by suppression.

## The trivia problem

Back to that orphaned comment.

"Trivia" in SwiftSyntax is the whitespace, newlines, and comments attached to each syntax node. When you reorder members, each node carries its own trivia — but the member that _was_ in the first slot carries the block's leading trivia. Promote a different member to first, and that trivia disappears from the block. Demote the original first member, and it arrives with trivia that no longer makes sense for its new position.

```swift
// Before:
struct User {
    // Unique user identifier
    let id: UUID

    func validate() { }
}

// Naive reordering (wrong):
struct User {
    func validate() { }
    // Unique user identifier  <- orphaned comment
    let id: UUID
}

// Correct:
struct User {
    // Unique user identifier
    let id: UUID

    func validate() { }
}
```

The rewriter tracks the leading trivia of the first member slot before reordering, then redistributes it explicitly:

```swift
// Sources/SwiftMarshal/Pipeline/Stages/Rewrite/MemberReorderingRewriter.swift

private func reorderMemberBlock(
    _ memberBlock: MemberBlockSyntax,
    using plan: TypeRewritePlan
) -> MemberBlockSyntax {
    let allItems = Array(memberBlock.members)
    let firstTrackedIndex = trackedIndices[0]
    let originalFirstTrackedTrivia = allItems[firstTrackedIndex].leadingTrivia

    var reorderedTrackedItems: [MemberBlockItemSyntax] = []
    for (newIndex, indexedMember) in plan.reorderedMembers.enumerated() {
        let originalIndex = indexedMember.originalIndex
        var item = allItems[trackedIndices[originalIndex]]

        if newIndex == 0 {
            item = item.with(\.leadingTrivia, originalFirstTrackedTrivia)
        } else if originalIndex == 0 {
            let normalizedTrivia = inferLeadingTriviaFromItems(allItems, trackedIndices: trackedIndices)
            item = item.with(\.leadingTrivia, normalizedTrivia)
        }

        reorderedTrackedItems.append(item)
    }
    // ...
}
```

The first slot always gets the original leading trivia. Members displaced from first position get their trivia normalized. Everything else carries its own trivia naturally. I nearly shipped the version without this — and in a real codebase, it would have silently mangled comments across hundreds of files before anyone noticed.

## Matching the right type

One more thing that sounds trivial and isn't: finding the correct type node to rewrite when multiple types share a name across different scopes.

The solution is two-tier matching — exact by syntax node ID first, member count as fallback:

```swift
// Sources/SwiftMarshal/Pipeline/Stages/Rewrite/MemberReorderingRewriter.swift

private func findPlan(for name: String, memberBlock: MemberBlockSyntax) -> TypeRewritePlan? {
    for (location, plan) in plansByLocation where location.name == name {
        if membersMatchByID(memberBlock: memberBlock, plan: plan) {
            return plan
        }
    }

    for (location, plan) in plansByLocation where location.name == name {
        if membersMatchByCount(memberBlock: memberBlock, plan: plan) {
            return plan
        }
    }
    return nil
}

private func membersMatchByID(memberBlock: MemberBlockSyntax, plan: TypeRewritePlan) -> Bool {
    let planMemberIDs = Set(plan.originalMembers.map(\.syntax.id))
    let trackedBlockMembers = Array(memberBlock.members).filter { planMemberIDs.contains($0.id) }

    guard trackedBlockMembers.count == plan.originalMembers.count else { return false }

    return zip(trackedBlockMembers, plan.originalMembers.map(\.syntax)).allSatisfy { $0.id == $1.id }
}
```

AST node IDs are unique within a parsed tree, so ID matching is precise. Member count is a cheaper heuristic for edge cases — it's the kind of fallback that works until it doesn't, and I expect to revisit it when I eventually hit a file that proves it wrong.

## Composing stages safely

Pipeline architectures have a classic failure mode: you wire stages in the wrong order, types don't align, and you find out at runtime. With associated types and a single constraint, that becomes a compile-time error:

```swift
// Sources/SwiftMarshal/Pipeline/Stages/Protocols/Stage.swift

extension Stage {
    func then<Next: Stage>(_ next: Next) -> Pipeline<Self, Next> where Output == Next.Input {
        Pipeline(self, next)
    }
}
```

`where Output == Next.Input` means you cannot connect incompatible stages. The `Pipeline` type composes two stages into one:

```swift
// Sources/SwiftMarshal/Pipeline/Pipeline.swift

struct Pipeline<S1: Stage, S2: Stage>: Stage, Sendable where S1.Output == S2.Input {
    typealias Input = S1.Input
    typealias Output = S2.Output

    private let first: S1
    private let second: S2

    func process(_ input: Input) throws -> Output {
        let intermediate = try first.process(input)
        return try second.process(intermediate)
    }
}
```

Which makes the full wiring read like a sentence:

```swift
let pipeline = ParseStage()
    .then(ClassifyStage())
    .then(ReorderStage(configuration: configuration))
```

Correct wiring is not tested — it is inexpressible otherwise.

## What building this changed

The biggest surprise was how little of the hard work was AST manipulation. The hard work was everything around it: depth tracking, trivia redistribution, type matching, concurrent correctness.

But the more durable shift was in how I think about safety. Before this project, safety meant tests — write enough of them and you cover the cases. What I took from building swift-marshal is that structural safety is categorically more valuable. The visitor-per-task design didn't just avoid a data race — it made the race inexpressible. The type-safe pipeline didn't just reduce wiring bugs — it made incorrect wiring a compile error. The actor boundary didn't just serialize writes — it made concurrent writes impossible to accidentally trigger.

Swift 6's strict concurrency acts as a pressure system. It doesn't just catch bugs. It pushes you toward architectures where certain bugs cannot exist — where the constraint is in the shape of the code, not in the tests that observe it.

I think about that trade-off now at the start of most designs: where can I move safety from runtime observation to structural impossibility? The answer is usually earlier than I expect, and cheaper than it looks.

The full source code is available at **[github.com/ericodx/swift-marshal](https://github.com/ericodx/swift-marshal)** — contributions welcome.

---

_Part of a series on building Swift Marshal — the [first article](/blog/code-organization-isnt-style-its-governance/) covers the governance problem the tool solves._

_swift-marshal is open source at [github.com/ericodx/swift-marshal](https://github.com/ericodx/swift-marshal)._
