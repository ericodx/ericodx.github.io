---
title: 'Code Organization Isn’t Style — It’s Governance'
description: 'Why I built a tool to automate structural conventions — and why the organizational problem was harder than the technical one.'
pubDate: 2026-06-08
tags: ['Code Quality']
---

_Why I built a tool to automate structural conventions — and why the organizational problem was harder than the technical one._

A pull request came in with 180 changed lines. The actual logic change was two. The rest was a developer reorganizing the file to match their own mental model of where initializers belong.

No one had told them they were wrong. There was no rule. There was just entropy — and a code review that spent thirty minutes on structure instead of correctness.

That's the problem I built swift-marshal to solve.

## Why No Existing Tool Fixes This

I looked for something off the shelf before building anything. SwiftLint was the obvious first stop — it's ubiquitous in Swift teams and covers a lot of ground. But SwiftLint knows about line length, whitespace, and naming conventions. It has no opinion on whether your initializer should come before or after your computed properties. Neither does any other tool I could find.

The gap is specific: **semantic ordering** of members within a type requires deep syntactic analysis. You need to understand that `var id: UUID` is a stored property, that `init(id: UUID)` is a designated initializer, and that `func validate()` is an instance method — and then enforce a consistent ordering across all of them, in every type, in every file. That's not a formatting problem. It's a structural governance problem.

The consequence of leaving it unsolved is predictable. Structural inconsistency doesn't cause crashes. That's why it accumulates unnoticed — until you're reviewing a 180-line diff where two lines matter.

Cognitive load compounds across files. New developers follow the pattern they find, even when there is no pattern. Reviews slow down before logic is ever evaluated. And every commit that adds disorder makes the next one slightly more expensive to read.

## The Constraint That Shaped Everything

The solution I built — **swift-marshal** — reorganizes members within Swift types based on configurable rules. The team defines ordering conventions in a YAML file. The tool enforces them automatically.

But the implementation had one hard constraint from the start: **don't rewrite code**.

Tools that reformat aggressively produce enormous diffs, pollute Git history, and create developer resistance. I'd seen it with auto-formatters: the change is technically correct, but the diff is noise, and the team starts ignoring the output. Swift Marshal works through the Swift syntax tree, via SwiftSyntax, moving members while preserving comments, spacing, and original trivia. The output is structurally reorganized but textually recognizable.

Making trivia preservation work correctly was the hardest part of the implementation — a comment attached to a property has to travel with that property when it moves, and the leading whitespace of the first member in a block has different semantics than the rest. Getting that wrong produces output that compiles but silently corrupts documentation. I nearly shipped the version that got it wrong.

## How It Embeds in a Team's Workflow

The tool runs in two modes:

```
┌─────────────────────────────────────────────────────┐
│                  Development Cycle                  │
│                                                     │
│   Define rules        Developer runs                │
│   in .marshal.yml ──▶ swift-marshal fix   ──┐       │
│         │             before commit         │       │
│         │                                   ▼       │
│         └──────────▶  CI runs check   ──▶ Pass/Fail │
│                       on every PR                   │
│                                                     │
│   Result: code reviews focus on logic, not layout   │
└─────────────────────────────────────────────────────┘
```

`check` mode analyzes files and reports violations — used in CI to block merges that break the convention. `fix` mode applies corrections automatically — used locally before committing, or in pre-commit hooks.

The important property of this cycle is that enforcement is automatic. Rules don't rely on individual developers remembering to follow them. They don't depend on a reviewer catching violations before they merge. The convention exists in a file, the tool enforces it, and the team stops having conversations about it.

That shift — from "we should follow this convention" to "the build enforces this convention" — changes the texture of code reviews. Structure stops being a topic.

## Governance as Infrastructure

This project clarified something I'd understood abstractly but not concretely until I had to build it: **the technical problem is almost never the real problem**.

Reorganizing Swift type members is an interesting engineering challenge. SwiftSyntax tree traversal, depth counters for nested types, trivia redistribution — the implementation has real complexity. But teams don't need that complexity explained to them. They need the convention enforced without friction.

In large teams, consistency is infrastructure. It has the same relationship to productivity that CI has to reliability: you don't notice it when it works, and you pay for its absence constantly when it doesn't. The cost is diffuse — thirty minutes here, a confused new developer there, a code review that generated heat but no signal. It never shows up in a postmortem. It just slows everything down.

The tool I ended up building is mostly organizational, not technical. The technical part took weeks. The organizational part — deciding what the rules should be, how teams would adopt them, what the right defaults look like — took longer and mattered more.

If your team debates structure in code reviews, that's the signal. The debate itself is the cost. Automating the answer removes the debate entirely, and that's where the real return comes from.

---

_swift-marshal is open source at [github.com/ericodx/swift-marshal](https://github.com/ericodx/swift-marshal)_
