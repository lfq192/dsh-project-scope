/**
 * dsh-project-scope — 以项目为中心的会话隔离。
 *
 * 一个 DSH 工作区可以承载很多次任务（作业 / 交付）。本插件把每一次任务收进工作区
 * 内的一个项目目录，并让智能体只在该目录里读写：
 *
 *   <workspace>/<projectsSubdir>/<project-slug>/
 *     inputs/       参考文档、原始素材（输入，只读语义）
 *     work/         处理过程脚本、临时文件（不是交付）
 *     deliverables/ 最终交付物（present 只允许这里）
 *     PROJECT.md    项目清单：目标、创建时间、素材、交付记录
 *
 * 两种工作方式（都支持）：
 *   A. 共享工作区：会话 cwd 仍是工作区根，活跃项目按 sessionId 记在
 *      <workspace>/.dsh/project-scope.json，插件用守卫把读写夹到活跃项目内。
 *   B. 专用工作区：把项目目录本身注册成 DSH 工作区，新会话的 cwd = 项目目录，
 *      沙箱的 workspace-write 边界天然就是项目，隔离由宿主完成。插件识别这种
 *      cwd（目录里有 PROJECT.md）后自动把它当作活跃项目。
 *
 * 五道强制：
 *   1. 写作用域     —— write/edit 落到活跃项目之外时拒绝，并指出应去的位置。
 *   2. 跨项目读隔离 —— 读 / 检索命中别的项目目录时拒绝，避免跨作业污染上下文。
 *   3. 检索必须收窄 —— 目录级检索若覆盖到兄弟项目（含工作区根、projects 根），
 *      拒绝并要求把 path 限定到活跃项目内。
 *   4. 交付归位     —— present 的文件必须位于活跃项目 deliverables/ 内。
 *   5. 散落脚本收拢 —— 工作区根目录的脚本类文件会被提示，并可用 sweep 收进
 *      <project>/work/_stray/，不再堆在交付区之外。
 *
 * @module dsh-project-scope
 */
import { mkdir, readFile, writeFile, readdir, stat, rename, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, sep, basename, extname } from 'node:path'

/** Cordis 插件名。 */
export const name = 'project-scope'

/** 依赖的宿主服务。 */
export const inject = ['tools', 'systemPrompt', 'agents', 'commands']

/* --------------------------------------------------------------- defaults */

/**
 * 默认配置。刻意不导出 `Config`：cordis 的 resolveConfig 只在插件导出 Config 时才做
 * 校验（`runtime.Config["~standard"].validate`），这里用普通对象合并即可，避免依赖
 * schemastery。
 */
const DEFAULTS = {
  /** 项目根目录，相对工作区。 */
  projectsSubdir: 'projects',
  /** 活跃项目状态文件，相对工作区。 */
  stateFile: '.dsh/project-scope.json',
  /** 参考素材目录名。 */
  inputsDir: 'inputs',
  /** 过程脚本目录名。 */
  workDir: 'work',
  /** 交付物目录名。 */
  deliverablesDir: 'deliverables',
  /** 项目清单文件名。 */
  manifestFile: 'PROJECT.md',
  /** 工具名。 */
  toolName: 'project',
  /** 斜杠命令名（不含前导斜杠）。 */
  commandName: 'project',
  /** 写作用域强制。 */
  enforceWriteScope: true,
  /** 跨项目读隔离强制。 */
  enforceReadIsolation: true,
  /** 目录级检索必须收窄到活跃项目。 */
  requireScopedSearch: true,
  /** 交付物位置强制（present 必须在 deliverables 内）。 */
  enforceDeliverables: true,
  /** 严格模式：没有活跃项目时拒绝一切 write/edit（强制先 create 项目）。 */
  requireProjectForWrites: true,
  /** 是否给每个 agent 注入项目上下文段。 */
  injectPrompt: true,
  /** 创建项目时顺带把工作区根目录的散落脚本收进 work/_stray/（默认关闭）。 */
  sweepOnCreate: false,
  /** 提示词里最多列出几个散落文件。 */
  strayPreviewLimit: 6,
}

const PROMPT_SECTION = 'project-scope:protocol'

/** 视为「过程脚本」的扩展名：这些不该留在工作区根目录。 */
const STRAY_EXTENSIONS = new Set([
  '.mjs', '.cjs', '.js', '.mts', '.cts', '.ts', '.tsx', '.jsx',
  '.py', '.ps1', '.psm1', '.sh', '.bash', '.bat', '.cmd',
  '.rb', '.pl', '.php', '.lua', '.sql', '.tmp', '.log', '.bak', '.orig',
])

function normalizeConfig(raw) {
  const merged = { ...DEFAULTS }
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue
      if (!Object.hasOwn(DEFAULTS, key)) continue
      merged[key] = value
    }
  }
  const text = (key, fallback) => {
    const value = merged[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  }
  const flag = (key, fallback) => (typeof merged[key] === 'boolean' ? merged[key] : fallback)
  return {
    projectsSubdir: text('projectsSubdir', DEFAULTS.projectsSubdir),
    stateFile: text('stateFile', DEFAULTS.stateFile),
    inputsDir: text('inputsDir', DEFAULTS.inputsDir),
    workDir: text('workDir', DEFAULTS.workDir),
    deliverablesDir: text('deliverablesDir', DEFAULTS.deliverablesDir),
    manifestFile: text('manifestFile', DEFAULTS.manifestFile),
    toolName: text('toolName', DEFAULTS.toolName),
    commandName: text('commandName', DEFAULTS.commandName),
    enforceWriteScope: flag('enforceWriteScope', DEFAULTS.enforceWriteScope),
    enforceReadIsolation: flag('enforceReadIsolation', DEFAULTS.enforceReadIsolation),
    requireScopedSearch: flag('requireScopedSearch', DEFAULTS.requireScopedSearch),
    enforceDeliverables: flag('enforceDeliverables', DEFAULTS.enforceDeliverables),
    requireProjectForWrites: flag('requireProjectForWrites', DEFAULTS.requireProjectForWrites),
    injectPrompt: flag('injectPrompt', DEFAULTS.injectPrompt),
    sweepOnCreate: flag('sweepOnCreate', DEFAULTS.sweepOnCreate),
    strayPreviewLimit:
      Number.isInteger(merged.strayPreviewLimit) && merged.strayPreviewLimit >= 0
        ? merged.strayPreviewLimit
        : DEFAULTS.strayPreviewLimit,
  }
}

/* ------------------------------------------------------------------ paths */

/** 统一成小写、绝对化的比较键（Windows 大小写不敏感）。 */
function pathKey(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** child 是否位于 parent 之内（含相等）。 */
function contains(parent, child) {
  const p = pathKey(parent)
  const c = pathKey(child)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 相对显示路径；跨盘或越界时退回绝对路径。 */
function display(root, target) {
  if (root === undefined) return target
  const rel = relative(root, target)
  return rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) ? target : rel
}

/** 目录名安全化。 */
function slugify(input) {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned : `project-${Date.now()}`
}

/* ------------------------------------------------------------------ state */

/**
 * 按 workspace 串行化的状态存取。
 * 结构：{ version, active: { [sessionId]: projectAbsolutePath } }
 */
class StateStore {
  constructor(config) {
    this.config = config
    this.cache = new Map()
    this.queues = new Map()
  }

  file(workspace) {
    return resolve(workspace, this.config.stateFile)
  }

  async read(workspace) {
    const cached = this.cache.get(workspace)
    if (cached !== undefined) return cached
    let state = { version: 1, active: {} }
    try {
      const raw = await readFile(this.file(workspace), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.active && typeof parsed.active === 'object') {
        state = { version: 1, active: { ...parsed.active } }
      }
    } catch {
      /* 首次运行或文件不可读：回到空状态。 */
    }
    this.cache.set(workspace, state)
    return state
  }

  async write(workspace, mutate) {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const next = previous.then(async () => {
      const state = await this.read(workspace)
      mutate(state)
      const file = this.file(workspace)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      return state
    })
    this.queues.set(
      workspace,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  async active(workspace, sessionId) {
    const state = await this.read(workspace)
    return state.active[sessionId]
  }

  async setActive(workspace, sessionId, projectPath) {
    await this.write(workspace, (state) => {
      if (projectPath === undefined) delete state.active[sessionId]
      else state.active[sessionId] = projectPath
    })
    return projectPath
  }
}

/* ---------------------------------------------------------------- project */

class ProjectScope {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.store = new StateStore(config)
    this.promptCache = new Map()
    this.strayCache = new Map()
  }

  layout(projectPath) {
    const { inputsDir, workDir, deliverablesDir, manifestFile } = this.config
    return {
      root: projectPath,
      inputs: join(projectPath, inputsDir),
      work: join(projectPath, workDir),
      deliverables: join(projectPath, deliverablesDir),
      manifest: join(projectPath, manifestFile),
      stray: join(projectPath, workDir, '_stray'),
    }
  }

  /** 会话的原始 cwd。 */
  cwdOf(session) {
    const cwd = session?.header?.cwd
    return cwd === undefined ? undefined : resolve(cwd)
  }

  /** 某个目录本身是不是一个项目目录（有 PROJECT.md）。 */
  isProjectDir(dir) {
    return dir !== undefined && existsSync(join(dir, this.config.manifestFile))
  }

  /**
   * 解析会话的隔离上下文。
   * @returns {{ workspace: string, projectPath?: string, dedicated: boolean } | undefined}
   */
  async resolveContext(session) {
    const cwd = this.cwdOf(session)
    if (cwd === undefined) return undefined

    // 方式 B：会话 cwd 本身就是项目目录。
    if (this.isProjectDir(cwd)) {
      const parent = dirname(cwd)
      const workspace = basename(parent).toLowerCase() === this.config.projectsSubdir.toLowerCase() ? dirname(parent) : parent
      return { workspace, projectPath: cwd, dedicated: true }
    }

    // 方式 A：活跃项目记在状态文件里。
    const recorded = await this.store.active(cwd, session.id)
    if (recorded !== undefined && existsSync(recorded)) {
      return { workspace: cwd, projectPath: recorded, dedicated: false }
    }
    return { workspace: cwd, projectPath: undefined, dedicated: false }
  }

  projectsRoot(workspace) {
    return resolve(workspace, this.config.projectsSubdir)
  }

  /** 列出现存项目（含清单文件的目录）。 */
  async listProjects(workspace) {
    const root = this.projectsRoot(workspace)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const found = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      if (!this.isProjectDir(dir)) continue
      let goal = ''
      let createdAt = ''
      try {
        const text = await readFile(join(dir, this.config.manifestFile), 'utf8')
        goal = /^-\s*目标[:：]\s*(.*)$/m.exec(text)?.[1]?.trim() ?? ''
        createdAt = /^-\s*创建[:：]\s*(.*)$/m.exec(text)?.[1]?.trim() ?? ''
      } catch {
        /* 清单读取失败时仍保留项目条目 */
      }
      found.push({ path: dir, name: entry.name, goal, createdAt })
    }
    found.sort((a, b) => a.name.localeCompare(b.name))
    return found
  }

  async activeProject(session) {
    const context = await this.resolveContext(session)
    return context?.projectPath
  }

  /**
   * 工作区根目录（仅第一层、非隐藏）里的脚本类散落文件。
   * 这些正是「智能体把探查脚本丢在工作区」的残留。
   */
  async strayFiles(workspace) {
    let entries
    try {
      entries = await readdir(workspace, { withFileTypes: true })
    } catch {
      return []
    }
    const skipTop = new Set([
      this.config.projectsSubdir.toLowerCase(),
      this.config.stateFile.split(/[\\/]/)[0].toLowerCase(),
    ])
    const found = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.startsWith('.')) continue
      if (skipTop.has(lower)) continue
      if (!STRAY_EXTENSIONS.has(extname(lower))) continue
      found.push(join(workspace, entry.name))
    }
    found.sort((a, b) => a.localeCompare(b))
    return found
  }

  /** 把散落脚本收进 <project>/work/_stray/。 */
  async sweepStray(workspace, projectPath) {
    const layout = this.layout(projectPath)
    const stray = await this.strayFiles(workspace)
    if (stray.length === 0) return []
    await mkdir(layout.stray, { recursive: true })
    const moved = []
    for (const from of stray) {
      let to = join(layout.stray, basename(from))
      if (existsSync(to)) {
        let index = 2
        while (existsSync(`${to}-${index}`)) index += 1
        to = `${to}-${index}`
      }
      try {
        await rename(from, to)
        moved.push({ from, to })
      } catch {
        /* 单个文件被占用时跳过，不阻断整体收拢 */
      }
    }
    if (moved.length > 0) {
      const log = join(layout.stray, 'MOVED.md')
      const lines = moved.map((item) => `- ${basename(item.from)} → ${basename(item.to)}`)
      const header = existsSync(log) ? '' : '# 从工作区根目录收拢的过程脚本\n\n'
      await writeFile(log, `${header}${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' })
    }
    return moved
  }

  async createProject(session, { name, goal, inputs }) {
    const cwd = this.cwdOf(session)
    if (cwd === undefined) throw new Error('当前会话没有工作区（session cwd），无法创建项目目录')
    const context = await this.resolveContext(session)
    const workspace = context?.dedicated === true ? context.workspace : cwd
    const root = this.projectsRoot(workspace)
    await mkdir(root, { recursive: true })
    let projectPath = join(root, slugify(name))
    if (existsSync(projectPath)) {
      let index = 2
      while (existsSync(`${projectPath}-${index}`)) index += 1
      projectPath = `${projectPath}-${index}`
    }
    const layout = this.layout(projectPath)
    for (const dir of [layout.inputs, layout.work, layout.deliverables]) await mkdir(dir, { recursive: true })

    const copied = []
    for (const source of inputs ?? []) {
      const from = isAbsolute(source) ? resolve(source) : resolve(workspace, source)
      if (!existsSync(from)) throw new Error(`参考素材不存在：${source}`)
      const info = await stat(from)
      if (!info.isFile()) throw new Error(`参考素材不是文件：${source}`)
      const to = join(layout.inputs, basename(from))
      await copyFile(from, to)
      copied.push(to)
    }

    const manifest = [
      `# ${basename(projectPath)}`,
      '',
      `- 目标：${goal ?? ''}`,
      `- 创建：${new Date().toISOString()}`,
      `- 工作区：${workspace}`,
      '',
      '## 目录约定',
      '',
      `- \`${this.config.inputsDir}/\` 参考文档与原始素材（输入，只读语义）`,
      `- \`${this.config.workDir}/\` 处理过程脚本与临时文件（不是交付）`,
      `- \`${this.config.deliverablesDir}/\` 最终交付物（present 只允许这里）`,
      '',
      '## 素材',
      '',
      ...(copied.length > 0 ? copied.map((file) => `- ${relative(projectPath, file)}`) : ['- （无）']),
      '',
      '## 交付',
      '',
    ].join('\n')
    await writeFile(layout.manifest, manifest, 'utf8')

    if (context?.dedicated !== true) {
      await this.store.setActive(workspace, session.id, projectPath)
    }
    this.promptCache.set(session.id, projectPath)

    let swept = []
    if (this.config.sweepOnCreate) {
      try {
        swept = await this.sweepStray(workspace, projectPath)
      } catch {
        swept = []
      }
    }
    return { projectPath, layout, workspace, copied, swept }
  }

  async setActiveByName(session, name) {
    const context = await this.resolveContext(session)
    if (context === undefined) throw new Error('当前会话没有工作区（session cwd）')
    const root = this.projectsRoot(context.workspace)
    const candidate = isAbsolute(name) ? resolve(name) : resolve(root, name)
    if (!contains(root, candidate)) throw new Error(`项目必须位于 ${display(context.workspace, root)} 之内：${name}`)
    if (!existsSync(candidate)) throw new Error(`项目不存在：${name}`)
    if (context.dedicated) {
      throw new Error(
        '当前会话已经在一个项目目录里（cwd 就是项目）。要切换到别的项目，请在 DSH 里打开那个项目的工作区，或在共享工作区的会话里使用 use。',
      )
    }
    await this.store.setActive(context.workspace, session.id, candidate)
    this.promptCache.set(session.id, candidate)
    return candidate
  }

  /** 兄弟项目目录（用于读隔离判定）。activePath 为 undefined 时返回全部项目。 */
  async siblingProjects(session, activePath) {
    const context = await this.resolveContext(session)
    if (context === undefined) return []
    const projects = await this.listProjects(context.workspace)
    const activeKey = activePath === undefined ? undefined : pathKey(activePath)
    return projects.map((item) => item.path).filter((item) => pathKey(item) !== activeKey)
  }

  /**
   * 把用户/模型给的路径解析成绝对路径。
   * 顺序：绝对路径 → 工作区相对 → 项目相对。这样 `projects/x/work/a.sql` 与
   * `work/a.sql` 两种写法都能用。
   */
  resolveInput(context, projectPath, entry) {
    if (isAbsolute(entry)) return resolve(entry)
    const candidates = []
    if (context !== undefined) candidates.push(resolve(context.workspace, entry))
    if (projectPath !== undefined) candidates.push(resolve(projectPath, entry))
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
    return candidates[0] ?? resolve(entry)
  }

  /** 与 resolveInput 同序的候选列表，仅用于错误诊断。 */
  inputCandidates(context, projectPath, entry) {
    if (isAbsolute(entry)) return [resolve(entry)]
    const candidates = []
    if (context !== undefined) candidates.push(resolve(context.workspace, entry))
    if (projectPath !== undefined) candidates.push(resolve(projectPath, entry))
    return candidates
  }

  async deliver(session, files) {
    const context = await this.resolveContext(session)
    const projectPath = context?.projectPath
    if (projectPath === undefined) throw new Error('当前会话没有活跃项目，先执行 project 工具的 create 或 use')
    const layout = this.layout(projectPath)
    await mkdir(layout.deliverables, { recursive: true })
    const moved = []
    for (const entry of files) {
      const from = this.resolveInput(context, projectPath, entry)
      if (!contains(projectPath, from)) throw new Error(`交付文件必须位于项目内：${entry}`)
      if (!existsSync(from)) {
        const tried = this.inputCandidates(context, projectPath, entry).join(' | ')
        throw new Error(`交付文件不存在：${entry}（已尝试：${tried}；workspace=${context?.workspace}）`)
      }
      const info = await stat(from)
      if (!info.isFile()) throw new Error(`交付文件不是常规文件：${entry}`)
      const to = join(layout.deliverables, basename(from))
      if (pathKey(from) !== pathKey(to)) await rename(from, to)
      moved.push({ from, to })
    }
    if (moved.length > 0) {
      const lines = moved.map((item) => `- ${basename(item.to)}（来自 ${display(projectPath, item.from)}）`)
      await writeFile(layout.manifest, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' })
    }
    return { projectPath, layout, moved }
  }

  /** 把项目目录注册成 DSH 工作区，便于用「专用工作区」方式打开。 */
  async registerWorkspace(projectPath, title) {
    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry === undefined) throw new Error('当前部署没有 workspaceRegistry 服务，无法登记工作区')
    const workspace = await registry.create(projectPath, title)
    return workspace
  }

  /** 异步刷新某会话的缓存（供同步 prompt section 使用）。 */
  async refreshCache(session) {
    try {
      const context = await this.resolveContext(session)
      if (context?.projectPath === undefined) this.promptCache.delete(session.id)
      else this.promptCache.set(session.id, context.projectPath)
      if (context !== undefined && context.dedicated === false) {
        this.strayCache.set(session.id, await this.strayFiles(context.workspace))
      } else {
        this.strayCache.delete(session.id)
      }
    } catch {
      this.promptCache.delete(session.id)
    }
  }
}

/* ------------------------------------------------------------ prompt text */

function protocolText(scope, session) {
  const { config } = scope
  const cwd = scope.cwdOf(session)
  const activePath = scope.promptCache.get(session.id)
  const stray = scope.strayCache.get(session.id) ?? []
  const dedicated = cwd !== undefined && activePath !== undefined && pathKey(cwd) === pathKey(activePath)
  const workspace = dedicated ? dirname(dirname(activePath)) : cwd
  const root = workspace ?? activePath ?? ''
  const layout = activePath === undefined ? undefined : scope.layout(activePath)
  const lines = ['<project-scope>', '本会话按「项目」隔离：一次任务 = 一个项目目录。']
  if (workspace !== undefined) lines.push(`工作区：${workspace}`)
  if (layout === undefined) {
    lines.push(
      `当前没有活跃项目。开工前先调用 \`${config.toolName}\` 工具，action="create"，给出项目名与目标；用户提供了参考文档时用 inputs 参数一并带入，插件会复制进 ${config.inputsDir}/。`,
    )
  } else {
    lines.push(`活跃项目：${display(root, layout.root)}${dedicated ? '（本会话 cwd 就是该项目，沙箱边界天然一致）' : ''}`)
    lines.push(`- 参考素材：${display(root, layout.inputs)}（只读语义，不要改写）`)
    lines.push(`- 过程脚本：${display(root, layout.work)}（临时脚本、探查、一次性命令都放这里）`)
    lines.push(`- 交付物：${display(root, layout.deliverables)}（最终产物只放这里）`)
  }
  lines.push(
    '硬性规则：',
    '1. 只在活跃项目目录内读写；写到项目之外的 write/edit 会被拒绝。',
    `2. 临时脚本、探查代码、中间产物一律写进 ${config.workDir}/，不要散落在工作区根目录，也不要写进 ${config.deliverablesDir}/。`,
    `3. 最终产物先用 \`${config.toolName}\` 的 action="deliver" 归入 ${config.deliverablesDir}/，再用 present 呈现；present 只接受 ${config.deliverablesDir}/ 内的文件。`,
    '4. 不要读其他项目目录（上一次作业）的内容；用户明确要求时才读。',
    '5. 目录级检索（glob/grep/read 目录）必须把 path 收窄到活跃项目内，工作区根目录会被拒绝。',
    '6. 用户提出新任务且没有指定沿用当前项目时，先 create 一个新项目，再开始工作。',
  )
  if (stray.length > 0) {
    const limit = config.strayPreviewLimit
    const preview = stray.slice(0, limit).map((file) => basename(file))
    lines.push(
      `注意：工作区根目录还有 ${stray.length} 个散落的脚本类文件（${preview.join('、')}${stray.length > limit ? ' …' : ''}）。` +
        `它们不属于任何项目；需要保留时用 \`${config.toolName}\` 的 action="sweep" 收进 ${config.workDir}/_stray/。`,
    )
  }
  lines.push('</project-scope>')
  return lines.join('\n')
}

/* -------------------------------------------------------------- the tool */

const TOOL_ACTIONS = ['create', 'use', 'list', 'status', 'deliver', 'sweep', 'workspace', 'reset']

function buildTool(scope) {
  const { config } = scope
  return {
    name: config.toolName,
    description: [
      'Project isolation for this workspace: create or select the project directory for the current task, inspect its layout, and move finished artifacts into deliverables/.',
      `Actions: ${TOOL_ACTIONS.join(' / ')}.`,
      'create — new project with inputs/, work/, deliverables/ and PROJECT.md; optionally copies reference documents into inputs/.',
      'use — select an existing project by directory name (shared-workspace mode only).',
      'list — list projects in this workspace.',
      'status — show the active project layout, delivered files and stray scripts at the workspace root.',
      'deliver — move files into deliverables/ (required before present).',
      'sweep — move stray script files from the workspace root into work/_stray/.',
      'workspace — register the project directory as its own DSH workspace so future sessions can open it directly with a native sandbox boundary.',
      'reset — clear the active project so the next task starts a new one.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: TOOL_ACTIONS,
          description: 'Operation to perform.',
        },
        name: {
          type: 'string',
          description: 'Project name for create, or an existing project directory name for use.',
        },
        goal: {
          type: 'string',
          description: 'One-line objective recorded in the project manifest (create).',
        },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Reference documents to copy into the project inputs/ directory (create). Workspace-relative or absolute paths.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to move into deliverables/ (deliver). Project-relative or absolute paths.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          project: { type: 'string' },
          inputs: { type: 'string' },
          work: { type: 'string' },
          deliverables: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          stray: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['action'],
      },
      render: (_args, value) => {
        const lines = [`project ${value.action}`]
        if (value.project !== undefined) lines.push(`project: ${value.project}`)
        if (value.inputs !== undefined) lines.push(`inputs: ${value.inputs}`)
        if (value.work !== undefined) lines.push(`work: ${value.work}`)
        if (value.deliverables !== undefined) lines.push(`deliverables: ${value.deliverables}`)
        if (value.projects !== undefined && value.projects.length > 0) {
          lines.push(`projects:\n- ${value.projects.join('\n- ')}`)
        }
        if (value.files !== undefined && value.files.length > 0) lines.push(`files:\n- ${value.files.join('\n- ')}`)
        if (value.stray !== undefined && value.stray.length > 0) lines.push(`stray:\n- ${value.stray.join('\n- ')}`)
        if (value.note !== undefined) lines.push(value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error(`${config.toolName} 需要一个 agent 会话`)
      const context = await scope.resolveContext(session)
      if (context === undefined) throw new Error('当前会话没有工作区（session cwd）')
      const workspace = context.workspace
      await scope.refreshCache(session)

      if (args.action === 'create') {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('create 需要非空的 name')
        const created = await scope.createProject(session, { name: args.name, goal: args.goal, inputs: args.inputs })
        const notes = []
        notes.push(
          created.copied.length > 0
            ? `已复制 ${created.copied.length} 个参考素材到 ${config.inputsDir}/`
            : `未提供参考素材；需要时把文档放进 ${config.inputsDir}/ 再读取。`,
        )
        if (created.swept.length > 0) {
          notes.push(`已把工作区根目录的 ${created.swept.length} 个散落脚本收进 ${config.workDir}/_stray/`)
        }
        if (context.dedicated) {
          notes.push('本会话 cwd 本身是项目目录，新建的项目不会自动切换为活跃项目；请在 DSH 里打开新项目的工作区。')
        }
        await scope.refreshCache(session)
        return {
          action: 'create',
          project: display(workspace, created.projectPath),
          inputs: display(workspace, created.layout.inputs),
          work: display(workspace, created.layout.work),
          deliverables: display(workspace, created.layout.deliverables),
          note: notes.join('；'),
        }
      }

      if (args.action === 'use') {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('use 需要 name')
        const projectPath = await scope.setActiveByName(session, args.name)
        const layout = scope.layout(projectPath)
        await scope.refreshCache(session)
        return {
          action: 'use',
          project: display(workspace, projectPath),
          inputs: display(workspace, layout.inputs),
          work: display(workspace, layout.work),
          deliverables: display(workspace, layout.deliverables),
        }
      }

      if (args.action === 'list') {
        const projects = await scope.listProjects(workspace)
        return {
          action: 'list',
          projects: projects.map((item) => (item.goal.length > 0 ? `${item.name} — ${item.goal}` : item.name)),
          // 注意：工具返回值必须是 lossless JSON —— 不能出现 undefined 值的键，
          // 否则宿主校验会报 `value is not lossless JSON`。可选文案用条件展开。
          ...(projects.length === 0
            ? { note: `还没有项目；${display(workspace, scope.projectsRoot(workspace))} 为空。` }
            : {}),
        }
      }

      if (args.action === 'status') {
        const stray = context.dedicated ? [] : (await scope.strayFiles(workspace)).map((file) => basename(file))
        const projectPath = context.projectPath
        if (projectPath === undefined) {
          return { action: 'status', stray, note: '当前没有活跃项目，先 create 或 use。' }
        }
        const layout = scope.layout(projectPath)
        let files = []
        try {
          files = (await readdir(layout.deliverables)).filter((entry) => !entry.startsWith('.'))
        } catch {
          files = []
        }
        return {
          action: 'status',
          project: display(workspace, projectPath),
          inputs: display(workspace, layout.inputs),
          work: display(workspace, layout.work),
          deliverables: display(workspace, layout.deliverables),
          files,
          stray,
        }
      }

      if (args.action === 'deliver') {
        if (!Array.isArray(args.files) || args.files.length === 0) throw new Error('deliver 需要非空的 files')
        const delivered = await scope.deliver(session, args.files)
        return {
          action: 'deliver',
          project: display(workspace, delivered.projectPath),
          deliverables: display(workspace, delivered.layout.deliverables),
          files: delivered.moved.map((item) => display(workspace, item.to)),
        }
      }

      if (args.action === 'sweep') {
        const projectPath = context.projectPath
        if (projectPath === undefined) throw new Error('sweep 需要活跃项目：先 create 或 use')
        if (context.dedicated) {
          return {
            action: 'sweep',
            project: display(workspace, projectPath),
            note: '本会话 cwd 就是项目目录，根目录不存在工作区级的散落脚本。',
          }
        }
        const moved = await scope.sweepStray(workspace, projectPath)
        await scope.refreshCache(session)
        const layout = scope.layout(projectPath)
        return {
          action: 'sweep',
          project: display(workspace, projectPath),
          work: display(workspace, layout.stray),
          files: moved.map((item) => display(workspace, item.to)),
          ...(moved.length === 0 ? { note: '工作区根目录没有需要收拢的脚本。' } : {}),
        }
      }

      if (args.action === 'workspace') {
        const projectPath = context.projectPath
        if (projectPath === undefined) throw new Error('workspace 需要活跃项目：先 create 或 use')
        const registered = await scope.registerWorkspace(projectPath, basename(projectPath))
        return {
          action: 'workspace',
          project: display(workspace, projectPath),
          note: `已登记为 DSH 工作区「${registered.title}」。在 DSH 里打开它新建会话，沙箱边界就是该目录，隔离由宿主完成。`,
        }
      }

      if (args.action === 'reset') {
        if (context.dedicated) {
          return {
            action: 'reset',
            note: '本会话 cwd 就是项目目录，没有可清除的活跃项目记录。',
          }
        }
        await scope.store.setActive(workspace, session.id, undefined)
        scope.promptCache.delete(session.id)
        return { action: 'reset', note: '已清除活跃项目；下一个任务请重新 create。' }
      }

      throw new Error(`未知 action：${args.action}`)
    },
  }
}

/* ---------------------------------------------------------------- guards */

const WRITE_TOOLS = new Set(['write', 'edit'])
const READ_TOOLS = new Set(['read', 'glob', 'grep'])
const SHELL_TOOLS = new Set(['pwsh', 'bash'])
const DIRECTORY_TOOLS = new Set(['glob', 'grep'])

/** 从工具参数里取本次调用的路径候选。 */
function pathsFromExecution(exec) {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return []
  const found = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) found.push(value)
  }
  push(args.file_path)
  push(args.path)
  push(args.workdir)
  if (Array.isArray(args.files)) {
    for (const entry of args.files) {
      if (typeof entry === 'string') push(entry)
      else if (entry && typeof entry === 'object') push(entry.path)
    }
  }
  return found
}

function resolveMaybe(cwd, value) {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

/**
 * 为单个 agent 安装守卫与提示词段。
 * @returns 释放函数
 */
function installForAgent(pluginCtx, scope, agent) {
  const { config } = scope
  const session = agent.session
  const agentCtx = agent.ctx
  const disposers = []

  if (config.injectPrompt) {
    const base = agentCtx.systemPrompt.getSectionOrder('PLAN_POLICY')
    const order = Number.isFinite(base) ? base + 1 : 501
    disposers.push(
      agentCtx.systemPrompt.section({
        name: PROMPT_SECTION,
        order,
        text: () => protocolText(scope, session),
      }),
    )
    void scope.refreshCache(session)
    disposers.push(
      pluginCtx.on('session/event', (eventSession, event) => {
        if (eventSession?.id !== session.id) return
        if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start') {
          void scope.refreshCache(session)
        }
      }),
    )
    disposers.push(
      pluginCtx.on('tools/result', (exec) => {
        if (exec?.agent?.id !== agent.id) return
        void scope.refreshCache(session)
      }),
    )
  }

  disposers.push(
    agentCtx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow') return decision
      if (exec.agent === undefined || exec.agent.id !== agent.id) return decision

      const context = await scope.resolveContext(session)
      if (context === undefined) return decision
      const cwd = scope.cwdOf(session)
      const projectPath = context.projectPath
      // 严格模式：还没有活跃项目时，连写都不允许 —— 强制先 create，避免文件落在工作区根目录。
      if (projectPath === undefined && config.requireProjectForWrites && WRITE_TOOLS.has(exec.name)) {
        return {
          kind: 'deny',
          reason:
            `还没有活跃项目：本次任务尚未指定交付位置。先调用 \`${config.toolName}\` 工具 action="create"，` +
            `给出项目名与目标；项目目录建好后再写 ${config.workDir}/ 与 ${config.deliverablesDir}/。`,
        }
      }
      const layout = projectPath === undefined ? undefined : scope.layout(projectPath)
      const candidates = pathsFromExecution(exec)

      // 1) 写作用域
      if (config.enforceWriteScope && projectPath !== undefined && WRITE_TOOLS.has(exec.name)) {
        for (const value of candidates) {
          const target = resolveMaybe(cwd, value)
          if (!contains(projectPath, target)) {
            return {
              kind: 'deny',
              reason:
                `写作用域拒绝：${value} 不在活跃项目内。本次任务只能写 ${display(cwd, projectPath)} 之内：` +
                `过程脚本放 ${display(cwd, layout.work)}，最终交付放 ${display(cwd, layout.deliverables)}。` +
                `若这是另一项任务，先用 ${config.toolName} 的 create 建新项目。`,
            }
          }
        }
      }

      if (!config.enforceReadIsolation) return decision

      // 没有活跃项目时，所有项目都算「别人的项目」——默认不读上一次的成果。
      const siblings = await scope.siblingProjects(session, projectPath)

      // 2) 跨项目读隔离
      if (READ_TOOLS.has(exec.name)) {
        for (const value of candidates) {
          const target = resolveMaybe(cwd, value)
          for (const sibling of siblings) {
            if (contains(sibling, target)) {
              return {
                kind: 'deny',
                reason:
                  `跨项目读隔离：${value} 属于另一个项目（${display(cwd, sibling)}），与本次任务无关。` +
                  '不要读取上一次任务的内容；确需参考时请用户明确说明。',
              }
            }
          }
        }
      }

      // 3) 目录级检索必须收窄
      if (config.requireScopedSearch && (DIRECTORY_TOOLS.has(exec.name) || exec.name === 'read')) {
        const explicit = candidates[0]
        const target = explicit === undefined ? cwd : resolveMaybe(cwd, explicit)
        const coversSibling = siblings.some((sibling) => contains(target, sibling))
        if (coversSibling) {
          const where =
            projectPath === undefined
              ? `先创建本项目，或把 path 直接指向要读的文件`
              : `请把 path 收窄到活跃项目内（例如 ${display(cwd, projectPath)} 或它的子目录）`
          return {
            kind: 'deny',
            reason:
              `检索范围过宽：${display(cwd, target)} 覆盖了其他项目目录。` +
              `${where}，避免把上一次任务的内容带进上下文。`,
          }
        }
      }

      // 4) shell 中的兄弟项目引用
      if (SHELL_TOOLS.has(exec.name)) {
        const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
        const lowered = process.platform === 'win32' ? command.toLowerCase() : command
        const projectsRoot = scope.projectsRoot(context.workspace)
        for (const sibling of siblings) {
          const rel = relative(projectsRoot, sibling).replaceAll(sep, '/')
          const needles =
            process.platform === 'win32'
              ? [pathKey(sibling), `projects/${rel.toLowerCase()}`, `projects\\${rel.toLowerCase()}`]
              : [resolve(sibling), `projects/${rel}`]
          if (needles.some((needle) => needle.length > 0 && lowered.includes(needle))) {
            return {
              kind: 'deny',
              reason: `跨项目读隔离：命令引用了另一个项目目录 ${display(cwd, sibling)}；不要读取上一次任务的内容。`,
            }
          }
        }
        for (const value of candidates) {
          const target = resolveMaybe(cwd, value)
          if (!contains(projectsRoot, target)) continue
          if (projectPath !== undefined && contains(projectPath, target)) continue
          return {
            kind: 'deny',
            reason:
              `跨项目写隔离：shell 的工作目录 ${value} 属于其他项目；` +
              `本次任务请使用 ${projectPath === undefined ? '新建的项目目录' : display(cwd, projectPath)}。`,
          }
        }
      }

      // 5) 交付物归位
      if (config.enforceDeliverables && exec.name === 'present') {
        const files = Array.isArray(exec.arguments?.files) ? exec.arguments.files : []
        for (const entry of files) {
          const value = typeof entry === 'string' ? entry : entry?.path
          if (typeof value !== 'string' || value.trim().length === 0) continue
          const target = resolveMaybe(cwd, value)
          if (layout !== undefined && contains(layout.deliverables, target)) continue
          return {
            kind: 'deny',
            reason:
              (layout === undefined
                ? `还没有活跃项目，交付物没有归属目录。`
                : `交付物必须位于 ${display(cwd, layout.deliverables)}：${value} 不在其中。`) +
              `先调用 ${config.toolName} 的 action="deliver" 把文件归入交付目录，再 present。`,
          }
        }
      }

      return decision
    }),
  )

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* 释放失败不阻塞卸载 */
      }
    }
  }
}

/* --------------------------------------------------------------- command */

/**
 * 斜杠命令：用户侧的同一套操作（与工具共享 ProjectScope）。
 * `/project` 无参数 = 状态；`/project new <名称> [| 目标]`；`/project use <名称>`；
 * `/project list`；`/project done <文件…>`；`/project sweep`；`/project workspace`；
 * `/project reset`。
 */
function buildCommand(scope) {
  const { config } = scope
  return {
    name: config.commandName,
    description: '按项目管理当前工作区：新建 / 切换 / 查看 / 归位交付 / 收拢散落脚本 / 登记工作区 / 重置',
    input: { hint: '[new <名称> [| 目标] | use <名称> | list | done <文件…> | sweep | workspace | reset]' },
    async handler(invocation) {
      const session = invocation.agent?.session
      const context = session === undefined ? undefined : await scope.resolveContext(session)
      if (session === undefined || context === undefined) {
        return { kind: 'error', text: '当前会话没有工作区（session cwd）' }
      }
      const workspace = context.workspace
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const [head, ...rest] = raw.split(/\s+/).filter((part) => part.length > 0)
      const tail = raw.slice(head?.length ?? 0).trim()
      try {
        if (head === undefined) {
          const projectPath = context.projectPath
          if (projectPath === undefined) {
            const projects = await scope.listProjects(workspace)
            return {
              kind: 'success',
              text:
                `没有活跃项目。工作区 ${workspace} 下现有 ${projects.length} 个项目。` +
                `\n用 /${config.commandName} new <名称> 开始一项新任务。`,
            }
          }
          const layout = scope.layout(projectPath)
          let files = []
          try {
            files = (await readdir(layout.deliverables)).filter((entry) => !entry.startsWith('.'))
          } catch {
            files = []
          }
          return {
            kind: 'success',
            text: [
              `活跃项目：${display(workspace, projectPath)}${context.dedicated ? '（专用工作区）' : ''}`,
              `- 参考素材：${display(workspace, layout.inputs)}`,
              `- 过程脚本：${display(workspace, layout.work)}`,
              `- 交付物：${display(workspace, layout.deliverables)}`,
              files.length > 0 ? `- 已交付：${files.join('、')}` : '- 已交付：（空）',
            ].join('\n'),
          }
        }

        if (head === 'new' || head === 'create') {
          if (rest.length === 0) return { kind: 'error', text: `用法：/${config.commandName} new <名称> [| 目标]` }
          const [namePart, goalPart] = tail.split('|')
          const created = await scope.createProject(session, {
            name: namePart.trim(),
            goal: goalPart?.trim(),
          })
          await scope.refreshCache(session)
          const extra = created.swept.length > 0 ? `\n已收拢 ${created.swept.length} 个散落脚本到 work/_stray/。` : ''
          return {
            kind: 'success',
            text: `已创建并切换到项目 ${display(workspace, created.projectPath)}。${extra}`,
          }
        }

        if (head === 'use') {
          if (rest.length === 0) return { kind: 'error', text: `用法：/${config.commandName} use <名称>` }
          const projectPath = await scope.setActiveByName(session, rest.join(' '))
          await scope.refreshCache(session)
          return { kind: 'success', text: `已切换到项目 ${display(workspace, projectPath)}。` }
        }

        if (head === 'list') {
          const projects = await scope.listProjects(workspace)
          if (projects.length === 0) return { kind: 'success', text: '还没有项目。' }
          return {
            kind: 'success',
            text: projects
              .map((item) => `- ${item.name}${item.goal.length > 0 ? ` — ${item.goal}` : ''}`)
              .join('\n'),
          }
        }

        if (head === 'done' || head === 'deliver') {
          if (rest.length === 0) return { kind: 'error', text: `用法：/${config.commandName} done <文件…>` }
          const delivered = await scope.deliver(session, rest)
          return {
            kind: 'success',
            text: `已归入交付目录 ${display(workspace, delivered.layout.deliverables)}：\n${delivered.moved
              .map((item) => `- ${basename(item.to)}`)
              .join('\n')}`,
          }
        }

        if (head === 'sweep') {
          const projectPath = context.projectPath
          if (projectPath === undefined) return { kind: 'error', text: '没有活跃项目，先 new 或 use。' }
          if (context.dedicated) return { kind: 'success', text: '本会话 cwd 就是项目目录，没有工作区级散落脚本。' }
          const moved = await scope.sweepStray(workspace, projectPath)
          await scope.refreshCache(session)
          if (moved.length === 0) return { kind: 'success', text: '工作区根目录没有需要收拢的脚本。' }
          return {
            kind: 'success',
            text: `已收进 work/_stray/：\n${moved.map((item) => `- ${basename(item.to)}`).join('\n')}`,
          }
        }

        if (head === 'workspace') {
          const projectPath = context.projectPath
          if (projectPath === undefined) return { kind: 'error', text: '没有活跃项目，先 new 或 use。' }
          const registered = await scope.registerWorkspace(projectPath, basename(projectPath))
          return {
            kind: 'success',
            text: `已登记 DSH 工作区「${registered.title}」（${registered.path}）。打开它新建会话即得到原生沙箱隔离。`,
          }
        }

        if (head === 'reset') {
          if (context.dedicated) return { kind: 'success', text: '本会话 cwd 就是项目目录，没有可清除的记录。' }
          await scope.store.setActive(workspace, session.id, undefined)
          scope.promptCache.delete(session.id)
          return { kind: 'success', text: '已清除活跃项目；下一个任务请重新 new。' }
        }

        return { kind: 'error', text: `未知子命令：${head}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/* ------------------------------------------------------------------ apply */

/**
 * 安装项目隔离能力。
 * @param ctx - 插件上下文。
 * @param rawConfig - 来自 patch 层的原始配置（未校验，插件内部归一化）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const scope = new ProjectScope(ctx, config)
  const installed = new Map()

  ctx.effect(() => ctx.tools.register(buildTool(scope)), 'project-scope.tool')
  ctx.effect(() => ctx.commands.register(buildCommand(scope)), 'project-scope.command')

  const install = (agent) => {
    if (agent === undefined || installed.has(agent.id)) return
    try {
      installed.set(agent.id, installForAgent(ctx, scope, agent))
    } catch (error) {
      ctx.logger?.warn?.(`project-scope: 安装 agent 失败 ${String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = installed.get(agent.id)
    if (dispose === undefined) return
    installed.delete(agent.id)
    scope.promptCache.delete(agent.id)
    scope.strayCache.delete(agent.id)
    dispose()
  })

  try {
    for (const agent of ctx.agents.list()) install(agent)
  } catch {
    /* 启动期 agent 列表不可读时，后续 agent/created 会补齐 */
  }

  ctx.effect(
    () => () => {
      for (const [id, dispose] of installed) {
        installed.delete(id)
        dispose()
      }
      scope.promptCache.clear()
      scope.strayCache.clear()
    },
    'project-scope.teardown',
  )
}
