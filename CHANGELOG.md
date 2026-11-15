# 变更记录

## 1.1.1

- 修复：工具返回值里出现 `undefined` 值的键会让宿主报 `value is not lossless JSON`。
  `project action="list"` 在项目非空时、`action="sweep"` 在无需收拢时都会踩到。
  改成条件展开（`...(cond ? { note } : {})`）。
- README 补「升级必须换新包名」与「`package.json` 不能有 BOM」两条运维结论。

## 1.1.0

- `deliver` 支持三种路径写法：绝对路径、工作区相对（`projects/x/work/a.txt`）、项目相对（`work/a.txt`）。
- 严格模式成为默认：`requireProjectForWrites: true` —— 没有活跃项目时连 `write` / `edit` 都拒绝，
  强制先 `create`。这样新任务不会把文件落在工作区根目录。
- 没有活跃项目时，所有项目都算「别人的项目」：读与检索同样被拒，实现「新作业不读上一次成果」。
- 修正守卫顺序：删掉「无活跃项目 → 直接放行」的短路，读隔离与检索收窄在无活跃项目时同样生效。

## 1.0.0

首个版本。

- 项目布局 `projects/<slug>/{inputs,work,deliverables,PROJECT.md}`。
- 两种隔离模式：共享工作区（守卫强制）与专用工作区（登记成独立 DSH 工作区，宿主级沙箱边界）。
- 五道守卫：写作用域 / 跨项目读隔离 / 检索收窄 / shell 引用拦截 / 交付归位。
- `project` 工具（create / use / list / status / deliver / sweep / workspace / reset）。
- `/project` 斜杠命令。
- `<project-scope>` 系统提示段，随活跃项目变化。
- 自测 harness，32 项断言。
