/**
 * dsh-project-scope 的功能自测（不依赖宿主运行时）。
 *
 * 用最小 mock ctx 驱动插件的 apply()，验证：
 *   1. project 工具 create 建出 inputs/work/deliverables + PROJECT.md，并复制参考素材；
 *   2. 提示词段文本包含活跃项目与三个目录；
 *   3. 守卫拒绝项目之外的 write；
 *   4. 守卫拒绝读取兄弟项目；
 *   5. 守卫拒绝覆盖兄弟项目的 glob；
 *   6. present 拒绝 deliverables 之外的文件，deliver 之后放行；
 *   7. sweep 把工作区根目录脚本收进 work/_stray/。
 *
 * 运行：node test/harness.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 用 fileURLToPath 而不是手撕 pathname：后者在非 ASCII 路径下会保留百分号编码，
// 导入时会变成 ERR_MODULE_NOT_FOUND。
const here = dirname(fileURLToPath(import.meta.url))
// 入口从 package.json 的 main 读：换实现文件名时不用再改这里。
const packageRoot = resolve(here, '..')
const pkgManifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const pluginEntry = resolve(packageRoot, pkgManifest.main ?? 'index.js')
const { apply } = await import(pathToFileURL(pluginEntry).href)

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail })
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${condition ? '' : ` — ${detail ?? ''}`}`)
}

/** 极简 cordis ctx。 */
function createHost() {
  const listeners = new Map()
  const disposers = []
  const tools = new Map()
  const commands = new Map()
  const host = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(
          name,
          current.filter((item) => item !== listener),
        )
      }
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          async create(path, title) {
            return { id: `ws-${title ?? 'x'}`, path, title: title ?? 'untitled' }
          },
        }
      }
      return undefined
    },
    logger: { warn: (message) => console.log(`[warn] ${message}`) },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    agents: { list: () => [] },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    async dispatch(name, ...args) {
      for (const listener of listeners.get(name) ?? []) await listener(...args)
    },
    tools_() {
      return tools
    },
    commands_() {
      return commands
    },
  }
  return host
}

function createAgent(sessionId, cwd, host) {
  const sections = []
  const agentListeners = new Map()
  const agentCtx = {
    systemPrompt: {
      getSectionOrder: (orderName) => (orderName === 'PLAN_POLICY' ? 500 : undefined),
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    on(name, listener) {
      const list = agentListeners.get(name) ?? []
      list.push(listener)
      agentListeners.set(name, list)
      return () => {}
    },
  }
  const session = { id: sessionId, header: { cwd } }
  const agent = { id: sessionId, session, ctx: agentCtx }
  return {
    agent,
    sections,
    /** 驱动 tools/pre-execute 守卫，返回决策。 */
    async runTool(name, args) {
      const exec = { callId: 'c1', name, arguments: args, agent }
      let decision
      const list = agentListeners.get('tools/pre-execute') ?? []
      const next = async () => ({ kind: 'allow' })
      for (const listener of list) {
        decision = await listener(exec, decision === undefined ? next : async () => decision)
        if (decision.kind !== 'allow') break
      }
      return decision ?? { kind: 'allow' }
    },
  }
}

const root = await mkdtemp(join(tmpdir(), 'project-scope-test-'))
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, '作业要求.md'), '# 要求\n写 MySQL 代码。\n', 'utf8')
await writeFile(join(workspace, 'probe-leftover.mjs'), 'console.log(1)\n', 'utf8')

const host = createHost()
apply(host, {})

const tool = host.tools_().get('project')
check('注册了 project 工具', tool !== undefined)
check('注册了 /project 命令', host.commands_().get('project') !== undefined)

const probe = createAgent('session-a', workspace, host)
host.emit('agent/created', { agent: probe.agent })
check('注入了提示词段', probe.sections.length === 1)

// 1) create
const created = await tool.execute(
  { action: 'create', name: '数据库课程作业', goal: '完成 MySQL 代码与设计文档', inputs: ['作业要求.md'] },
  { agent: probe.agent, arguments: {} },
)
const projectPath = join(workspace, 'projects', '数据库课程作业')
check('create 返回项目路径', created.project === join('projects', '数据库课程作业'), created.project)
check('建出 inputs/work/deliverables', ['inputs', 'work', 'deliverables'].every((dir) => existsSync(join(projectPath, dir))))
check('写出 PROJECT.md', existsSync(join(projectPath, 'PROJECT.md')))
check('复制了参考素材', existsSync(join(projectPath, 'inputs', '作业要求.md')))
const manifest = await readFile(join(projectPath, 'PROJECT.md'), 'utf8')
check('清单记录了目标', manifest.includes('完成 MySQL 代码与设计文档'), manifest.slice(0, 120))

// 提示词段随活跃项目刷新
const promptText = probe.sections[0].text({})
check('提示词包含活跃项目', promptText.includes('数据库课程作业'), promptText.slice(0, 200))
check('提示词包含三个目录', promptText.includes('inputs') && promptText.includes('work') && promptText.includes('deliverables'))
check('提示词提示散落脚本', promptText.includes('probe-leftover.mjs'), promptText)

// 2) 写作用域
const outsideWrite = await probe.runTool('write', { file_path: join(workspace, 'scratch.mjs'), content: 'x' })
check('拒绝项目外写入', outsideWrite.kind === 'deny', JSON.stringify(outsideWrite))

const insideWrite = await probe.runTool('write', { file_path: join(projectPath, 'work', 'build.mjs'), content: 'x' })
check('放行项目内写入', insideWrite.kind === 'allow', JSON.stringify(insideWrite))

// 3) 兄弟项目读隔离
const second = await tool.execute({ action: 'create', name: '第二次作业' }, { agent: probe.agent, arguments: {} })
const sibling = join(workspace, 'projects', '第二次作业')
check('第二个项目已建', existsSync(sibling), second.project)
// create 之后活跃项目变成第二次作业，这里切回第一个
await tool.execute({ action: 'use', name: '数据库课程作业' }, { agent: probe.agent, arguments: {} })

const siblingRead = await probe.runTool('read', { file_path: join(sibling, 'PROJECT.md') })
check('拒绝读取兄弟项目', siblingRead.kind === 'deny', JSON.stringify(siblingRead))

const wideGlob = await probe.runTool('glob', { pattern: '**/*.md', path: workspace })
check('拒绝覆盖兄弟项目的检索', wideGlob.kind === 'deny', JSON.stringify(wideGlob))

const scopedGlob = await probe.runTool('glob', { pattern: '**/*.md', path: projectPath })
check('放行收窄后的检索', scopedGlob.kind === 'allow', JSON.stringify(scopedGlob))

// 4) 交付归位
await writeFile(join(projectPath, 'work', 'schema.sql'), 'CREATE TABLE t (id INT);\n', 'utf8')
const earlyPresent = await probe.runTool('present', {
  files: [{ path: join(projectPath, 'work', 'schema.sql') }],
})
check('拒绝 present 过程文件', earlyPresent.kind === 'deny', JSON.stringify(earlyPresent))

const delivered = await tool.execute(
  { action: 'deliver', files: [join(projectPath, 'work', 'schema.sql')] },
  { agent: probe.agent, arguments: {} },
)
check('deliver 归入交付目录', delivered.files?.[0]?.endsWith(join('deliverables', 'schema.sql')), JSON.stringify(delivered))

// 相对路径两种写法都要能解析（工作区相对 / 项目相对）
await writeFile(join(projectPath, 'work', 'doc.md'), '# 设计文档\n', 'utf8')
const relWorkspace = await tool.execute(
  { action: 'deliver', files: ['projects/数据库课程作业/work/doc.md'] },
  { agent: probe.agent, arguments: {} },
)
check(
  'deliver 接受工作区相对路径',
  relWorkspace.files?.[0]?.endsWith(join('deliverables', 'doc.md')),
  JSON.stringify(relWorkspace),
)
await writeFile(join(projectPath, 'work', 'erd.md'), '# ERD\n', 'utf8')
const relProject = await tool.execute({ action: 'deliver', files: ['work/erd.md'] }, { agent: probe.agent, arguments: {} })
check(
  'deliver 接受项目相对路径',
  relProject.files?.[0]?.endsWith(join('deliverables', 'erd.md')),
  JSON.stringify(relProject),
)
const afterPresent = await probe.runTool('present', {
  files: [{ path: join(projectPath, 'deliverables', 'schema.sql') }],
})
check('放行交付目录内的 present', afterPresent.kind === 'allow', JSON.stringify(afterPresent))

// 5) 收拢散落脚本
const swept = await tool.execute({ action: 'sweep' }, { agent: probe.agent, arguments: {} })
check('sweep 移动了散落脚本', swept.files?.length === 1, JSON.stringify(swept))
check('脚本进入 work/_stray', existsSync(join(projectPath, 'work', '_stray', 'probe-leftover.mjs')))
check('写下了 MOVED.md', existsSync(join(projectPath, 'work', '_stray', 'MOVED.md')))

// 6) status / list
const status = await tool.execute({ action: 'status' }, { agent: probe.agent, arguments: {} })
check('status 列出已交付文件', Array.isArray(status.files) && status.files.includes('schema.sql'), JSON.stringify(status))
const list = await tool.execute({ action: 'list' }, { agent: probe.agent, arguments: {} })
check('list 列出两个项目', list.projects?.length === 2, JSON.stringify(list))

// 7) reset 后回到无活跃项目
await tool.execute({ action: 'reset' }, { agent: probe.agent, arguments: {} })
const afterReset = await tool.execute({ action: 'status' }, { agent: probe.agent, arguments: {} })
check('reset 后无活跃项目', afterReset.project === undefined, JSON.stringify(afterReset))

// 严格模式：没有活跃项目时 write 直接被拒，不再落回工作区根目录
const noProjectWrite = await probe.runTool('write', { file_path: join(workspace, 'stray.mjs'), content: 'x' })
check('无活跃项目时拒绝写入', noProjectWrite.kind === 'deny', JSON.stringify(noProjectWrite))
const noProjectSiblingRead = await probe.runTool('read', { file_path: join(sibling, 'PROJECT.md') })
check('无活跃项目时仍拒绝读别的项目', noProjectSiblingRead.kind === 'deny', JSON.stringify(noProjectSiblingRead))

// 8) 命令处理器
const command = host.commands_().get('project')
const commandOut = await command.handler({
  commandId: 'cmd1',
  agent: probe.agent,
  rawInput: 'new 第三次作业 | 复查',
  attachments: [],
  signal: new AbortController().signal,
})
check('命令 new 生效', commandOut.kind === 'success', JSON.stringify(commandOut))
check('命令建出第三个项目', existsSync(join(workspace, 'projects', '第三次作业')))

await rm(root, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
