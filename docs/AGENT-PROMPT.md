# 用智能体从零做一个 DSH 插件

这份文档是一段**可以直接粘给智能体的提示词**，加上它需要知道的宿主事实。

目标不是「复刻 dsh-project-scope」，而是让你能对着任意一个「我想让 DSH 这样工作」的想法，
让智能体自己把插件写出来、装上、验完。

---

## 零、如果你要的正是「项目隔离」这件事

不必读完全文 —— 把下面这段原样粘给智能体，它会做出和本仓库同类的东西：

> 我在用 DeepSeek Harness 工作，有两个具体痛点：
>
> 1. **开工前 DSH 会把我整个工作区读一遍**。工作区里堆着上一次任务留下的脚本和产物，
>    既占上下文，也容易把上一次的思路串进这一次。
> 2. **脚本散落在工作区根目录**。探查脚本、一次性命令、中间产物全丢在根目录，
>    不好管理；交付物和过程文件混在一起，`present` 时容易把过程脚本当成果递出去。
>
> 请做一个 DSH host 插件，做到：**以「项目」为中心，一次任务 = 一个项目目录**。
>
> 具体要求：
>
> - 在一个工作区下建 `projects/<项目名>/`，里面固定三个子目录：
>   `inputs/`（参考文档、原始素材，只读语义）、`work/`（过程脚本、中间产物）、
>   `deliverables/`（最终交付物），外加一个 `PROJECT.md` 记录目标、素材、交付记录。
> - 智能体的 `write` / `edit` 只能落在活跃项目内；落在外面的要被拒，并在拒绝文案里
>   告诉它该去 `work/` 还是 `deliverables/`。
> - 智能体读 / 检索时，**别的项目目录要被拒**。当会话还没有活跃项目时，
>   **所有**项目都算「别人的项目」—— 读、检索全拒，连写也拒，逼它先建项目。
>   这一条是「新作业不会翻上一次成果」的关键。
> - `glob` / `grep` / 读目录如果覆盖到了兄弟项目（包括工作区根、`projects/` 根），
>   要被拒并提示把 `path` 收窄到活跃项目内。
> - `present` 只接受 `deliverables/` 里的文件 —— 过程脚本不能被当成交付物递出去。
> - 提供一个工具（比如 `project`），action 至少覆盖：建项目（可带参考素材，建时复制进
>   `inputs/`）、切换项目、列出项目、查看状态、把文件归入交付目录、把工作区根目录的
>   散落脚本收进 `work/_stray/`、清除活跃项目。
> - 再提供同名斜杠命令 `/project`，让用户不用记 JSON。
> - 注入一段系统提示词，把当前项目路径、三个目录、硬性规则告诉智能体。
>
> 还有一个更强的模式要留出来：把项目目录登记成**独立的 DSH 工作区**，
> 这样 `session.header.cwd` 就是项目目录，沙箱的 `workspace-write` 边界天然等于项目边界，
> 隔离由宿主完成，不依赖守卫。
>
> 示例场景（验收要按这个跑一遍）：新建一个项目做数据库课程作业，
> 参考文档放进 `inputs/`，写 MySQL 代码和数据库设计文档，交付物只留这两样；
> 然后做第二次作业，**不再读上一次的任何东西**，新产物也不进上一次的 `deliverables/`。
>
> 不许把功能做小来「保守安全」：把上面这些行为都实现，副作用与边界写进 README 的
> 「已知边界」一节。下面第一节有宿主 API 的具体入口和必踩的坑。

---

## 一、复制这段给智能体

> 我要给 DeepSeek Harness（DSH）做一个 host 插件。**先不要写代码**，按下面的顺序来。
>
> **第 0 步：摸清环境**
> 1. 加载技能 `cordis-plugin-development`，把它列出的 references 全部读完（host-plugin / practices /
>    ui-plugin / user-actions / verification）。这是唯一权威的插件契约。
> 2. 确认宿主包目录：`C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\`
>    （约 300 个 `dsh-*` 包，都是可读的 ESM 源码，没有 .d.ts）。
> 3. 用 `cordis_inspect_list` + `cordis_inspect_query` 查你打算用的服务：`platform=host`，
>    `provider=Service` 传精确服务名拿完整契约；`provider=Event` 同理；`provider=Config` 读已装插件的
>    配置 schema；`provider=Tool` 看当前 agent 能调到哪些工具（这决定了 `tools.restrict()` 能写哪些名字）。
>
> **第 1 步：读参考实现，不要凭想象写**
> 按你要碰的扩展点，去读这几个包（都是完整实现，比文档准）：
> - `dsh-persona/lib/index.js` —— 最小 host 插件：`apply` + `inject` + `Config` + `systemPrompt.section()`。
> - `dsh-tool-present/lib/index.js` —— 注册一个工具的最小完整例子（含 `output.render`、`tools/result` 回写）。
> - `dsh-agent-instructions/lib/index.js` —— 按 agent 挂行为的范式（`agent/created` → `agent.ctx` →
>   `agent/pre-execute`），以及怎么给 agent 注入上下文消息。
> - `dsh-system-prompt/lib/index.js` —— `SECTION_ORDERS` / `CONTEXT_ORDERS` 顺序表，`section()` 的
>   遮蔽规则，assembly 怎么拼。
> - `dsh-tools/lib/index.js` —— `register()` / `restrict()` 的真实校验，`tools/pre-execute` 的
>   waterfall 调用点。
> - `dsh-sandbox-policy/lib/index.js` —— **重要**：`session.header.cwd` 就是 workspace-write 的边界。
>
> **第 2 步：说清设计再动手**
> 输出一段设计，必须回答：
> - 要解决的现象是什么，插件在哪一层介入（工具 / 提示词 / 守卫 / 沙箱 / UI）。
> - 每个扩展点对应哪个服务、哪个事件、哪个上下文（全局 `ctx` 还是 `agent.ctx`）。
> - 用户怎么用（工具名 + action 列表，或斜杠命令）。
> - 失败了会怎样（拒绝文案写什么，用户怎么自救）。
>
> **第 3 步：落地**
> 1. 在工作区里建包目录，写 `package.json`（含 `dsh.bundle.patch`、`dsh.compatibility.dshReleases`）、
>    `cordis.patch.yml`、实现文件、`README.md`。
> 2. 写一个 `test/harness.mjs`：用极简 mock ctx 驱动 `apply()`，在 `mkdtemp` 临时目录里跑完整生命周期，
>    每条断言一个 `check(label, condition, detail)`。**不要依赖宿主运行时**。
> 3. `node --check` 每个文件；跑 harness 到全绿。
> 4. 用 `plugin_manager action=install_bundle target=<绝对包目录>` 安装。
>
> **第 4 步：在真实运行时验证，不要只信 harness**
> 逐个扩展点验：工具出现在 `Tool.listTools` 里吗？提示词段进了 `systemPrompt.assemble()` 吗？
> 守卫真的拦住了吗（拿真实工具调用试，把拒绝原文贴出来）？命令 `/xxx` 能用吗？
>
> **第 5 步：交付**
> 把包目录复制进 `deliverables/`，SHA256 对比确认一致，写 `PROJECT.md` 的交付记录，
> 然后 `present`。
>
> 约束：
> - 不要手写 profile 的 `package.json` / `cordis.patch.yml`，不要在 `$DSH_HOME` 下建包，
>   不要在 profile 目录跑 `pnpm` —— 只用 `plugin_manager`。
> - 不要 append 新的 session 事件类型。
> - 不要为了「安全」把功能做小；把用户要的行为做全，边界写进 README 的「已知边界」。

---

## 二、智能体会踩的坑（提前告诉它）

### 1. ESM 模块缓存：改了代码不生效，换包名才生效

宿主按「包 specifier + 文件路径」缓存模块，**同一个包名下改代码永远不会重新求值**。
实测无效的手段：改 `index.js`、改 `main` 指向新文件、`set_plugin` 开关、`remove_bundle` +
`install_bundle` 重装、换实现文件名。

**唯一可靠做法**：把 `package.json` 的 `name`、`cordis.patch.yml` 的 `id` / `name` 一起换成新值，
再 `install_bundle`。

判断是否命中缓存：在实现里临时改一句工具 `description`，用 `cordis_inspect_query`
（`provider=Tool`）看返回的是不是新文案。

### 2. 写 `package.json` 不能有 BOM

Windows PowerShell 的 `Set-Content -Encoding utf8` 会写 UTF-8 BOM，安装会直接失败并回滚：

```
dsh: installation rejected: Cannot validate installed package ...:
SyntaxError: Unexpected token '﻿', "﻿{\n  "name"... is not valid JSON
```

用：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

写完检查首字节是 `123`（`{`）：

```powershell
[System.IO.File]::ReadAllBytes($path)[0]
```

### 3. 工具返回值必须是 lossless JSON —— 不能有 `undefined` 值的键

```js
// 报错：tool "xxx" returned invalid output: value is not lossless JSON
return { action: 'list', note: items.length === 0 ? '空' : undefined }

// 正确：可选字段用条件展开
return { action: 'list', ...(items.length === 0 ? { note: '空' } : {}) }
```

### 4. 工具 schema 是 JSON Schema 子集，`required` 是字符串数组

支持的关键字只有：`type` / `oneOf` / `properties` / `required` / `additionalProperties` /
`items` / `enum` / `const`，外加注解 `description` / `title` / `default` / `examples`。

- `required` 必须是字符串数组（`required: ['action']`），**不能**用属性级 `required: true`
  （那是 `defineTool` 的 DSL 才认的写法）。
- object 节点要显式写 `additionalProperties: true|false`。
- 不允许 `type` 数组；不允许 `type` 与 `oneOf` 并存。

### 5. 不导出 `Config` 更省事

cordis 的 `resolveConfig` 只在插件导出 `Config` 时才调 `Config["~standard"].validate(config)`；
导出一个普通对象会 `TypeError`。要 schemastery 就得 import `@deepseek-ai/schemastery`，
而它不一定在 profile 的 `node_modules` 里能解析。

**最稳**：不导出 `Config`，在 `apply` 里用 `DEFAULTS` 合并 `rawConfig`。

### 6. 按 agent 挂行为：`agent/created` → `agent.ctx`

```js
ctx.on('agent/created', ({ agent }) => {
  const disposers = []
  disposers.push(agent.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()          // 先让下游决策
    if (decision.kind !== 'allow') return decision
    // ...你的检查
    return { kind: 'deny', reason: '为什么拒绝，以及怎么自救' }
  }))
  disposers.push(agent.ctx.systemPrompt.section({ name: 'my:section', order: 501, text: () => '...' }))
  // 存起来，在 agent/disposed 时释放
})
```

- `agent.ctx` 是真实的 scoped Context（`ReactLoopAgent` 构造里 `createScope` 出来的）。
- `agent/created` 是 serial 事件，listener 抛错会让 agent 创建失败 —— 里面别做危险操作。
- 提示词段 `text` 可以是函数，但**必须同步**，不能 await。要读异步状态就先缓存，在
  `session/event` / `tools/result` 里刷新。

### 7. `getSectionOrder(name)` 可能返回 `undefined`

未知名返回 undefined。兜底：

```js
const base = ctx.systemPrompt.getSectionOrder('PLAN_POLICY')
const order = Number.isFinite(base) ? base + 1 : 501
```

### 8. 隔离别去改沙箱根，改 `session.header.cwd`

`sandboxPolicy.resolve()` 的优先级是：批准的显式 mode > session 的 `sandbox/mode` 事件 > 部署默认，
而 **session 的 cwd 就是它的 workspace-write 边界**。

所以「项目隔离」的正确做法是让 cwd 指向项目目录（登记成独立 DSH 工作区），
而不是在插件里改写沙箱根。

### 9. `install_bundle` 对已装包会报 `ambiguous-install`

源码逻辑：安装后比较前后依赖表，`installed` 为空就按 spec 名回退，仍必须恰好 1 个，
否则抛 `ambiguous-install`。**这是正常行为，不是故障** —— 要换版本请先 `remove_bundle`。

`remove_bundle` 偶尔第一次报 `EPERM ... rename pnpm-lock.yaml`，重试一次即可。

### 10. `set_plugin` 的 target 是 `include:<rowId>`

不是包名。写 `include:project-scope`，不是 `dsh-project-scope`。
改过插件 `package.json` 后条目会变 `readOnlyReason: "unaddressable"`，必须重新 `install_bundle`。

### 11. 想被别人一键装：用 tarball，不要用 `github:` spec

`plugin_manager` 认四种 spec（`dsh-plugin-manager/lib/index.js:72` 的 `parseInstallSpec`）：
注册表包名、**绝对路径**、git 地址（`github:` / `git+https://` / `git@host:path` /
`https://host/owner/repo`）、以及 **`.tgz` / `.tar.gz` tarball URL**（同文件 `:33` 的 `TARBALL_SPEC`）。

`github:` 这类 git spec 会交给 pnpm 去 `git ls-remote` 解析 ref —— 用户机器上没有 git 时直接
`spawn git ENOENT`。所以对外分发请给 tarball URL：GitHub Release 的 asset 或
`codeload.github.com/<owner>/<repo>/tar.gz/refs/(heads|tags)/<ref>` 都可以，实测 pnpm 能装：

```
plugin_manager  action="install_bundle"  target="https://codeload.github.com/lfq192/dsh-project-scope/tar.gz/refs/heads/main"
```

`package.json` 里的 `files` 必须包含全部运行时文件（`lib/*.js`、`cordis.patch.yml`），
否则装进 `node_modules` 的内容不全。

---

## 三、验收清单

插件算做完，当且仅当：

- [ ] `plugin_manager action=list_bundles` 里能看到它，`enabled: true`、`installed: true`
- [ ] `cordis_inspect_query`（`provider=Tool`）里能看到它注册的工具，schema 正确
- [ ] `systemPrompt.assemble()` 里有它的段（如果它加提示词）
- [ ] 每个守卫都拿**真实工具调用**试过，拒绝文案贴得出来
- [ ] `/命令` 在会话里能跑
- [ ] `test/harness.mjs` 全绿，且 `node --check` 通过
- [ ] `deliverables/` 里的副本与安装目录 SHA256 一致
- [ ] README 写了：装法、用法、配置项、已知边界

---

## 四、这个仓库是怎么来的

按上面这套流程做的，产物就是本仓库。过程里踩到的坑（第 1、2、3 条）都是实际卡住过的 ——
写进这里，省下一次重走。
