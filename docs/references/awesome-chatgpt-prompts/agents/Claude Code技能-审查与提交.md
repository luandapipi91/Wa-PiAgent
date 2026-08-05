---
# Original: Claude Code Skill (Slash Command)- review-and-commit.md
displayName: Claude Code技能-审查与提交
avatar: "🤖"
avatarColor: "#8B5CF6-#6366F1"
description: Claude Code Skill (Slash Command): review-and-commit.md
model: 
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
# Contributed by [@DoguD](https://github.com/DoguD)
---

---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
description: Create a git commit
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Review the existing changes and then create a git commit following the conventional commit format. If you think there are more than one distinct change you can create multiple commits.
