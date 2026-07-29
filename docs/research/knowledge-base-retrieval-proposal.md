# WaPi 知识库检索功能 — 技术方案

> **状态：** 技术调研与方案对比  
> **日期：** 2026-07-21  
> **作者：** WaPi 技术团队  

---

## 1. 背景与目标

### 1.1 需求场景

WaPi 作为 AI 编码助手，当前可通过以下方式获取外部信息：

- **Web 搜索**：`web_search` / `fetch_content` / `get_search_content`（`pi-web-access` 扩展）
- **项目文件读写**：`read` / `grep` / `find` / `ls` / `edit` / `write`
- **会话记忆**：`memory_add` / `memory_read` 等（`@amaster.ai/pi-memory` 文本文件）

但缺少**对本地/远程知识库的语义检索能力**——agent 无法：
- 从项目文档（README、设计文档、API 文档）中按语义查询
- 检索团队积累的技术规范、最佳实践、历史决策记录
- 对接企业已有的知识库系统（Confluence、Notion、语雀等）

### 1.2 目标

为 WaPi 增加**知识库检索（RAG）**能力，使 agent 能够：
1. **索引知识源**：导入本地文件、目录、或远程文档作为知识库
2. **语义检索**：按自然语言查询匹配最相关的知识片段
3. **上下文注入**：将检索结果作为 agent 系统提示词或工具调用结果，辅助 agent 决策

---

## 2. WaPi 现有架构分析

### 2.1 工具注入的三条路径

WaPi 为 agent 注入工具（tools）有以下三种方式，知识库检索可选任一或组合：

| 路径 | 实现方式 | 示例 | 适合场景 |
|------|---------|------|---------|
| **A. customTools** | `agent-manager.ts` 中 `createAgentSession({ customTools })` 注入，TypeBox schema + execute 函数 | `memory_*`、`delegate`、`fleet`、`ask_user_question` | 内核自维护、强类型、与 WaPi 深度耦合的工具 |
| **B. MCP 服务器** | `mcp-connector.ts` 连接外部 stdio/HTTP MCP 服务器，工具名经 `resolveAgentTools` 注入 allowlist | 任意 MCP 兼容服务器（如文件系统、数据库 MCP） | 外部/第三方工具、跨项目复用、独立进程管理 |
| **C. Pi 扩展** | `extensions.ts` 中 `additionalExtensionPaths` 注入，扩展包通过 `pi.extensions` 声明注册工具 | `pi-web-access`（网络搜索）、`pi-mcp-adapter`（MCP 桥接） | 可发布/复用的 NPM 包，独立生命周期 |

### 2.2 相关已有组件

| 组件 | 文件 | 作用 | 知识库检索的复用点 |
|------|------|------|-------------------|
| **MCP 连接器** | `kernel/src/mcp-connector.ts` | 连接测试、工具列举、OAuth 授权清理 | 可直接连接现成的 RAG MCP 服务器 |
| **MCP 存储** | `kernel/src/mcp-store.ts` | MCP 服务器配置持久化（`~/.wa-pi/mcp-servers.json`） | 复用配置界面和存储逻辑 |
| **MCP 前端** | `frontend/.../McpPage.tsx`, `McpForm.tsx`, `McpCard.tsx` | MCP 服务器管理 UI（添加/测试/删除/列举工具） | 前端管理界面可直接复用 |
| **记忆系统** | `kernel/src/amaster-memory.ts` | 文件型记忆存储（MEMORY.md/USER.md） | customTools 注入模式参考 |
| **工具解析** | `shared/src/constants.ts:resolveAgentTools` | 按启用扩展动态合并 allowlist + 去重 | 新增工具自动加入 allowlist |
| **扩展管理** | `kernel/src/extension-manager.ts` | NPM 扩展安装/启用/升级 | 知识库扩展可走此通道发布和安装 |

### 2.3 Pi 生态现有知识库/RAG 插件调研 🔍

本节是本次调研的核心发现。Pi 生态（[pi.dev/packages](https://pi.dev/packages)）已有 **5343 个包**，其中多个直接命中知识库检索需求。

#### 2.3.1 最匹配的插件

| 插件 | 版本 | 作者 | 下载量 | 核心能力 | 与 WaPi 兼容性 |
|------|------|------|--------|---------|-------------------|
| **`pi-knowledge-search`** ⭐ | 1.3.5 | samfp | 296/月 | 混合向量+BM25搜索，SQLite FTS5，`knowledge_search`+`kb_read` 工具，支持 OpenAI/Ollama/Bedrock 嵌入 | ✅ Pi 扩展，可走 extensions.ts 直接集成 |
| **`pi-code-graph`** | 0.16.0 | picassio | 378/月 | 代码知识图谱+语义搜索，9语言 tree-sitter+Memgraph+zvec HNSW，6个工具 | ⚠️ 需 Docker（Memgraph），较重 |
| **`@cad0p/pi-napkin`** | - | cad0p | - | Obsidian 知识库集成，`kb_search`+`kb_read`，自动蒸馏 | ✅ Pi 扩展 |
| **`pi-vault-mind`** | 0.16.11 | kylebrodeur | 8.8K/月 | LanceDB 向量+FTS+图，多智能体 Obsidian 工作流 | ✅ Pi 扩展，使用 LanceDB |
| **`pi-hermes-memory`** | 0.8.1 | chandra447 | 16.6K/月 | SQLite FTS5 全文搜索，会话搜索，自动整合 | ✅ Pi 扩展+技能 |
| **`gentle-engram`** | 0.1.10 | alan_buscaglia | 8.6K/月 | 跨会话持久记忆，本地或云端共享 | ✅ Pi 扩展 |

#### 2.3.2 `pi-knowledge-search` 详解（最推荐）

```
pi install npm:pi-knowledge-search
```

这是与 WaPi 知识库检索需求**最匹配**的 Pi 扩展：

- **搜索架构**：混合向量相似度（cosine）+ BM25 全文（SQLite FTS5），Reciprocal Rank Fusion (k=60) 融合
- **嵌入模型**：OpenAI `text-embedding-3-small`、AWS Bedrock Titan、Ollama 本地模型、OpenAI 兼容 API
- **索引方式**：会话启动时增量索引（SHA-256 文件变更检测），支持文件监听
- **工具**：`knowledge_search(query, topK)` + `kb_read(reference)`（支持 `[[wikilink]]`、相对路径等）
- **注入**：会话启动时自动注入知识库概览（目录+关键词），让模型知道有什么可搜索
- **配置**：`~/.pi/knowledge-search.json`，可配置目录、扩展名、排除目录、嵌入Provider
- **存储**：索引文件约 5MB / 500个文件，纯本地，无外部依赖
- **性能**：搜索约 250ms，增量同步 ~12ms，全量构建 ~7s（500文件）

#### 2.3.3 `pi-code-graph` 详解（代码知识图谱）

```
pi install npm:pi-code-graph
```

为 Pi 提供**代码级 RAG 能力**：

- **架构**：Tree-sitter WASM（9语言解析）→ Memgraph 图数据库（Bolt协议）→ zvec HNSW 向量索引
- **工具**：`query_code_graph`（自然语言→Cypher→图查询）、`semantic_code_search`（向量相似度）、`analyze_code_dependencies`（调用关系+爆炸半径）、`get_code_from_graph`、`list_graph_projects`、`index_repository`
- **安全**：默认只读，索引需显式启用；Cypher 查询验证（禁止危险操作）
- **限制**：需 Docker 运行 Memgraph，较重；但功能非常强大

#### 2.3.4 WaPi 已安装依赖中的隐藏 RAG 能力

WaPi 当前使用的 `@amaster.ai/pi-memory`（v0.1.5）依赖了 `@amaster.ai/pi-memory-mem0`，后者又依赖 **[mem0ai](https://github.com/mem0ai/mem0)**（v3.1.0）——这是一个知名的开源记忆/RAG 库：

```
@amaster.ai/pi-memory
  └── @amaster.ai/pi-memory-mem0
       └── mem0ai (v3.1.0)
            ├── 支持向量数据库: Pinecone, Qdrant, ChromaDB, Milvus, Weaviate, Elasticsearch...
            ├── 支持嵌入模型: OpenAI, Cohere, HuggingFace, Gemini...
            └── 支持 LLM: OpenAI, Anthropic, Groq, Ollama...
```

**当前状态**：WaPi 仅使用了 `pi-memory` 的**文件型记忆功能**（MEMORY.md / USER.md），未启用 `mem0ai` 的向量记忆能力。这意味着 WaPi 底层**已有向量 RAG 的"基因"**，只是尚未激活！

#### 2.3.5 Pi 社区的 RAG 方向

- **GitHub Issue #1255**（[earendil-works/pi#1255](https://github.com/earendil-works/pi/issues/1255)）：提案采纳 OpenClaw 的 Memory/RAG 架构（已被关闭但方向明确）：SQLite-vec 向量搜索 + BM25 混合搜索 + 嵌入 Provider 抽象 + 会话索引。提案中描述的技术架构与 WaPi 的需求高度一致。
- **`pi-total-recall`** 元包：同时安装 `pi-knowledge-search` + 其他记忆工具的一站式方案

#### 2.3.6 结论：可直接复用，无需从零开发

基于以上调研，**WaPi 知识库检索功能的最佳路径已从"自研"转变为"集成 Pi 生态现有插件"**：

- **首选**：直接集成 `pi-knowledge-search`（最轻量、最匹配）
- **增强**：可选集成 `pi-code-graph`（代码级 RAG，需 Docker）
- **进阶**：激活 `@amaster.ai/pi-memory` 的 mem0ai 向量记忆能力

### 2.4 架构决策关键约束

1. **WaPi 是零外部依赖的桌面应用**：应避免强制用户安装 Docker、Python 环境或外部服务
2. **Bun 运行时**：内核运行在 Bun 上，所有依赖必须是 Node.js/Bun 兼容的纯 JS/TS 或带 native binding（但需考虑跨平台构建）
3. **Pi SDK 工具签名**：自定义工具必须符合 `ToolDefinition` 接口（TypeBox schema + `execute(toolCallId, params, signal)` → `{ content, details }`）

---

## 3. 技术方案对比

### 3.1 方案总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        知识库检索 RAG 流程                                │
│                                                                          │
│  文档源                   索引层                    检索层              │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐          │
│  │ 本地文件  │───▶│ 文档解析 + 分块   │───▶│ 向量化 (Embedding)│          │
│  │ 项目目录  │    │ (Markdown/Text/  │    │                  │          │
│  │ MCP 文档  │    │  Code/PDF/...)   │    │  方案1: OpenAI   │          │
│  │ URL 抓取  │    └──────────────────┘    │  方案2: 本地模型  │          │
│  │ API 导入  │              │             │  方案3: 远端服务  │          │
│  └──────────┘              ▼             └────────┬─────────┘          │
│                      ┌──────────────────┐         │                    │
│                      │   分块存储         │◀────────┘                    │
│                      │                  │                               │
│                      │  方案A: 内存     │                               │
│                      │  方案B: SQLite   │     ┌──────────────────┐      │
│                      │  方案C: LanceDB  │────▶│ 向量索引 + 搜索   │      │
│                      │  方案D: 外部向量DB│     │ (ANN/KNN)        │      │
│                      └──────────────────┘     └────────┬─────────┘      │
│                                                        │               │
│                                          ┌─────────────▼───────────┐   │
│                                          │  检索结果 → Agent 上下文  │   │
│                                          │  (system prompt 注入 /   │   │
│                                          │   工具调用返回文本)       │   │
│                                          └─────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 集成架构对比（五种方案）

---

#### 方案 1：MCP 知识库服务器（推荐 ⭐）

**思路**：对接已有的 RAG MCP 服务器，或将知识库检索能力封装为一个独立的 MCP 服务器进程。

```
┌──────────┐     WebSocket      ┌──────────┐     stdio/HTTP      ┌──────────────┐
│ Frontend │◀──────────────────▶│  Kernel   │◀──────────────────▶│ MCP KB Server│
│  (React) │                    │ (Bun/TS) │                    │ (Node/Python)│
└──────────┘                    └──────────┘                    └──────┬───────┘
                              已有 MCP 连接器                           │
                              (mcp-connector.ts)                 ┌─────▼──────┐
                                                                 │ 向量数据库  │
                                                                 │ 嵌入模型   │
                                                                 │ 文档解析   │
                                                                 └────────────┘
```

**优势：**
- ✅ **零内核改动**：WaPi 已有完整的 MCP 集成（连接、测试、配置管理、前端 UI）
- ✅ **技术栈自由**：MCP 服务器可用 Python（更丰富的 RAG 生态如 LangChain/LlamaIndex）、Node.js 或 Go
- ✅ **独立演进**：KB 功能可独立迭代，不影响内核稳定性
- ✅ **可插拔**：用户可选择不同的 KB 后端（本地 ChromaDB、远端 Pinecone 等），只需切换 MCP 服务器
- ✅ **已有前端**：MCP 的添加/测试/工具列举界面可直接复用

**劣势：**
- ❌ 需要用户额外安装/运行 MCP 服务器进程
- ❌ stdio 模式需管理子进程生命周期（WaPi 已有此能力）
- ❌ 跨进程通信有序列化开销（但向量检索的文本量不大，影响可忽略）

**技术选型（MCP 服务器侧）：**
- 向量数据库：ChromaDB（嵌入式）、LanceDB（嵌入式、Node.js 原生）、FAISS
- 嵌入模型：OpenAI `text-embedding-3-small`（高质量）、本地 BGE-M3 / GTE（离线）、Jina AI（免费额度）
- RAG 框架：LangChain / LlamaIndex（Python）、LangChain.js（Node.js）

**WaPi 内核改动：**
- **无**。只需在 MCP 设置中添加服务器配置（command + args 或 url）。

---

#### 方案 2：内核内置知识库工具（customTools）

**思路**：仿照 `memory_*` 工具，在 `agent-manager.ts` 中直接注册知识库检索工具。

```
┌──────────────────────────────────────────────────────────────┐
│                        Kernel Process                        │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ AgentManager   │  │ kb_search Tool   │  │ 向量数据库    │ │
│  │ customTools:   │──▶ (TypeBox schema) │──▶ (LanceDB/    │ │
│  │  kb_search     │  │ kb_index Tool    │  │  SQLite-vec) │ │
│  │  kb_index      │  │ kb_list Tool     │  │              │ │
│  └────────────────┘  └──────────────────┘  └──────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**优势：**
- ✅ 用户体验最好：零配置、开箱即用
- ✅ 内核直接管理生命周期，无需子进程
- ✅ 可与项目目录、记忆系统深度整合

**劣势：**
- ❌ 内核体积膨胀：需引入嵌入模型、向量数据库依赖
- ❌ Bun 兼容性风险：部分 native binding（如 `better-sqlite3`、`hnswlib-node`）在 Bun 下可能有兼容问题
- ❌ 本地嵌入模型大：BGE-M3 约 2GB，用户首次使用需下载
- ❌ 内核代码复杂度显著增加

**技术选型（全 JS/TS，Bun 兼容）：**

| 组件 | 候选 | Bun 兼容性 |
|------|------|-----------|
| 向量数据库 | **LanceDB** (Node SDK `@lancedb/lancedb`) | ✅ 纯 JS binding，有 Bun 兼容报告 |
| | SQLite-vec (`sqlite-vec`) | ⚠️ 需要 native addon，Bun 支持待验证 |
| 嵌入模型 | OpenAI API（远程） | ✅ 无本地依赖 |
| | Transformers.js (`@xenova/transformers`) | ✅ 纯 JS，Bun 兼容，模型约 100-500MB |
| | Ollama 本地 API | ✅ HTTP 调用，无依赖 |
| 文档解析 | 自研（Markdown/Text/Code） | ✅ 纯 JS |

---

#### 方案 3：Pi 扩展（extension） — ⚡ 已有现成实现！

**思路**：将知识库检索打包为 NPM Pi 扩展，通过 WaPi 扩展系统安装。**关键发现：此方案已有社区成熟实现，无需从零开发！**

```
┌──────────┐  WebSocket  ┌──────────┐  additionalExtensionPaths  ┌───────────────────┐
│ Frontend │◀───────────▶│  Kernel   │◀─────────────────────────▶│ pi-knowledge-search│
│          │             │          │                            │  (已有 NPM 扩展)    │
└──────────┘             └──────────┘                            │ pi-code-graph     │
                         已有扩展系统                              │ (代码级 RAG)       │
                         (extensions.ts)                          └───────────────────┘
```

**优势：**
- ✅ **已有成熟实现**：`pi-knowledge-search`（v1.3.5）直接可用，无需开发
- ✅ 可发布到 NPM，社区可贡献
- ✅ 独立版本管理，不污染内核
- ✅ WaPi 已有完整的扩展安装/启用/升级流程

**劣势（已大幅减弱）：**
- ⚠️ 需要通过 WaPi 的 NPM 扩展机制加载（extensions.ts 的 `buildAdditionalExtensionPaths` 已支持动态包）
- ⚠️ `pi-knowledge-search` 依赖的 `node:sqlite` FTS5 需要 Node 24+，Bun 内置 SQLite 需要验证 FTS5 支持
- ⚠️ 远端嵌入 API（OpenAI）需要网络和 API Key

---

#### 方案 4：外部向量数据库服务（SaaS）

**思路**：使用 Pinecone、Qdrant Cloud、Weaviate Cloud 等 SaaS 向量数据库，通过 REST API 调用。

```
┌──────────┐  WebSocket  ┌──────────┐  REST API  ┌──────────────┐
│ Frontend │◀───────────▶│  Kernel   │◀──────────▶│ Pinecone     │
│          │             │ customTool│            │ Qdrant Cloud │
└──────────┘             └──────────┘            │ Weaviate     │
                                                  └──────────────┘
```

**优势：**
- ✅ 生产级性能和可用性
- ✅ 免运维
- ✅ 内核只需 HTTP 调用，改动最小

**劣势：**
- ❌ 外部依赖：需要注册云服务、管理 API Key
- ❌ 成本：按量计费，大规模使用费用高
- ❌ 数据隐私：知识库内容上传到第三方
- ❌ 网络依赖：离线环境不可用
- ❌ 延迟：网络往返比本地慢

---

#### 方案 5：混合方案（MCP + 本地嵌入）

**思路**：MCP 服务器作为架构壳，内部使用本地嵌入模型 + 嵌入式向量数据库，兼顾零运维和灵活性。

```
┌──────────┐  WebSocket  ┌──────────┐  stdio  ┌─────────────────────┐
│ Frontend │◀───────────▶│  Kernel   │◀───────▶│ MCP KB Server (Bun) │
│          │             │ (零改动)  │         │  - LanceDB 本地存储  │
└──────────┘             └──────────┘         │  - OpenAI/本地嵌入   │
                                               │  - 文档分块/解析     │
                                               └─────────────────────┘
```

**优势：**
- ✅ 兼具方案 1 的架构清晰和方案 2 的零外部依赖
- ✅ 内核改动几乎为零
- ✅ MCP 服务器可用 Bun 编写（与 WaPi 同技术栈）
- ✅ 可渐进式增强（先 OpenAI 嵌入，后加本地模型）

**劣势：**
- ❌ 仍然是独立进程，有进程管理开销
- ❌ 嵌入模型大小限制（本地模型 > 1GB）

---

### 3.3 方案对比矩阵

| 维度 | 方案1 MCP | 方案2 customTools | 方案3 Pi扩展 | 方案4 SaaS | 方案5 混合 |
|------|:---------:|:------------------:|:------------:|:----------:|:----------:|
| **内核改动量** | 🟢 零 | 🔴 大（~2000行） | 🟡 中（~500行注册） | 🟢 小（~300行） | 🟢 零 |
| **用户体验** | 🟡 需配置MCP | 🟢 开箱即用 | 🟡 需安装扩展 | 🟡 需注册服务 | 🟡 需配置MCP |
| **离线可用** | 🟡 取决于服务器 | 🟢 可离线 | 🟢 可离线 | 🔴 不可 | 🟢 可离线 |
| **技术自由度** | 🟢 任意语言 | 🔴 限Bun/TS | 🔴 限Bun/TS | 🟢 API无关 | 🟢 任意语言 |
| **运维复杂度** | 🟡 管理子进程 | 🟢 无额外进程 | 🟢 无额外进程 | 🟢 托管服务 | 🟡 管理子进程 |
| **数据隐私** | 🟢 本地 | 🟢 本地 | 🟢 本地 | 🔴 上传云端 | 🟢 本地 |
| **社区生态** | 🟢 可用现有MCP | 🔴 需自研 | 🟡 需开发 | 🟢 成熟SaaS | 🟢 自研灵活 |
| **开发周期** | 🟢 1-2周 | 🔴 4-6周 | 🟡 3-4周 | 🟢 1-2周 | 🟢 2-3周 |
| **可移植性** | 🟢 MCP标准 | 🟡 WaPi专用 | 🟡 Pi生态 | 🟢 标准API | 🟢 MCP标准 |

---

## 4. 推荐方案与理由

### 4.1 推荐：方案 3+1 组合（直接集成 `pi-knowledge-search` 作为 Pi 扩展 + MCP 作为补充）⭐

**🍺 调研最大发现：Pi 生态已有成熟的 `pi-knowledge-search` 扩展，WaPi 可直接集成，无需从零开发！**

#### 第一阶段（立即可用，1-3 天）
**直接集成 `pi-knowledge-search` 作为 WaPi 的内置 Pi 扩展：**

1. 在 `kernel/package.json` 添加依赖：`"pi-knowledge-search": "^1.3.5"`
2. 在 `extensions.ts` 的 `PKG_EXTENSIONS` 中追加 `"pi-knowledge-search"`
3. 在 `DEFAULT_AGENT_TOOLS` 中添加 `"knowledge_search"` 和 `"kb_read"`
4. 编写使用文档

这样 WaPi agent 立即获得：
- `knowledge_search(query, topK)` — 混合向量+BM25 语义搜索
- `kb_read(reference)` — 按 wikilink/路径读取全文
- 会话启动自动注入知识库概览
- 增量索引，无需额外进程

#### 第二阶段（可选增强，1-2 周）
根据用户反馈选择性增强：
- 编写 WaPi 前端知识库配置 UI（复用 MCP 配置界面模式）
- 验证 Bun 内置 SQLite FTS5 兼容性（`pi-knowledge-search` 要求 Node 24+ 的 `node:sqlite`）
- 如 Bun SQLite 不兼容则走 MCP 封装路径（将 `pi-knowledge-search` 包装为 MCP 服务器）
- 可选：集成 `pi-code-graph` 提供代码级 RAG（需 Docker）

### 4.2 推荐理由（基于调研修正）

1. **最小工作量**：`pi-knowledge-search` 是成熟的 Pi 扩展（v1.3.5），已解决：
   - 文档解析+分块
   - 向量嵌入（OpenAI/Ollama/Bedrock）
   - 混合搜索（向量+BMS25+RRF融合）
   - 增量索引
   - 工具注册
   
   WaPi 只需**添加一行依赖 + 一行扩展注册 + 两行工具放行**。

2. **架构天然兼容**：`pi-knowledge-search` 是 Pi 扩展，WaPi 已有完整的 Pi 扩展加载机制（`extensions.ts`、`resolveAgentTools`、`buildAdditionalExtensionPaths`），无缝接入。

3. **社区验证**：该插件已有用户基础和 GitHub 仓库（MIT 许可证），非实验性项目。

4. **兜底方案**：如果 Bun SQLite FTS5 不兼容，可将 `pi-knowledge-search` 包装为 stdio MCP 服务器（同样零内核改动），退回到原方案 1 的路径。

5. **WaPi 已有隐藏能力**：`@amaster.ai/pi-memory` 底层依赖的 `mem0ai`（v3.1.0）本身支持 Pinecone/Qdrant/ChromaDB 等 20+ 向量数据库，未来可激活作为增强路径。

---

## 5. 第二阶段详细设计（wa-pi-kb-mcp）

### 5.1 工具定义

```typescript
// MCP 工具注册（wa-pi-kb-mcp 内部）
const tools = [
  {
    name: "kb_search",
    description: "在知识库中语义搜索相关内容。返回最相关的文档片段及其来源文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言搜索查询" },
        topK: { type: "integer", description: "返回结果数，默认5", default: 5 },
        source: { type: "string", description: "按来源过滤（可选）" },
      },
      required: ["query"],
    },
  },
  {
    name: "kb_index",
    description: "将文件或目录加入知识库索引。支持 .md/.txt/.json/.yaml/.ts/.py 等文本格式。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "本地文件或目录的绝对路径" },
        recursive: { type: "boolean", description: "是否递归索引子目录", default: true },
        glob: { type: "string", description: "文件匹配模式，如 '**/*.md'" },
      },
      required: ["path"],
    },
  },
  {
    name: "kb_list_sources",
    description: "列出知识库中已索引的来源清单及统计信息。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "kb_remove",
    description: "从知识库中移除指定来源的索引。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "已索引的路径" },
      },
      required: ["path"],
    },
  },
];
```

### 5.2 嵌入模型选择（2026 年最新对比）

#### 5.2.1 国内 Embedding API（直接调用）

对于不想折腾本地模型的用户，国内大厂已提供成熟的 Embedding API：

| 厂商 | 模型 | 维度 | 价格（每百万 Token） | 中文 | 上下文 | 备注 |
|------|------|------|---------------------|------|--------|------|
| **智谱 (Zhipu)** | `embedding-3` | 最高4096(可调) | ¥0.5 | ✅ | 8K | 支持自定义维度，按需降维省存储 |
| **阿里通义 (Qwen)** | `tongyi-embedding-vision-plus` | 1152 | 按量计费 | ✅ | 1K | 支持图文混合向量化 |
| **阿里开源** | `Qwen3-Embedding-8B` | 4096 | 免费(自部署) | ✅⭐ | 32K | **MTEB 多语言排名第1**，中文最强 |
| **讯飞星火** | `embedding` | 未公开 | 按量计费 | ✅ | — | 集成于星火大模型生态 |
| **火山方舟** | 多模态向量化 | 可配 | 按量计费 | ✅ | — | 支持图文音视频多模态向量化 |
| **百度千帆** | `Embedding-V1` | 1024 | 按量计费 | ✅ | 512 tokens | 百度生态集成 |

**推荐国内 API**：智谱 `embedding-3` — 价格最低（¥0.5/百万 Token），质量可靠，且 `pi-knowledge-search` 已通过 OpenAI 兼容接口支持。

#### 5.2.2 本地小模型（轻量离线部署）

如果不想依赖任何云服务或担心数据隐私，以下本地模型可通过 **Ollama** 直接运行：

| 模型 | 大小 | 维度 | 中文 | 速度 (CPU) | 适用场景 |
|------|------|------|------|------------|---------|
| **BAAI/bge-small-zh-v1.5** ⭐ | **~90MB** | 512 | ✅ | 极快 | 🔋 最轻量，适合笔记本/低配机器 |
| **BAAI/bge-base-zh-v1.5** | ~400MB | 768 | ✅ | 快 | 中文 RAG 轻量首选 |
| **BAAI/bge-large-zh-v1.5** | ~1.3GB | 1024 | ✅ | 中等 | 高质量中文向量 |
| **BAAI/bge-m3** | ~2.2GB | 1024 | ✅ | 中等 | 🏆 全能旗舰：100+语言、稠密+稀疏混合检索 |
| **GTE-small** (阿里) | ~130MB | 384 | ✅ | 极快 | 极限轻量，嵌入式设备 |
| **GTE-base** (阿里) | ~440MB | 768 | ✅ | 快 | 阿里系中文场景 |
| **GTE-large** (阿里) | ~1.3GB | 1024 | ✅ | 中等 | 高质量通用向量 |
| **M3E-base** (MokaAI) | ~440MB | 768 | ✅ | 快 | 国内社区热门，中文微调 |
| **M3E-large** (MokaAI) | ~1.3GB | 1024 | ✅ | 中等 | 高精度中文 |
| **nomic-embed-text** | ~270MB | 768 | ⚠️ | 快 | 英文为主，中文尚可 |
| **mxbai-embed-large** | ~670MB | 1024 | ⚠️ | 快 | MTEB 高分，偏英文 |

#### 5.2.3 Ollama 一条命令部署本地模型

```bash
# 安装 Ollama（macOS）
brew install ollama

# 拉取模型（首次自动下载）
ollama pull bge-m3              # 2.2GB，全能旗舰，中英文均佳
ollama pull bge-small-zh-v1.5   # 90MB，超轻量中文模型
ollama pull shaw/dmeta-embedding-zh  # 社区中文优化版

# 验证可用
curl http://localhost:11434/api/embed -d '{
  "model": "bge-m3",
  "input": "如何搭建知识库检索系统？"
}'
```

#### 5.2.4 尺寸与质量权衡决策图

```
你的硬件环境？
├── 笔记本 / 8GB 内存 / 无 GPU
│   └── bge-small-zh-v1.5 (90MB, 512维) 或 GTE-small (130MB, 384维)
│       优点：秒级加载，CPU 推理毫秒级
│       缺点：精度略低于大模型
│
├── 台式机 / 16GB+ / 无 GPU
│   └── bge-base-zh-v1.5 (400MB, 768维) 或 M3E-base (440MB)
│       优点：精度明显优于 small 系列，CPU 流畅
│
├── 台式机 / 32GB+ / 有 GPU (8GB+)
│   └── bge-m3 (2.2GB, 1024维) 或 Qwen3-Embedding-8B (16GB)
│       优点：顶级精度，稠密+稀疏混合检索
│
├── 需要云 API（零本地资源）
│   └── 智谱 embedding-3 (¥0.5/百万Token) 或 OpenAI text-embedding-3-small ($0.02)
│       优点：零部署、零显存、质量有保证
│
└── 纯中文 + 最高精度
    └── Qwen3-Embedding-8B（自部署，4096维，MTEB#1）
        优点：中文场景的 SOTA
        缺点：8B 参数，需 GPU 16GB+
```

#### 5.2.5 `pi-knowledge-search` 已支持的全部嵌入 Provider

`pi-knowledge-search` 内置支持以下嵌入源，无需额外开发：

- **OpenAI**：`text-embedding-3-small` / `text-embedding-3-large`
- **Ollama**：任意本地模型（bge-m3, bge-small-zh-v1.5, nomic-embed-text 等）
- **AWS Bedrock**：Titan Embedding
- **OpenAI 兼容**：任意兼容 `/v1/embeddings` 端点的服务（智谱、阿里百炼、火山方舟等国内厂商均兼容）

这意味着用户可以根据自己的隐私需求和硬件条件，自由选择嵌入方案，WaPi 只需做好配置引导即可。

**推荐默认**（按优先级降级）：
1. 检测到网络 → OpenAI `text-embedding-3-small`（$0.02/百万 Token ≈ 几乎免费）
2. 国内网络受限 → 智谱 `embedding-3`（¥0.5/百万 Token，OpenAI 兼容协议）
3. 无网络/隐私优先 → Ollama + `bge-small-zh-v1.5`（90MB，CPU 即可）
4. 高精度需求 → Ollama + `bge-m3`（2.2GB，1024维，混合检索）

### 5.3 向量数据库选择

| 数据库 | 嵌入方式 | Bun 兼容 | 规模 | 推荐 |
|--------|---------|---------|------|------|
| **LanceDB** | 嵌入式（文件） | ✅ 官方 Node SDK | 百万级 | ⭐ 首选 |
| SQLite-vec | 嵌入式（SQLite 扩展） | ⚠️ native addon | 十万级 | 备选 |
| ChromaDB | 独立进程 | ✅ HTTP API | 百万级 | Python 生态 |
| Qdrant | 独立进程/云 | ✅ HTTP API | 亿级 | 企业级 |
| FAISS | 嵌入式 | ❌ Python only | 亿级 | 不适合 |

**推荐**：LanceDB——嵌入式、零运维、Bun 兼容、性能优秀。与 WaPi "零外部依赖" 的设计哲学一致。

### 5.4 文档处理流程

```
文件/目录
  │
  ▼
┌─────────────┐
│ 文件发现      │  glob 匹配，过滤二进制/大文件
│ (glob/grep)  │  支持 .md .txt .json .yaml .ts .tsx .py .go .rs ...
└──────┬──────┘
       ▼
┌─────────────┐
│ 文档解析      │  Markdown → 保留标题层级作为元数据
│ (parser)     │  代码 → 按函数/类边界分块，保留 import 作为上下文
│              │  纯文本 → 按段落分块
└──────┬──────┘
       ▼
┌─────────────┐
│ 智能分块      │  目标: 512 tokens/chunk, 128 tokens overlap
│ (chunker)    │  Markdown: 按 ## 标题分割
│              │  代码: 按函数/类边界（tree-sitter/正则）
│              │  文本: 按段落 + 滑动窗口
└──────┬──────┘
       ▼
┌─────────────┐
│ 向量嵌入      │  调用嵌入 API（OpenAI / Ollama / Jina）
│ (embedder)   │  批量请求，指数退避重试
└──────┬──────┘
       ▼
┌─────────────┐
│ 索引存储      │  LanceDB Table: (id, vector, text, metadata, sourcePath)
│ (indexer)    │  增量索引：文件 mtime 变更检测，自动更新
└──────────────┘
```

### 5.5 与 WaPi 的集成接口

MCP 服务器通过 stdio 与 WaPi 通信，配置示例：

```json
{
  "name": "wa-pi-kb",
  "command": "bun",
  "args": ["x", "wa-pi-kb-mcp"],
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}",
    "KB_DATA_DIR": "~/.wa-pi/knowledge-base"
  }
}
```

前端 MCP 管理界面（McpPage/McpForm）无需改动即可管理此服务器。

---

## 6. 实施路线图（基于 Pi 生态调研修正）

```
Phase 0 (1-3 天) ─── 直接集成 pi-knowledge-search ⚡ 最快路径
  ├── kernel/package.json 添加依赖 "pi-knowledge-search": "^1.3.5"
  ├── extensions.ts PKG_EXTENSIONS 追加 "pi-knowledge-search"
  ├── constants.ts DEFAULT_AGENT_TOOLS 追加 "knowledge_search" + "kb_read"
  ├── 验证 Bun SQLite FTS5 兼容性
  ├── 前端：确认 AgentConfig 工具列表中能看到新工具
  └── 验收：agent 可调用 knowledge_search 搜索知识库

Phase 0B (备选，1-2 天) ─── Bun SQLite 不兼容时的 MCP 兜底
  ├── 将 pi-knowledge-search 包装为 stdio MCP 服务器
  ├── 通过 WaPi MCP 界面配置
  └── 内核零改动，但走 MCP 通道

Phase 1 (1-2 周) ─── 集成验证与优化
  ├── 编写 WaPi 知识库配置文档（~/.wa-pi/knowledge-search.json）
  ├── 验证 OpenAI / Ollama / 本地嵌入等各 provider
  ├── 前端：可选增加知识库管理面板（复用 McpPage 模式）
  ├── 集成测试 + E2E 测试
  └── CHANGELOG + 发布说明

Phase 2 (可选，1-2 周) ─── 增强
  ├── 可选集成 pi-code-graph（代码级 RAG，需 Docker）
  ├── 激活 mem0ai 向量记忆（@amaster.ai/pi-memory 已安装）
  ├── 多项目知识库隔离
  └── 前端知识库概览仪表盘
```

---

## 6b. 特殊场景：Word 文档 + 图片的知识库检索

### 6b.1 问题描述

很多团队有大量 `.docx` 格式的文档（技术规范、设计文档、会议纪要等），里面嵌入了截图、架构图、流程图等图片。`pi-knowledge-search` 原生只支持 `.md` 和 `.txt`。如何处理？

### 6b.2 三步处理方案

```
Word 文档 (.docx)
      │
      ▼
 Step 1: 文档转换（docx → markdown）
      │
      ├── 推荐: mammoth (Node.js 库, npm install mammoth)
      │         docx → HTML → Markdown, 提取嵌入图片到本地文件
      │         纯 JS，Bun 兼容 ✓
      │
      ├── 备选: pandoc (命令行工具, 需系统安装)
      │         docx → markdown + 图片提取到 media/ 目录
      │         功能最强，支持格式最多
      │
      └── AI 方案: MarkItDown (Microsoft, Python)
                 LLM 辅助理解复杂排版，输出结构化 Markdown
      │
      ▼
 Step 2: 图片处理（二选一）
      │
      ├── 路径 A: 图片描述替换（轻量，推荐先用）
      │   用多模态 LLM (GPT-4V/Claude Vision/Qwen-VL) 为每张图生成文字描述
      │   "![架构图](images/arch.png)" → "[图片描述: 三层微服务架构，包含API网关...]"
      │   文本描述可被向量化 + 关键词搜索命中
      │
      └── 路径 B: 视觉嵌入索引（重，效果最好）
          用 ColPali/ColQwen2 等视觉语言模型直接对文档页面做嵌入
          不提取文字，直接理解"页面长什么样"
          适合图表、手绘图、复杂排版等文字提取困难的场景
      │
      ▼
 Step 3: 索引入库
      转换后的 .md 文件 + 图片描述文本 → pi-knowledge-search 混合搜索
```

### 6b.3 路径 A：图片描述替换（实用、落地快）

```bash
# 1. 用 pandoc 批量转换 Word → Markdown（含图片提取）
pandoc input.docx -t markdown --extract-media=./images -o output.md

# 输出：
# output.md       ← Markdown 正文，图片引用为 ![](images/image1.png)
# images/         ← 提取出的嵌入图片
```

```typescript
// 2. Node.js 脚本：用多模态 LLM 为图片生成文字描述
import mammoth from "mammoth";

// 用 mammoth 转换（纯 JS，Bun 兼容）
const result = await mammoth.convertToMarkdown({
  path: "input.docx",
  convertImage: mammoth.images.imgElement(async (image) => {
    // 将嵌入图片保存到文件，然后用 VLM 生成描述
    const buffer = await image.read();
    const desc = await describeImageWithVLM(buffer); // 调 OpenAI Vision / Qwen-VL
    return { src: `images/${image.contentType.split("/")[1]}`, alt: desc };
  }),
});
```

**VLM 图片描述成本估算**：
- GPT-4V: ~$0.01/张（低分辨率）
- Qwen-VL（阿里，国内可访问）: ~¥0.003/张
- 本地 LLaVA/Ollama 视觉模型: **免费**

### 6b.4 路径 B：视觉嵌入（前沿方案）

不解析文档文本，直接用视觉语言模型对**渲染后的页面图像**做嵌入：

```
Word 文档 → 渲染为页面图像 (PNG)
                │
                ▼
         ColPali / ColQwen2 视觉嵌入模型
         (将页面图像直接编码为向量)
                │
                ▼
         向量数据库 (LanceDB / Qdrant)
                │
                ▼
         用户查询 → 相似页面检索 → 返回原始页面图像 + 文本
```

**适用场景**：图表密集的文档、扫描件、手写笔记、复杂排版（PPT 导出等）。

**缺点**：ColPali 模型约 1.2GB，需要 GPU 或较强 CPU。不如路径 A 轻量。

### 6b.5 Pi 生态已有方案

惊喜发现：Pi 生态已有 **`pi-docparser`** 扩展（[pi.dev/packages/pi-docparser](https://pi.dev/packages/pi-docparser)），专门提供本地文档理解工具：

```
pi install npm:pi-docparser
```

提供的能力（来自 pi.dev 描述）：
- 解析多种文档格式（PDF、Word、PPT 等）
- 注册 `parse_document` 工具供 agent 调用
- 配套 `parse-document` 技能引导 agent 如何用

可以结合使用：`pi-docparser` 负责文档解析 + `pi-knowledge-search` 负责语义检索。

### 6b.6 推荐策略（按优先级）

| 场景 | 推荐方案 | 工作量和效果 |
|------|---------|------------|
| **Word 纯文字为主** | mammoth/pandoc 转 md → pi-knowledge-search 直接索引 | 🟢 零开发，直接可用 |
| **Word 含少量图片** | pandoc 提取图片 + VLM 生成描述文本 → pi-knowledge-search 索引 | 🟡 1-2 天写转换脚本 |
| **Word 大量图表/截图** | 路径 A（描述替换）先用；如不够再加路径 B（视觉嵌入） | 🟡→🔴 渐进增强 |
| **PDF/PPT 等更多格式** | 集成 `pi-docparser` 扩展 + pi-knowledge-search | 🟢 Pi 扩展，即装即用 |

### 6b.7 实操建议

```bash
# 批量转换整个目录的 Word 文档（一行命令）
for f in *.docx; do
  pandoc "$f" -t markdown --extract-media="./images/$(basename "$f" .docx)" \
    -o "./md/$(basename "$f" .docx).md"
done

# 然后在 pi-knowledge-search 中索引 md/ 目录
# /knowledge-search-setup → 选 md/ 目录 → 完成
```

---

## 7. 风险评估（更新）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **Bun 内置 SQLite 不支持 FTS5** | 中 | 中 | `pi-knowledge-search` 要求 Node 24+ 的 `node:sqlite`；Bun 内置 `bun:sqlite` 的 FTS5 支持需验证。若不兼容，走 MCP 兜底方案（Phase 0B），将 pi-knowledge-search 包装为独立 Node 进程的 MCP 服务器 |
| pi-knowledge-search 与 Pi SDK 版本不兼容 | 低 | 中 | WaPi 使用 `@earendil-works/pi-coding-agent@^0.80.0`，pi-knowledge-search v1.3.5 peerDependencies 需确认；通常 Pi 扩展向后兼容 |
| 嵌入 API 费用 | 中 | 低 | 默认用 OpenAI text-embedding-3-small（$0.02/1M tokens ≈ 几乎免费），支持本地 Ollama 降级 |
| pi-knowledge-search 停止维护 | 低 | 高 | MIT 许可证，可 fork 维护；或退回 MCP 自研路径 |

---

## 8. 总结

**🍺 核心结论：Pi 生态已有轮子，不用自己造！**

> 调研前以为需要从零开发一套 RAG 系统（方案 1-5），调研后发现 Pi 生态的 `pi-knowledge-search` 已经完美覆盖需求。

- **最佳路径**：直接集成 `pi-knowledge-search` 作为 WaPi 内置 Pi 扩展 —— 添加 1 个依赖 + 2 行代码 + 2 个工具名，**1-3 天即可上线**。
- **兜底路径**：如果 Bun SQLite FTS5 不兼容，将该扩展包装为 MCP 服务器，走 WaPi 已有 MCP 通道，同样内核零改动。
- **生态佐证**：Pi 官方市场有 5343 个包，其中 6+ 个直接命中 RAG/知识库检索需求，社区活跃度高。GitHub Issue #1255 表明官方也在关注 RAG 架构。
- **隐藏资产**：WaPi 已安装的 `@amaster.ai/pi-memory` 底层依赖 mem0ai（支持 20+ 向量数据库），未来可激活为更强大的记忆方案。
