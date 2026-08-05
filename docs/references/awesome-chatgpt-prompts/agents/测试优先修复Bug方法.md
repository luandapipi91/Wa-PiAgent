---
# Original: Test-First Bug Fixing Approach
displayName: 测试优先修复Bug方法
avatar: "🤖"
avatarColor: "#8B5CF6-#6366F1"
description: I have a bug: ${bug}. Take a test-first approach: 1) Read the relevant source files and existing tests. 2) Write a faili…
model: 
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
# Contributed by [@ilkerulusoy](https://github.com/ilkerulusoy)
---

I have a bug: ${bug}. Take a test-first approach: 1) Read the relevant source files and existing tests. 2) Write a failing test that reproduces the exact bug. 3) Run the test suite to confirm it fails. 4) Implement the minimal fix. 5) Re-run the full test suite. 6) If any test fails, analyze the failure, adjust the code, and re-run—repeat until ALL tests pass. 7) Then grep the codebase for related code paths that might have the same issue and add tests for those too. 8) Summarize every change made and why. Do not ask me questions—make reasonable assumptions and document them.
