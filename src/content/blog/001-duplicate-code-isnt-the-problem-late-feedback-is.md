---
title: 'Duplicate Code Isn’t the Problem — Late Feedback Is'
description: 'Most teams already have duplication tools. The problem is when they speak.'
pubDate: 2025-11-01
---

Most teams already have duplication tools. The problem is when they speak.

I fixed a validation bug on a Monday. On Thursday, a user reported the same crash on a different screen. The validator had been copied into another feature three months earlier. The copy never got the fix.

The CI report had flagged the duplication. I'd seen it. I just hadn't acted on it before writing more code around the original, and the copy had long since drifted out of sight.

That's the real problem with duplicate code — not that it exists, but that the feedback arrives after the damage is already done. The problem isn't detection. It's latency.

## The Honest Cost of Duplication

Every software engineer knows the failure mode:

- A fix applied to one copy, missed in two others.
- Refactors that stall because no one is confident they've found every occurrence.
- Source files that are 90% identical, diverging in subtle ways no one can explain anymore.
- Validation logic scattered across features, each copy drifting silently from the others.

The predictable consequence of normal software growth — deadline pressure, temporary copies that become permanent, parallel work across teams. The question is whether you find out soon enough to do something about it.

## The Tools That Exist

Duplication detection is a solved problem at the CI level. Several mature tools handle it well.

**jscpd** is a multi-language detector based on hashing. CLI-native, easy to integrate into any pipeline, supports Swift without configuration. The right choice when you want quick results without runtime dependencies.

**PMD CPD** is the established option from the Java world — robust, multiple report formats, requires a JVM. Common in corporate pipelines where it's already part of the toolchain.

**SonarCloud** is the enterprise path: continuous analysis, duplication metrics, complexity, security. It owns a dashboard. It integrates with pull request checks. If your team already runs it, the duplication story is covered.

All three work. None of them tell you about the problem while you're writing it.

## Where the Gap Is

These tools operate at commit time or later. By the time the CI report surfaces a duplication warning, the code has already been written, reviewed, and merged. The fix requires a follow-up PR. The follow-up PR requires context-switching back to something you finished yesterday. Often it doesn't happen.

This isn't a criticism of the tools — it's a property of when they run. The question is whether there's value in moving the signal earlier, into the editor, at the moment the duplication is introduced.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│     IDE      │    │     CLI      │    │      CI      │
│              │    │              │    │              │
│  You write   │    │  You run     │    │  PR merges   │
│  the code    │    │  analysis    │    │  Report      │
│              │    │  manually    │    │  arrives     │
│  ← earliest  │    │              │    │  latest →    │
└──────────────┘    └──────────────┘    └──────────────┘
```

The tradeoff is explicit: IDE-native feedback costs build time. Every analysis run at compile time is overhead you pay on every build. Whether that overhead is worth the earlier signal depends entirely on the team's workflow. For teams who run CI checks and act on them promptly, there's no gap to close. For teams doing active refactoring, or those where the CI queue introduces meaningful delay, earlier feedback changes the economics.

## What an Xcode-Native Approach Looks Like

Swift Package Manager build plugins make it possible to run analysis during the build and emit results as clickable warnings directly in the editor. The developer sees duplication the same way they see a compilation warning — inline, immediately, without leaving the tool they're already using.

A practical architecture for this:

```
┌─────────────────────────────────────────────────────────┐
│                     swift-cpd                           │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Analysis Engine                         │   │
│  │  SwiftSyntax → Tokenizer → Normalizer → Detector │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│           ┌─────────────┼─────────────┐                 │
│           ▼             ▼             ▼                 │
│    ┌────────────┐ ┌──────────┐ ┌──────────────┐         │
│    │ SPM Plugin │ │   CLI    │ │  CI Output   │         │
│    │  (Xcode)   │ │ (manual) │ │  (reports)   │         │
│    │  warnings  │ │          │ │              │         │
│    └────────────┘ └──────────┘ └──────────────┘         │
└─────────────────────────────────────────────────────────┘
```

One engine, three surfaces. The IDE plugin emits inline warnings and navigates directly to the duplicated code. The CLI supports manual runs and scripting. The CI output produces reports and can block merges above a threshold. No Node runtime, no JVM — if the team prefers a pure Swift stack.

I considered using a pre-commit hook instead of an SPM plugin. The hook approach is simpler to install but invisible to Xcode — warnings don't appear inline, you get a terminal message at commit time. The plugin approach requires more setup but integrates directly into the development flow where a developer's attention is already focused. That's the tradeoff I decided was worth paying.

## Which Approach Fits Which Context

The tools are not competing. They occupy different positions in the development cycle, and the best setup is usually more than one.

**jscpd / PMD CPD / SonarCloud** belong in CI. They provide historical metrics, enforce thresholds on pull requests, and produce dashboards that communicate quality trends to the team. They're already solving the problem at that layer.

**An IDE-native plugin** belongs in the editor. It shifts the feedback loop from "after merge" to "while writing," which changes the cost of acting on it. A warning you see while your hands are on the keyboard is cheaper to fix than one you come back to tomorrow.

Both coexist naturally. The question isn't which to use — it's which layer of the development cycle has the most friction for your team right now.

## What This Is Really About

Thinking about this problem clarified something about developer tooling in general: the value of a tool is not just what it detects, but when it tells you. The same information delivered at different moments in the cycle has a completely different cost of action. CI tells you after the fact. The editor tells you before the decision is made.

Most quality tooling is designed around the commit-and-report model because it's easier to build and integrate. But the developer experience compounds at the margins: a signal one step earlier, in the context where the work is happening, removes the round-trip cost that accumulates across hundreds of decisions a week.

That's the bet behind an IDE-native approach — not that CI is wrong, but that some problems are cheaper to fix before they leave the editor.

---

_swift-cpd is open source at [github.com/ericodx/swift-cpd](https://github.com/ericodx/swift-cpd)._
