---
title: 'Three Hours to Learn How Build Systems Actually Think'
description: 'What fighting the Xcode sandbox taught me about contracts, trust, and pragmatism.'
pubDate: 2026-06-22
tags: ['Build Systems', 'Xcode']
---

_What fighting the Xcode sandbox taught me about contracts, trust, and pragmatism._

It was supposed to be simple.

Apple's documentation promised: "Build Tool Plugins let you run custom tools during the build process." I had a working CLI. I had experience with Swift Package Manager. The plugin was just a wrapper around an executable that already existed.

How hard could it be? Three hours later, I had my answer — and a fundamentally different understanding of how build systems enforce trust.

## The First Step: The False Simplicity

The initial code looked trivial. Following the documentation examples, I created `Plugin.swift`:

```swift
@main
struct SwiftMarshalPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        let tool = try context.tool(named: "swift-marshal")
        return [
            .buildCommand(
                displayName: "Swift Marshal Check",
                executable: tool.url,
                arguments: ["check", "--xcode", "--path", sourceTarget.directoryURL.path()],
                outputFiles: [outputPath]
            )
        ]
    }
}
```

Build. Success. Integrated into a test project. And then, the first ghost appeared:

```plaintext
The package product 'SwiftSyntax' requires minimum platform version 13.0 for the iOS platform, but this target supports 12.0
```

## Problem 1: The Platform Ghost

The first obstacle came from somewhere I least expected.

My `Package.swift` only declared `.macOS(.v15)`. After all, it's a command-line tool. But plugins are part of the dependency graph. When an iOS project adds your package, it inherits your platform requirements.

SwiftSyntax requires iOS 13. My package didn't declare iOS support, creating a conflict. The solution was to explicitly declare all supported platforms in `Package.swift` to satisfy the resolver:

```swift
platforms: [
    .macOS(.v15),
    .iOS(.v15),
    .tvOS(.v15),
    .watchOS(.v8),
    .visionOS(.v1),
]
```

Build again. The plugin was executing. Warnings showing up in Xcode.

Victory? Not so fast.

## Problem 2: The Ghost File

```plaintext
lstat(/Users/.../lint-output.txt): No such file or directory
```

Xcode was complaining about a file that didn't exist. I had declared `outputFiles: [outputPath]`, promising the build system that my tool would produce a file. But my CLI only printed warnings to the console; it never created an actual file.

**Build Tool Plugins have an implicit contract:** If you declare an output, you must deliver it. The build system uses these files to track the state of the build. No file means the "promise" was broken, and the build fails.

## Problem 3: The Unforgiving Sandbox and the Temporal Paradox

I tried switching to `prebuildCommand`, thinking it would solve the output issue since prebuilds don't require declared outputs. Build. And then:

```plaintext
a prebuild command cannot use executables built from source,
including executable target 'swift-marshal'
```

This is a **temporal paradox**: Prebuild commands run before the build starts — which includes before compiling the very tool you want to use. You cannot use a tool that doesn't exist yet.

**The Hard Lesson:** To use a tool built from source within the same package, you must use `buildCommand`. And to use `buildCommand`, you must respect the output contract.

## The Solution: Adapting to the Ecosystem

I had to modify my CLI to satisfy the IDE. I added an --output option to create a "marker file"—an empty file whose only purpose is to tell Xcode: "I ran, and I'm done."

```swift
if let outputPath = output {
    try writeMarkerFile(to: outputPath)
}
```

The plugin now passes this path, ensuring the build graph remains intact and deterministic.

## Problem 4: Supporting Xcode Projects (.xcodeproj)

Supporting Swift Packages is one thing; supporting legacy `.xcodeproj` is another. I had to implement `XcodeBuildToolPlugin`:

```swift
#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

extension SwiftMarshalPlugin: XcodeBuildToolPlugin {
    func createBuildCommands(
        context: XcodePluginContext,
        target: XcodeTarget
    ) throws -> [Command] {
        // Similar implementation, but using context.xcodeProject.directoryURL
    }
}
#endif
```

The `#if canImport` is required because `XcodeProjectPlugin` is an Xcode-specific framework that doesn't exist in pure SPM/Linux environments.

## Conclusion

Three hours for 60 lines of code. A terrible ratio if you measure productivity in lines per hour, but a masterclass in how the Apple ecosystem works beneath the surface. Native IDE integration—seeing warnings appear inline as you type—is worth every second of the battle against the sandbox.

## Field Notes: Engineering Trade-offs

- **The Output Contract is Sacred:** Whether it's a report or a code generation file, if you declare an output, you must create it. This is how the build system manages incremental builds.
- **The Sandbox is a One-Way Street:** Plugins can't modify source files (which is why my `fix` command can't run as a plugin). They live in a restricted directory (`pluginWorkDirectory`).
- **Adapt the Tool, Not the IDE:** I didn't want a "marker file" in my design, but it was the price of admission for native IDE integration. Sometimes, engineering is about pragmatism over purity.

---

_The full source code is available at [github.com/ericodx/swift-marshal](https://github.com/ericodx/swift-marshal/tree/main/Plugins)_
