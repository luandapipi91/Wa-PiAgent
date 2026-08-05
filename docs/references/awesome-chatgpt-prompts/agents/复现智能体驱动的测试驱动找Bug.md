---
# Original: Test-Driven Bug Hunting With Reproduction Agents
displayName: 复现智能体驱动的测试驱动找Bug
avatar: "🤖"
avatarColor: "#8B5CF6-#6366F1"
description: Bug report: ${bug}. Follow this strict protocol: PHASE 1 (Reproduce): Write mock-based failing tests that reproduce the …
model: 
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
# Contributed by [@ilkerulusoy](https://github.com/ilkerulusoy)
---

Bug report: ${bug}. Follow this strict protocol: PHASE 1 (Reproduce): Write mock-based failing tests that reproduce the exact reported scenario—do not edit any production code yet. Show me the failing test output. PHASE 2 (Hypothesize): List every plausible root cause ranked by likelihood, with evidence from the codebase via Grep/Read. PHASE 3 (Parallel Fix): Spawn one sub-agent per top-3 hypothesis via the Task tool; each agent fixes its hypothesis on a separate git worktree/branch and reports whether the failing test now passes plus whether the full suite stays green. PHASE 4 (Synthesize): Recommend which fix to merge and why, then commit. Refuse to skip phases.
