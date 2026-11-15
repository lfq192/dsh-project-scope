# dsh-project-scope

**以「项目」为中心的 DeepSeek Harness 工作区隔离插件。**

一次任务 = 一个项目目录。智能体只在那个目录里读写；过程脚本和最终交付物分开放；
**上一次任务的内容不会被下一次自动带进上下文**。

```
你的工作区/
  projects/
    数据库课程作业/
      inputs/         参考文档、原始素材（输入，只读语义）
      work/           过程脚本、探查代码、中间产物（不是交付）
      deliverables/   最终交付物（present 只允许这里）
      PROJECT.md      项目清单：目标、创建时间、素材、交付记录
    第二次作业/
      ...
  .dsh/project-scope.json   每个会话的活跃项目（插件自动维护）
```

---

## 为什么

DSH 默认把整个工作区暴露给智能体：开工前先扫一遍工作区，探查脚本随手丢在根目录，
交付物和临时文件混在一起。做第二次作业时，上一次的产物还在视野里 —— 既占上下文，
也容易串味。

这个插件把「一次任务」变成一个可寻址的目录，然后用守卫把智能体的读写夹在里面。

---

## 安装

### 方式 1：让智能体装（推荐）

把这句话发给你的 DSH 智能体：

```
帮我装一个 DSH 插件：从 https://github.com/lfq192/dsh-project-scope 安装 bundle，
用 plugin_manager action=install_bundle target=github:lfq192/dsh-project-scope，
装完告诉我工具名、/project 命令和第一件该做的事。
```

### 方式 2：手动

在 DSH 里（或让智能体代跑）：

```
plugin_manager  action=install_bundle  target=github:lfq192/dsh-project-scope
```

也可以给本地路径（必须绝对路径）：

```
plugin_manager  action=install_bundle  target=C:\path\to\dsh-project-scope
```

安装是 live 的 —— 当前会话立刻生效，不需要重启。

---

## 用起来

### 开工第一句

```
project  action="create"  name="数据库课程作业"  goal="参考文档写 MySQL 代码 + 数据库设计文档"  inputs=["参考资料/需求说明.docx"]
```

建好 `inputs/`、`work/`、`deliverables/` 和 `PROJECT.md`，参考文档会被复制进 `inputs/`，并切为活跃项目。

### 工具：`project`

| action | 作用 |
| --- | --- |
| `create` | 新建项目（`name`、`goal`、可选 `inputs`），建三个目录 + `PROJECT.md`，切为活跃项目 |
| `use` | 切换到工作区里已有的项目（仅共享工作区模式） |
| `list` | 列出工作区里的项目 |
| `status` | 活跃项目的三个目录、已交付文件、工作区根目录的散落脚本 |
| `deliver` | 把文件移进 `deliverables/`（`present` 之前必须先做这一步） |
| `sweep` | 把工作区根目录的脚本类文件收进 `work/_stray/`，并写 `MOVED.md` |
| `workspace` | 把项目目录登记成独立 DSH 工作区（升级成宿主级隔离） |
| `reset` | 清除活跃项目，下一项任务重新 `create` |

### 斜杠命令：`/project`

```
/project                       查看活跃项目与交付物
/project new <名称> [| 目标]    新建并切换项目
/project use <名称>            切换项目
/project list                  列出项目
/project done <文件…>          归入交付目录
/project sweep                 收拢根目录散落脚本
/project workspace             登记为独立 DSH 工作区
/project reset                 清除活跃项目
```

### 收工

```
project  action="deliver"  files=["work/schema.sql", "work/数据库设计文档.md"]
present  files=[{path:"projects/数据库课程作业/deliverables/schema.sql"}]
```

`present` 只认 `deliverables/` 里的文件 —— 过程脚本不会被当成交付物递出去。

---

## 两道隔离，按需选

### A. 共享工作区（零配置，插件强制）

会话的 cwd 仍是工作区根目录。活跃项目按 sessionId 记在 `.dsh/project-scope.json`，
插件用 `tools/pre-execute` 守卫把读写夹到活跃项目内：

1. **写作用域** —— `write` / `edit` 落到项目外被拒，并指出该去 `work/` 还是 `deliverables/`；
2. **跨项目读隔离** —— 读 / 检索命中别的项目目录被拒；
3. **检索必须收窄** —— `glob` / `grep` / 读目录若覆盖到兄弟项目（含工作区根、`projects/` 根），
   拒绝并要求把 `path` 收窄到活跃项目内；
4. **shell 引用拦截** —— `pwsh` 命令文本里出现别的项目路径、或 workdir 落在别的项目里，被拒；
5. **交付归位** —— `present` 的文件必须在 `deliverables/` 内。

新会话默认没有活跃项目 —— 此时**所有**项目都算「别人的项目」，读、检索全拒，
连 `write` 也拒（严格模式），逼着先 `create` 或 `use`。这就是「新作业不会翻上一次的成果」。

### B. 专用工作区（宿主级隔离，推荐长期项目）

```
project  action="workspace"
```

把项目目录登记成独立的 DSH 工作区。在 DSH 里打开它新建会话，`session.header.cwd` 就是项目目录 ——
沙箱的 `workspace-write` 边界天然等于项目边界，隔离由宿主完成，不依赖守卫。
插件识别 cwd 里有 `PROJECT.md` 的会话，自动把它当作活跃项目。

> 为什么不在插件里改写沙箱根：`sandboxPolicy` 的 workspace-write 边界来自 `session.header.cwd`，
> 只有让 cwd 指向项目目录，隔离才是真的。

---

## 配置

插件不导出 `Config`（避免 schemastery 依赖），配置项写在 `cordis.patch.yml` 的插件行里，
插件内部用默认值合并：

```yaml
- insert:
    - id: project-scope
      name: dsh-project-scope
      config:
        projectsSubdir: projects
        enforceWriteScope: true
        requireProjectForWrites: true    # 没有活跃项目时连 write/edit 都拒绝（默认开）
        sweepOnCreate: false             # true = create 时顺带收拢根目录散落脚本
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `projectsSubdir` | `projects` | 项目根目录（相对工作区） |
| `stateFile` | `.dsh/project-scope.json` | 活跃项目状态文件 |
| `inputsDir` | `inputs` | 参考素材目录 |
| `workDir` | `work` | 过程脚本目录 |
| `deliverablesDir` | `deliverables` | 交付物目录 |
| `manifestFile` | `PROJECT.md` | 项目清单文件名 |
| `toolName` | `project` | 工具名 |
| `commandName` | `project` | 命令名 |
| `enforceWriteScope` | `true` | 写作用域强制 |
| `enforceReadIsolation` | `true` | 跨项目读隔离 |
| `requireScopedSearch` | `true` | 目录级检索必须收窄 |
| `enforceDeliverables` | `true` | `present` 只接受 `deliverables/` 内文件 |
| `requireProjectForWrites` | `true` | 严格模式：无活跃项目时拒绝 `write` / `edit` |
| `injectPrompt` | `true` | 注入 `<project-scope>` 提示词段 |
| `sweepOnCreate` | `false` | 创建项目时自动收拢散落脚本 |
| `strayPreviewLimit` | `6` | 提示词里最多列几个散落文件 |

---

## 提示词段

每个 agent 会拿到一段 `<project-scope>` 系统提示（挂在 `PLAN_POLICY` 之后），内容随活跃项目变化：
工作区路径、三个目录、6 条硬性规则、根目录散落脚本提醒。缓存由 `session/event` 与
`tools/result` 刷新，`section.text` 是同步函数，只读缓存。

---

## 自测

```powershell
node test/harness.mjs
```

用最小 mock ctx 驱动 `apply()`，在临时目录里跑完整生命周期，**32 项断言全通过**：
建项目 / 复制素材 / 提示词段 / 写作用域 / 无活跃项目时拒写 / 兄弟项目读隔离 / 检索收窄 /
`deliver` 的三种路径写法 / `present` 归位 / `sweep` / `status` / `list` / `reset` / 命令处理器。

---

## 已知边界

- 守卫挂在 `tools/pre-execute`，覆盖 `write` / `edit` / `read` / `glob` / `grep` / `present` /
  `pwsh` / `bash`；`pwsh` 里的任意路径写入只能靠命令文本与 workdir 做启发式判断，不是强隔离。
  **要强隔离请用方式 B。**
- 共享工作区模式下，散落脚本收拢是显式动作（`sweep`）或开关（`sweepOnCreate`），不会自动搬动你的文件。
- `dedicated` 模式（cwd 就是项目目录）下不允许 `use` 切换项目 —— 换项目请换工作区。

---

## 开发这个插件

想让智能体从零重做一个同样的插件？用 **[docs/AGENT-PROMPT.md](docs/AGENT-PROMPT.md)** 里的提示词 ——
里面写清了要读哪些宿主源码、几个必踩的坑（ESM 缓存、BOM、`undefined` 值不是 lossless JSON），
以及验收标准。

想直接看实现：**[lib/index.js](lib/index.js)**（约 1200 行，带中文注释，说明每一层为什么这么写）。

## License

MIT
