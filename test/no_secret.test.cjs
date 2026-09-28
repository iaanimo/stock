#!/usr/bin/env node
// test/no_secret.test.cjs —— 推送前的密钥防泄漏自检
//
// 干什么：保证「要推上 GitHub 的文件」里没有任何真实密钥。跑一次几秒钟，命中即红。
//   ① 待推送清单 = git 追踪 + 未被忽略的新文件（就是 git 会推上去的东西）
//   ② 形态扫描：sk- / GitHub token / AWS key / 私钥块，命中即红（纯 x 占位符放行）
//   ③ 真值比对：把环境变量里的 KEY/TOKEN/SECRET 值、以及命令行传入的凭据文件里的值，
//      拿去逐字节搜每个待推送文件——搜到哪个文件就点名，**值本身永远不打印**
//   ④ 钉死 .env 和凭据文件本身不许出现在待推送清单里
//
// 用法：
//   node test/no_secret.test.cjs
//   node test/no_secret.test.cjs "D:\path\to\.credentials.yaml"   # 把凭据文件里的值也拉来比对（更强）
//
// 纪律：真 key 只许活在仓库外（.env / 系统环境变量 / 凭据库），绝不写进本仓库任何文件——
// 这个测试就是防「哪天顺手粘进代码」的。

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

// —— 待推送文件清单 ——
function listFiles() {
  try {
    const out = execSync('git ls-files -co --exclude-standard', {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    })
    return { files: out.split(/\r?\n/).filter(Boolean), source: 'git ls-files（追踪 + 未忽略的新文件）' }
  } catch (e) {
    // 没有 git / 环境不给起子进程：退化成扫工作树（按 .gitignore 的常识规则跳过）
    const skip = new Set(['.git', 'node_modules', '__pycache__', '.env', 'tmp'])
    const out = []
    ;(function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(ent.name)) continue
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(abs)
        else out.push(path.relative(ROOT, abs))
      }
    })(ROOT)
    return { files: out, source: '工作树回退扫描（git 不可用）' }
  }
}

// —— 敏感值收集（值只留在内存，任何输出都不带它）——
const SECRET_NAME = /(KEY|TOKEN|SECRET|COOKIE|PASS)/i
function isSecretish(v) {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length < 12) return false
  if (s.includes('://')) return false                 // URL 不是密钥（endpoint/issuer 之类）
  if (/^[A-Za-z]:\\/.test(s)) return false            // Windows 路径不是密钥
  if (/^sk-x+$/i.test(s)) return false                // 纯 x 占位符
  return true
}
function envSecrets() {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) && isSecretish(v)) out['环境变量 ' + k] = v.trim()
  }
  return out
}
function fileSecrets(p) {
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*[:=]\s*['"]?(.+?)['"]?\s*$/)
    if (!m || /^#/.test(m[2])) continue
    if (SECRET_NAME.test(m[1]) && isSecretish(m[2])) out[path.basename(p) + ' 的 ' + m[1]] = m[2].trim()
  }
  return out
}

// —— 形态规则（命中即红；占位符放行）——
const PATTERNS = [
  { name: 'sk- 形态密钥', re: /sk-[A-Za-z0-9_-]{16,}/g, allow: m => /^sk-x+$/i.test(m) },
  { name: 'GitHub token 形态', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, allow: () => false },
  { name: 'AWS AccessKey 形态', re: /AKIA[0-9A-Z]{16}/g, allow: () => false },
  { name: '私钥块', re: /-{5}BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/g, allow: () => false },
]

// —— 开跑 ——
const { files, source } = listFiles()
console.log('\n密钥防泄漏自检（推送前跑一遍）\n')

console.log('① 待推送文件清单')
ok('清单来源可用：' + source + '，共 ' + files.length + ' 个文件', files.length > 0)
ok('.env 不在待推送清单里（真 key 只许活在仓库外）', !files.some(f => /(^|[/\\])\.env$/.test(f)))

console.log('\n② 形态扫描（命中即红；纯 x 占位符放行）')
const texts = new Map()   // relPath -> latin1 文本（按需读一次）
function textOf(rel) {
  if (!texts.has(rel)) {
    try { texts.set(rel, Buffer.from(fs.readFileSync(path.join(ROOT, rel))).toString('latin1')) }
    catch (e) { texts.set(rel, '') }
  }
  return texts.get(rel)
}
for (const p of PATTERNS) {
  const hits = []
  for (const rel of files) {
    for (const m of textOf(rel).matchAll(p.re)) {
      if (!p.allow(m[0])) hits.push(rel)
    }
  }
  ok(p.name + '：' + (hits.length ? hits.length + ' 处命中' : '0 处命中'),
    hits.length === 0, hits.length ? [...new Set(hits)].slice(0, 10).join(' / ') : '')
}

console.log('\n③ 真值比对（拿真 key 原文逐字节搜，值永不打印）')
const secrets = Object.assign({}, envSecrets())
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) continue
  try { Object.assign(secrets, fileSecrets(arg)) } catch (e) { ok('凭据文件可读：' + arg, false, '读不了：' + e.message) }
}
const secretKeys = Object.keys(secrets)
if (!secretKeys.length) {
  ok('本次无可比对的敏感值（空转：环境里没有 KEY/TOKEN/SECRET，也没传凭据文件）', true)
} else {
  const hitsBySource = {}
  for (const [name, val] of Object.entries(secrets)) {
    for (const rel of files) {
      if (textOf(rel).includes(val)) (hitsBySource[name] = hitsBySource[name] || []).push(rel)
    }
  }
  for (const name of secretKeys) {
    const hits = hitsBySource[name]
    ok(name + ' 未出现在任何待推送文件里', !hits, hits ? '泄漏到：' + [...new Set(hits)].join(' / ') : '')
  }
}

console.log('\n④ 凭据文件本身不许进清单')
const credFiles = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (!credFiles.length) {
  ok('没传凭据文件（跳过）', true)
} else {
  for (const arg of credFiles) {
    const base = path.basename(arg)
    ok(base + ' 不在待推送清单里', !files.some(f => path.basename(f) === base))
  }
}

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : ''))
process.exit(fail ? 1 : 0)
