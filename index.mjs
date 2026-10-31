// opencode-cnb-account — Magpie / OpenCode provider plugin for CNB (cnb.cool).
//
// 设计要点（读完 USEMAGPIE 插件契约后确定的硬约束）：
//  1. magpie 只调用 config / auth(methods,loader,usage,refresh,checkin) / provider.models / chat.headers / tool。
//  2. 插件页面跑在 sandbox="allow-scripts" + connect-src 'none' 的框架里，页面**不能发网络请求**。
//     所以所有 CNB 网络调用都发生在宿主侧（Bun），页面只读宿主写出的 page/state.js 快照。
//  3. AI 通道有三条，由 transport 决定：
//       relay  —— 路线 A（官方工作区 + 中继机），OpenAI 兼容，原生 tools。
//       cookie —— 路线 B（浏览器登录态直连 cnb.cool/<org>/<repo>/-/ai/chat/completions），不支持 tools。
//       direct —— 直连 api.cnb.cool，官方文档写明只允许在流水线内用 CNB_TOKEN 调用（保留用于实验/流水线环境）。
//  4. 上游只吃 stream:true；非流式请求由本插件把 SSE 折叠成一次性 JSON。
//  5. 所有请求必须带 User-Agent，否则 Cloudflare 回 403 error 1010。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PROVIDER_ID = "cnb"
const PROVIDER_NAME = "CNB (cnb.cool)"
const NPM = "@ai-sdk/openai-compatible"
const WEB_BASE = "https://cnb.cool"
const API_BASE = "https://api.cnb.cool"
const DEFAULT_MODEL = "deepseek-v4.1-flash"
const PLUGIN_VERSION = "0.2.0"
const USER_AGENT = `opencode-cnb-account/${PLUGIN_VERSION}`

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, "page", "state.js")
const PAGE_DIR = join(HERE, "page")

// ---------------------------------------------------------------------------
// 控制台路由（从 cnb.cool 前端 bundle 里抓到的真实路径，别改）
// ---------------------------------------------------------------------------
const ROUTES = Object.freeze({
  identity: `${WEB_BASE}/user/identity`, // 实名认证
  extIdentity: `${WEB_BASE}/user/ext_identity`, // 扩展身份：高校 / 天才 / TDP
  extIdentityPrivilege: `${WEB_BASE}/user/charge/ext_identity/privilege`, // 认证特权额度
  quota: `${WEB_BASE}/user/quota`, // 额度总览
  newRepo: `${WEB_BASE}/new/repos`, // 新建仓库
  newGroup: `${WEB_BASE}/new/groups`, // 新建组织
  newMission: `${WEB_BASE}/new/missions`, // 新建任务集
  profile: `${WEB_BASE}/profile`,
  token: `${WEB_BASE}/profile/token`, // 访问令牌管理（bundle 里的 /profile/token/create 的父路由）
})

// ---------------------------------------------------------------------------
// 模型表（CNB 实际只有 deepseek-v4.1-flash 在真干活，其余是静默 fallback 别名）
// ---------------------------------------------------------------------------
const MODEL_SPECS = Object.freeze([
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 64_000 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", context: 1_000_000, output: 64_000 },
  { id: "glm-5.3", name: "GLM 5.3", context: 1_000_000, output: 64_000, reasoning: true },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", context: 1_000_000, output: 131_072, reasoning: true },
  { id: "glm-5.3-flash-vision", name: "GLM 5.3 Flash Vision", context: 1_000_000, output: 32_000, image: true },
  { id: "glm-5.2", name: "GLM 5.2", context: 200_000, output: 32_000 },
  { id: "kimi-k3", name: "Kimi K3", context: 1_000_000, output: 32_000, reasoning: true },
  { id: "hy4-preview", name: "Hunyuan 4 Preview", context: 1_000_000, output: 64_000, reasoning: true },
])

// 认证徽章字典 —— 直接对应 cnb.cool 前端 i18n 键 EXT_IDENTITY_*
const EDU_LABELS = Object.freeze({
  STUDENT: "高校学生",
  TEACHER: "高校老师",
  ALUMNI: "高校校友",
  STAFF: "高校职工",
  ENTERPRISE: "高校合作企业",
  ORGANIZATION: "高校开放实验室",
})

const GENIUS_EDU_LABELS = Object.freeze({
  STUDENT: "天才学生",
  TEACHER: "天才老师",
  ALUMNI: "天才校友",
  STAFF: "天才职工",
  ENTERPRISE: "天才合作企业",
  ORGANIZATION: "天才开放实验室",
})

const GENIUS_BADGE = "天才程序员"
const DEFAULT_VISIBILITY = "private"

const DEFAULT_OPTIONS = Object.freeze({
  org: "",
  repo: "",
  transport: "auto", // auto | relay | cookie | direct
  relay: { url: "", key: "" },
  claim: { url: "", method: "POST", body: "{}" },
  autoCreateRepo: false,
  repoName: "code",
  visibility: DEFAULT_VISIBILITY,
})

class CnbError extends Error {
  constructor(message, { status, signIn, kind } = {}) {
    super(message)
    this.name = "CnbError"
    this.status = status
    this.signIn = signIn
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// 选项与登录态归一化
// ---------------------------------------------------------------------------
function normaliseOptions(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  const out = { ...DEFAULT_OPTIONS }
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  out.org = String(out.org || "").trim().replace(/^\/+|\/+$/g, "")
  out.repo = String(out.repo || "").trim().replace(/^\/+|\/+$/g, "")
  out.transport = String(out.transport || "auto").toLowerCase()
  if (!["auto", "relay", "cookie", "direct"].includes(out.transport)) out.transport = "auto"
  out.relay = { url: String(src.relay?.url || "").trim(), key: String(src.relay?.key || "").trim() }
  out.claim = {
    url: String(src.claim?.url || "").trim(),
    method: String(src.claim?.method || "POST").toUpperCase(),
    body: String(src.claim?.body ?? "{}"),
  }
  out.autoCreateRepo = Boolean(out.autoCreateRepo)
  out.repoName = String(out.repoName || "code").replace(/^\/+|\/+$/g, "") || "code"
  out.visibility = ["public", "private", "secret"].includes(out.visibility) ? out.visibility : DEFAULT_VISIBILITY
  return out
}

/**
 * cnb-cli 写出来的 ~/.cnb/token 长这样（实测结构，别想当然）：
 *
 *   {
 *     "auths": {
 *       "cnb.cool": {
 *         "access_token": "…",      // 94 字符，8 小时
 *         "refresh_token": "…",
 *         "expires_at": 1792419526, // 秒
 *         "client_id": "cnb_cli",
 *         "login_host": "https://api.cnb.cool",
 *         "platform_url": "https://cnb.cool",
 *         "scope": "…"
 *       }
 *     }
 *   }
 *
 * 早期版本只看顶层 access_token 会读成空串 —— 这就是「网页都登录了插件却读不到」的原因。
 */
function pickAuthEntry(json) {
  const auths = json?.auths
  if (auths && typeof auths === "object") {
    const direct = auths["cnb.cool"]
    if (direct && typeof direct === "object") return direct
    for (const value of Object.values(auths)) {
      if (value && typeof value === "object" && (value.access_token || value.token || value.access)) return value
    }
  }
  for (const key of ["cnb", "cnb.cool", "oauth", "token"]) {
    const value = json?.[key]
    if (value && typeof value === "object" && (value.access_token || value.token || value.access)) return value
  }
  return null
}

/** 过期时间统一成毫秒。cnb-cli 写秒，别的实现可能写毫秒。 */
function normalizeExpiry(value) {
  const n = Number(value) || 0
  if (!n) return 0
  return n < 1e12 ? n * 1000 : n
}

function parseTokenText(raw) {
  const text = String(raw || "").trim()
  if (!text) return null
  try {
    const json = JSON.parse(text)
    if (json && typeof json === "object") {
      const entry = pickAuthEntry(json) || json
      const access = entry.access_token || entry.access || entry.token || entry.key || ""
      return {
        token: String(access || ""),
        refresh: String(entry.refresh_token || entry.refresh || ""),
        expires: normalizeExpiry(entry.expires_at ?? entry.expires),
        clientId: String(entry.client_id || "cnb_cli"),
        accountId: String(entry.username || entry.login || json.username || ""),
        source: "",
      }
    }
  } catch {
    /* cnb-cli 早期版本写的是裸 token */
  }
  return { token: text, refresh: "", expires: 0, clientId: "cnb_cli", accountId: "", source: "" }
}

function cliTokenFile() {
  return join(homedir(), ".cnb", "token")
}

function readLocalCnbToken() {
  const candidates = [
    process.env.CNB_TOKEN_FILE,
    cliTokenFile(),
    join(homedir(), ".config", "cnb", "token"),
    join(process.env.APPDATA || "", "cnb", "token"),
    join(process.env.LOCALAPPDATA || "", "cnb", "token"),
  ].filter((p) => p && !p.startsWith("cnb") && p.length > 8)
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const parsed = parseTokenText(readFileSync(file, "utf8"))
        if (parsed?.token || parsed?.refresh) return { ...parsed, source: file }
      }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  const env = String(process.env.CNB_TOKEN || process.env.CNB_CLI_TOKEN || "").trim()
  if (env) return { token: env, refresh: "", expires: 0, clientId: "cnb_cli", accountId: "", source: "CNB_TOKEN 环境变量" }
  return null
}

/**
 * 一键登录失败时最有用的一句话：到底找过哪些位置、每个位置怎么了。
 * 新人看到「读不到」只会一脸问号。
 */
function describeLocalTokenProbe() {
  const lines = []
  const files = [process.env.CNB_TOKEN_FILE, cliTokenFile(), join(homedir(), ".config", "cnb", "token")].filter(Boolean)
  for (const file of files) {
    if (!existsSync(file)) {
      lines.push(`没有 ${file}`)
      continue
    }
    try {
      const parsed = parseTokenText(readFileSync(file, "utf8"))
      if (!parsed?.token && !parsed?.refresh) lines.push(`${file} 存在但没有 access_token 字段`)
      else if (parsed.expires && parsed.expires < Date.now() && !parsed.refresh) lines.push(`${file} 里的令牌已过期且没有 refresh_token`)
    } catch (error) {
      lines.push(`${file} 解析失败：${error?.message || error}`)
    }
  }
  if (!process.env.CNB_TOKEN) lines.push("没有 CNB_TOKEN 环境变量")
  return lines
}


function tokenFromAuth(auth) {
  return auth?.access || auth?.token || auth?.key || null
}

/** auth 对象 -> 统一的连接上下文。每个账号只从自己的 auth 派生，绝不用模块级变量存账号状态。 */
function resolveAccount(auth) {
  const token = tokenFromAuth(auth) || readLocalCnbToken()?.token || ""
  const metadata = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const session = String(metadata.session || (auth?.kind === "cookie" ? token : "") || "").trim()
  return {
    token: String(token || "").trim(),
    session,
    csrfkey: String(metadata.csrfkey || "").trim(),
    org: String(auth?.org || metadata.org || "").trim().replace(/^\/+|\/+$/g, ""),
    repo: String(auth?.repo || metadata.repo || "").trim().replace(/^\/+|\/+$/g, ""),
    username: String(auth?.accountId || metadata.username || "").trim(),
  }
}

function pickTransport(account, options) {
  if (options.transport !== "auto") return options.transport
  if (options.relay.url) return "relay"
  if (account.session) return "cookie"
  return "direct"
}

function repoPath(account, options) {
  const explicit = options.repo || account.repo
  if (explicit.includes("/")) return explicit
  const org = options.org || account.org
  if (!org) return ""
  const name = String(explicit || options.repoName || "").replace(/^\/+|\/+$/g, "")
  return name ? `${org}/${name}` : ""
}

function orgSlug(account, options, repo) {
  const org = options.org || account.org
  if (org) return org
  if (repo.includes("/")) return repo.split("/")[0]
  return ""
}

// ---------------------------------------------------------------------------
// 认证徽章归一化 —— 照搬 cnb.cool 前端 components/badge 的判定顺序
// ---------------------------------------------------------------------------
function badgesFromUser(user) {
  const providers = user?.identity_providers && typeof user.identity_providers === "object" ? user.identity_providers : {}
  const eduRaw = providers.edu?.identity_type
  const eduType = typeof eduRaw === "string" ? eduRaw.toUpperCase() : ""
  const hasGenius = Object.prototype.hasOwnProperty.call(providers, "genius")
  const hasEdu = Boolean(eduType)
  const hasObt = Object.prototype.hasOwnProperty.call(providers, "obt_player")
  const hasDayOne = Object.prototype.hasOwnProperty.call(providers, "day_one_player")
  const tdpTag = providers.tdp?.tdp_primary_tag

  const badges = []
  if (hasObt) {
    badges.push({ key: "obt_player", label: "内测玩家", kind: "player", tone: "info", earned: true })
  }
  if (hasDayOne) {
    badges.push({ key: "day_one_player", label: "开服玩家", kind: "player", tone: "info", earned: true })
  }
  if (hasGenius && hasEdu) {
    badges.push({
      key: "genius+edu",
      label: GENIUS_EDU_LABELS[eduType] || GENIUS_BADGE,
      kind: "combined",
      tone: "success",
      earned: true,
      tooltip: `${GENIUS_BADGE} + ${EDU_LABELS[eduType] || "高校认证"}`,
    })
  } else if (hasGenius) {
    badges.push({ key: "genius", label: GENIUS_BADGE, kind: "genius", tone: "success", earned: true })
  } else if (hasEdu) {
    badges.push({ key: "edu", label: EDU_LABELS[eduType] || "高校认证", kind: "edu", tone: "success", earned: true, tooltip: `高校师生 · ${eduType}` })
  }
  if (tdpTag) {
    badges.push({ key: "tdp", label: `TDP ${tdpTag}`, kind: "tdp", tone: "success", earned: true })
  }
  return badges
}

/**
 * /user 的 identity_providers 有时是 null（实测：一个明确拥有「天才程序员专属特权」的账号
 * 也返回 null），但 /charge/special-amount 的 credit_desc 会写出特权来源。
 * 徽章是用户最想看的东西，所以这条兜底不能少。
 */
function badgesFromSpecialClaim(specialText, existing) {
  const text = String(specialText || "")
  if (!text) return []
  const has = (kind) => existing.some((b) => b.kind === kind || b.kind === "combined")
  const extra = []
  if (!has("genius") && /天才/.test(text)) {
    extra.push({ key: "genius", label: GENIUS_BADGE, kind: "genius", tone: "success", earned: true, source: "特权额度说明" })
  }
  if (!has("edu") && /高校/.test(text)) {
    extra.push({ key: "edu", label: "高校认证", kind: "edu", tone: "success", earned: true, source: "特权额度说明" })
  }
  if (!has("tdp") && /TDP/i.test(text)) {
    extra.push({ key: "tdp", label: "TDP 会员", kind: "tdp", tone: "success", earned: true, source: "特权额度说明" })
  }
  return extra
}

function collectBadges(user, special) {
  const fromUser = badgesFromUser(user)
  return [...fromUser, ...badgesFromSpecialClaim(special?.credit_desc, fromUser)]
}

/**
 * 认证入口清单：哪些认证可以拿、现在是什么状态、点进去是哪个页面、能带多少积分。
 * giveaway 里的数字是「这个认证在 CNB 侧对应的额度档位」，由 special-amount / quota 的真实数据兜底，
 * 拿不到真实数字时只用文案，不编数字。
 */
function identityEntrances(badges) {
  // genius + edu 会被合并成一枚「天才X」徽章，所以两者都要认 combined
  const hasGenius = badges.some((b) => b.kind === "genius" || b.kind === "combined")
  const eduBadge = badges.find((b) => b.kind === "edu" || b.kind === "combined")
  const hasEdu = Boolean(eduBadge)
  return [
    {
      id: "edu",
      title: "高校认证（高校师生）",
      desc: "高校学生 / 老师 / 校友 / 职工 / 合作企业 / 开放实验室",
      earned: hasEdu,
      label: eduBadge?.label || "",
      url: ROUTES.extIdentity,
      urlLabel: "去认证 / 查看",
      reward: "认证后解锁高校师生专属额度档位",
    },
    {
      id: "genius",
      title: "天才程序员",
      desc: "CNB 天才计划徽章，与高校身份可叠加为「天才学生 / 天才老师」",
      earned: hasGenius,
      label: hasGenius ? GENIUS_BADGE : "",
      url: ROUTES.extIdentity,
      urlLabel: "去申请 / 查看",
      reward: "天才计划专属特权额度",
    },
    {
      id: "tdp",
      title: "TDP 会员",
      desc: "TDP 主标签，显示在徽章行",
      earned: badges.some((b) => b.kind === "tdp"),
      label: badges.find((b) => b.kind === "tdp")?.label || "",
      url: ROUTES.extIdentity,
      urlLabel: "去开通 / 查看",
      reward: "TDP 会员特权额度",
    },
    {
      id: "realname",
      title: "实名认证",
      desc: "微信扫码 + 手机号实名，未实名的账号额度会被回收",
      earned: null,
      label: "",
      url: ROUTES.identity,
      urlLabel: "去实名",
      reward: "全部免费额度的前置条件",
    },
    {
      id: "privilege",
      title: "认证特权积分",
      desc: "各认证叠加后生效的特权额度，含 Credit / 核时 / 存储",
      earned: null,
      label: "",
      url: ROUTES.extIdentityPrivilege,
      urlLabel: "查看特权额度",
      reward: "按认证项累加",
    },
    {
      id: "quota",
      title: "额度总览",
      desc: "当月 Credit、云原生开发核时、云原生构建核时、存储",
      earned: null,
      label: "",
      url: ROUTES.quota,
      urlLabel: "打开额度页",
      reward: "免费 500 / 月，完成 hello-cnb 挑战后 1166 / 月",
    },
  ]
}

// ---------------------------------------------------------------------------
// HTTP 基础
// ---------------------------------------------------------------------------
function abortSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 20_000))
  if (!parent) return timeout
  if (typeof AbortSignal.any === "function") return AbortSignal.any([parent, timeout])
  return parent
}

function baseHeaders(extra = {}) {
  // Cloudflare 会 403 掉没有 UA 的请求（error 1010），这条不能省。
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    ...extra,
  }
}

async function readBody(response) {
  const raw = await response.text()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function errorText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body.slice(0, 400)
  return String(body.msg || body.errmsg || body.message || body.error?.message || JSON.stringify(body)).slice(0, 400)
}

function loginBroken(status, body) {
  const text = errorText(body).toLowerCase()
  if (status === 401) return !/model|not available|model_not_found|模型不支持/.test(text) || /token|key|session|login|登录/.test(text)
  if (status === 403) return /not_logged_in|login|session|csrf|登录|未登录/.test(text)
  return false
}

/** api.cnb.cool 调用：用 PAT / Bearer。 */
async function cnbApi(path, { token, method = "GET", body, signal, timeoutMs = 20_000, query } = {}) {
  if (!token) throw new CnbError("未提供 CNB Token", { status: 401, signIn: "expired" })
  let url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`
  if (query && typeof query === "object") {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += `${url.includes("?") ? "&" : "?"}${s}`
  }
  let response
  try {
    response = await fetch(url, {
      method,
      headers: baseHeaders({
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: abortSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    throw new CnbError(`CNB API 请求失败：${error?.message || error}`)
  }
  const parsed = await readBody(response)
  if (!response.ok) {
    throw new CnbError(`CNB API ${method} ${path} → ${response.status} ${errorText(parsed)}`, {
      status: response.status,
      signIn: loginBroken(response.status, parsed) ? "expired" : undefined,
    })
  }
  return parsed
}

/** cnb.cool 网页侧调用：用 CNBSESSION + csrfkey，主要给建仓 / 领积分这类没有公开 API 的动作兜底。 */
async function cnbWeb(path, { session, csrfkey, method = "GET", body, signal, timeoutMs = 20_000, csrfToken } = {}) {
  if (!session) throw new CnbError("缺少 CNBSESSION", { status: 401, signIn: "expired" })
  const cookies = [`CNBSESSION=${session}`]
  if (csrfkey) cookies.push(`csrfkey=${csrfkey}`)
  const headers = baseHeaders({
    Cookie: cookies.join("; "),
    Origin: WEB_BASE,
    Referer: `${WEB_BASE}/`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(csrfToken ? { Csrftoken: csrfToken } : {}),
  })
  const url = path.startsWith("http") ? path : `${WEB_BASE}${path.startsWith("/") ? path : `/${path}`}`
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: abortSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    throw new CnbError(`CNB Web 请求失败：${error?.message || error}`)
  }
  return response
}

// ---------------------------------------------------------------------------
// OAuth 续期：cnb-cli 用的是标准 OAuth2 refresh_token，端点实测在 cnb.cool
// ---------------------------------------------------------------------------
const OAUTH_TOKEN_URL = `${WEB_BASE}/oauth2/token`

/**
 * 用 refresh_token 换新 access_token。
 * 实测：POST https://cnb.cool/oauth2/token
 *   grant_type=refresh_token & refresh_token=… & client_id=cnb_cli
 * → { access_token, expires_in(≈28799), refresh_token, scope, token_type: "bearer" }
 */
async function refreshCnbToken({ refresh, clientId = "cnb_cli", signal } = {}) {
  if (!refresh) return null
  let response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: baseHeaders({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(refresh),
        client_id: String(clientId || "cnb_cli"),
      }),
      signal: abortSignal(signal, 20_000),
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    return null
  }
  const data = await readBody(response)
  if (!response.ok || !data?.access_token) return null
  return {
    access: String(data.access_token),
    refresh: String(data.refresh_token || refresh),
    expires: Date.now() + (Number(data.expires_in) || 28_800) * 1000,
  }
}

/**
 * 把刷新后的令牌写回 ~/.cnb/token，让 cnb-cli 也跟着新 —— 不然用户 CLI 那边还是过期的。
 * 写之前备份成 token.bak-YYYYMMDD（和 cnb-cli 自己的命名一致）。失败就算了，不影响登录。
 */
function writeBackCliToken(fresh) {
  const file = cliTokenFile()
  try {
    if (!existsSync(file)) return false
    const json = JSON.parse(readFileSync(file, "utf8"))
    const entry = pickAuthEntry(json)
    if (!entry) return false
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const backup = `${file}.bak-${stamp}`
    if (!existsSync(backup)) copyFileSync(file, backup)
    entry.access_token = fresh.access
    entry.refresh_token = fresh.refresh
    entry.expires_at = Math.floor(fresh.expires / 1000)
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** 抓首页拿 csrftoken（HTML 里的 window.csrftoken="…"）与 csrfkey（Set-Cookie）。 */
async function grabCsrf(session, { signal } = {}) {
  const response = await cnbWeb("/", { session, signal, timeoutMs: 20_000 })
  const html = await response.text()
  const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]+)"/)?.[1] || ""
  let key = ""
  const setCookie = response.headers.getSetCookie?.() || []
  for (const line of setCookie) {
    const m = /(?:^|\s)csrfkey=([^;]+)/.exec(line)
    if (m) key = m[1]
  }
  // 登录态有效性：匿名首页 ~145KB，登录态 ~350KB（手册 5.1 节实测）
  return { csrfToken: token, csrfkey: key, htmlLength: html.length, looksLoggedIn: html.length > 200_000 }
}

// ---------------------------------------------------------------------------
// CNB 数据读取（宿主侧）
// ---------------------------------------------------------------------------
async function fetchUser(token, { signal } = {}) {
  const data = await cnbApi("/user", { token, signal, timeoutMs: 15_000 })
  return data && typeof data === "object" ? data : null
}

async function fetchTopGroups(token, { signal } = {}) {
  try {
    const data = await cnbApi("/user/groups", { token, query: { page: 1, page_size: 50 }, signal, timeoutMs: 15_000 })
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
    return list
      .map((g) => ({
        path: String(g?.path || g?.slug || "").replace(/^\/+|\/+$/g, ""),
        name: String(g?.name || g?.path || ""),
        access: g?.access_role ?? null,
      }))
      .filter((g) => g.path)
  } catch {
    return []
  }
}

async function fetchQuota(token, org, { signal } = {}) {
  if (!org) return null
  try {
    return await cnbApi(`/${org}/-/charge/quota`, { token, signal, timeoutMs: 15_000 })
  } catch {
    return null
  }
}

async function fetchVolume(token, org, { signal } = {}) {
  if (!org) return null
  try {
    return await cnbApi(`/${org}/-/charge/volume`, { token, signal, timeoutMs: 15_000 })
  } catch {
    return null
  }
}

async function fetchSpecialAmount(token, org, { signal } = {}) {
  if (!org) return null
  try {
    return await cnbApi(`/${org}/-/charge/special-amount`, { token, signal, timeoutMs: 15_000 })
  } catch {
    return null
  }
}

async function listRepos(token, org, { signal } = {}) {
  if (!org) return []
  try {
    const data = await cnbApi(`/${org}/-/repos`, { token, query: { page: 1, page_size: 50 }, signal, timeoutMs: 15_000 })
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
    return list.map((r) => String(r?.path || r?.slug || r?.name || "")).filter(Boolean)
  } catch {
    return []
  }
}

/** 建仓：POST /{slug}/-/repos { name, description, visibility } */
async function createRepo({ token, org, name, description, visibility, signal }) {
  const slug = String(org || "").replace(/^\/+|\/+$/g, "")
  if (!slug) throw new CnbError("缺少组织 slug，无法建仓")
  const repoName = String(name || "").replace(/^\/+|\/+$/g, "").split("/").pop()
  if (!repoName) throw new CnbError("缺少仓库名")
  try {
    const result = await cnbApi(`/${slug}/-/repos`, {
      token,
      method: "POST",
      body: { name: repoName, description: String(description || "AI 网关工作区（由 magpie 插件创建）"), visibility },
      signal,
      timeoutMs: 30_000,
    })
    return { ok: true, path: `${slug}/${repoName}`, url: `${WEB_BASE}/${slug}/${repoName}`, raw: result }
  } catch (error) {
    return {
      ok: false,
      path: `${slug}/${repoName}`,
      url: ROUTES.newRepo,
      error: error?.message || String(error),
      manual: [
        `1. 打开 ${ROUTES.newRepo}`,
        `2. 组织选 ${slug}，仓库名填 ${repoName}`,
        `3. 可见性选 private（.cnb.yml 里会写明文密钥）`,
        `4. 建完把仓库路径 ${slug}/${repoName} 填进插件选项 repo`,
      ],
    }
  }
}

// ---------------------------------------------------------------------------
// 快照：宿主写 page/state.js，页面只读它（页面没有网络权限）
// ---------------------------------------------------------------------------
const snapshots = new Map() // accountKey -> { at, data }

function accountKey(account, options) {
  return [account.username || account.token.slice(-8), options.org, options.repo, options.transport].join("|")
}

function cachedSnapshot(key, ttlMs = 60_000) {
  const hit = snapshots.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > ttlMs) return null
  return hit.data
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function milliToCredit(milli) {
  const n = numberOrNull(milli)
  return n === null ? null : Math.round((n / 1000) * 100) / 100
}

function secToCoreHour(sec) {
  const n = numberOrNull(sec)
  return n === null ? null : Math.round((n / 3600) * 100) / 100
}

function bytesToGiB(bytes) {
  const n = numberOrNull(bytes)
  return n === null ? null : Math.round((n / 1024 ** 3) * 100) / 100
}

function nextMonthReset() {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  return next.toISOString()
}

function buildCreditView(quota, volume, special) {
  const totalMilli = numberOrNull(quota?.credit_in_milli?.total)
  const freeMilli = numberOrNull(quota?.credit_in_milli?.free)
  const usedMilli = numberOrNull(volume?.credit_in_milli)
  const frozenMilli = numberOrNull(volume?.freeze_credit_in_milli)
  const specialCredit = numberOrNull(special?.credit)

  const total = milliToCredit(totalMilli)
  const free = milliToCredit(freeMilli)
  const used = milliToCredit(usedMilli)
  const frozen = milliToCredit(frozenMilli)
  const privilege = total !== null && free !== null ? Math.round((total - free) * 100) / 100 : null
  const pct = used !== null && total ? Math.round((used / total) * 1000) / 10 : null

  return {
    total,
    free,
    used,
    frozen,
    privilege,
    special: specialCredit,
    specialDesc: String(special?.credit_desc || ""),
    specialExpire: String(special?.credit_expire || ""),
    percent: pct,
    unit: "credits",
    resetsAt: nextMonthReset(),
  }
}

function buildSideQuotas(quota, volume) {
  const rows = []
  const push = (name, quotaKey, volumeKey, converter, unit) => {
    const limit = numberOrNull(quota?.[quotaKey]?.total)
    const used = numberOrNull(volume?.[volumeKey])
    if (limit === null && used === null) return
    rows.push({
      name,
      amount: converter(used),
      limit: converter(limit),
      unit,
      aside: true,
    })
  }
  push("云原生开发", "dev_in_sec", "dev_in_sec", secToCoreHour, "core·h")
  push("云原生构建", "ci_in_sec", "ci_in_sec", secToCoreHour, "core·h")
  push("Git 存储", "git_in_byte", "git_in_byte", bytesToGiB, "GiB")
  push("对象存储", "object_in_byte", "object_in_byte", bytesToGiB, "GiB")
  return rows
}

function buildSnapshot({ user, groups, quota, volume, special, repos, account, options, transport, extra = {} }) {
  const repo = repoPath(account, options)
  const org = orgSlug(account, options, repo)
  const badges = collectBadges(user, special)
  const credit = buildCreditView(quota, volume, special)
  const entrances = identityEntrances(badges)
  const realnameVerified = Boolean(user?.verified)

  return {
    generatedAt: new Date().toISOString(),
    plugin: { name: "opencode-cnb-account", version: PLUGIN_VERSION, provider: PROVIDER_ID },
    transport,
    account: {
      username: String(user?.username || account.username || ""),
      nickname: String(user?.nickname || ""),
      email: String(user?.email || ""),
      avatar: String(user?.avatar || ""),
      id: String(user?.id || ""),
      verified: numberOrNull(user?.verified) ?? null,
      verifiedExpireIn: String(user?.verified_expire_in || ""),
      badges,
      hasGenius: badges.some((b) => b.kind === "genius" || b.kind === "combined"),
      hasEdu: badges.some((b) => b.kind === "edu" || b.kind === "combined"),
      hasTdp: badges.some((b) => b.kind === "tdp"),
    },
    scope: {
      org,
      repo,
      groups: groups.slice(0, 20),
      repos: repos.slice(0, 20),
    },
    credit,
    sideQuotas: buildSideQuotas(quota, volume),
    entrances,
    routes: ROUTES,
    realnameVerified,
    signIn: extra.signIn || undefined,
    hints: extra.hints || [],
    error: extra.error || "",
  }
}

function publishState(snapshot) {
  const payload = JSON.stringify(snapshot)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  const js = `/* generated by opencode-cnb-account — ${snapshot.generatedAt}\n * 页面没有网络权限，这份快照是宿主（Bun）侧写出来的唯一数据来源。\n * 重新生成：在 magpie 里读一次额度，或调用任一 cnb_* 工具。\n */\nwindow.__CNB_STATE__ = ${payload};\n`
  try {
    mkdirSync(PAGE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, js, "utf8")
    return true
  } catch {
    return false
  }
}

/** 采集一份完整快照（带 60s 缓存），并顺手刷新 page/state.js。 */
async function refreshSnapshot({ auth, options, signal, force = false, extra = {} }) {
  const account = resolveAccount(auth)
  const transport = pickTransport(account, options)
  const key = accountKey(account, options)
  if (!force) {
    const hit = cachedSnapshot(key)
    if (hit) {
      publishState(hit)
      return hit
    }
  }
  if (!account.token) {
    const empty = buildSnapshot({
      user: null,
      groups: [],
      quota: null,
      volume: null,
      special: null,
      repos: [],
      account,
      options,
      transport,
      extra: { error: "未登录 CNB" },
    })
    publishState(empty)
    return empty
  }

  let user = null
  let error = ""
  let signIn
  try {
    user = await fetchUser(account.token, { signal })
  } catch (e) {
    error = e?.message || String(e)
    if (e?.signIn === "expired") signIn = "expired"
  }

  const repo = repoPath(account, options)
  const org = orgSlug(account, options, repo)

  const [groups, quota, volume, special, repos] = await Promise.all([
    fetchTopGroups(account.token, { signal }),
    fetchQuota(account.token, org, { signal }),
    fetchVolume(account.token, org, { signal }),
    fetchSpecialAmount(account.token, org, { signal }),
    listRepos(account.token, org, { signal }),
  ])

  const snapshot = buildSnapshot({
    user,
    groups,
    quota,
    volume,
    special,
    repos,
    account,
    options,
    transport,
    extra: { hints: extra.hints, error, signIn },
  })
  snapshots.set(key, { at: Date.now(), data: snapshot })
  publishState(snapshot)
  return snapshot
}

// ---------------------------------------------------------------------------
// AI 通道：SSE 折叠 / 错误映射
// ---------------------------------------------------------------------------
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  })
}

function chatError(message, { status = 502, type = "cnb_error", signIn } = {}) {
  return jsonResponse({ error: { message, type } }, status, signIn ? { "X-Magpie-Sign-In": signIn } : {})
}

async function requestBody(input, init) {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (raw == null || raw === "") return {}
  if (typeof raw === "string") return JSON.parse(raw)
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw))
  if (typeof raw === "object") return raw
  throw new TypeError("请求体必须是 JSON")
}

function requestUrl(input) {
  try {
    return input instanceof Request ? input.url : String(input)
  } catch {
    return ""
  }
}

/** 把上游 SSE 折叠成一次性 chat.completion JSON（上游只吃 stream:true）。 */
async function foldSse(response, model) {
  const text = await response.text()
  const chunks = []
  let id = ""
  let created = Math.floor(Date.now() / 1000)
  let finish = "stop"
  let usage = null
  const toolCalls = new Map()

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    let evt
    try {
      evt = JSON.parse(data)
    } catch {
      continue
    }
    if (evt.id) id = evt.id
    if (evt.created) created = evt.created
    if (evt.model) model = evt.model
    if (evt.usage) usage = evt.usage
    const choice = evt.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || choice.message || {}
    if (typeof delta.content === "string" && delta.content) chunks.push(delta.content)
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) chunks.push("")
    for (const call of delta.tool_calls || []) {
      const idx = call.index ?? 0
      const prev = toolCalls.get(idx) || { id: "", type: "function", function: { name: "", arguments: "" } }
      if (call.id) prev.id = call.id
      if (call.function?.name) prev.function.name += call.function.name
      if (call.function?.arguments) prev.function.arguments += call.function.arguments
      toolCalls.set(idx, prev)
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }

  const message = { role: "assistant", content: chunks.join("") }
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  if (!message.content && !message.tool_calls) message.content = ""

  return {
    id: id || `chatcmpl-cnb-${Date.now().toString(36)}`,
    object: "chat.completion",
    created,
    model: model || DEFAULT_MODEL,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

// ---------------------------------------------------------------------------
// loader.fetch 的三条通道
// ---------------------------------------------------------------------------
function buildCookieFetch({ account, options, getAuth }) {
  return async function cookieFetch(input, init = {}) {
    const auth = await getAuth()
    const live = resolveAccount(auth)
    const session = live.session || account.session
    const csrfkey = live.csrfkey || account.csrfkey
    const repo = repoPath(live, options)
    if (!session) return chatError("CNB 浏览器登录态缺失，请用「浏览器登录态」方式重新登录", { status: 401, type: "auth_error", signIn: "expired" })
    if (!repo) return chatError("缺少仓库路径：在插件选项里填 org/repo，或登录时填写", { status: 400, type: "config_error" })

    const url = requestUrl(input)
    if (!url.includes("/chat/completions")) return chatError(`不支持的路径：${url}`, { status: 404, type: "invalid_request_error" })

    let payload
    try {
      payload = await requestBody(input, init)
    } catch (error) {
      return chatError(`请求体解析失败：${error.message}`, { status: 400, type: "invalid_request_error" })
    }
    if (Array.isArray(payload.tools) && payload.tools.length) {
      // 路线 B 结构性拒绝 tools（403 Agent calls are not allowed），提前说清而不是静默降级。
      return chatError(
        "CNB Cookie 通道不支持工具调用（上游返回 403 Agent calls are not allowed）。需要 tools 请把 transport 设为 relay 走路线 A（官方工作区 + 中继机），或在前置挂 ToolForge。",
        { status: 403, type: "model_not_supported" },
      )
    }

    const wantedStream = payload.stream === true
    const clean = { ...payload, stream: true }
    const forbidden = ["tools", "tool_choice", "response_format", "stream_options"]
    for (const key of forbidden) delete clean[key]

    const cookies = [`CNBSESSION=${session}`]
    if (csrfkey) cookies.push(`csrfkey=${csrfkey}`)

    let response
    try {
      response = await fetch(`${WEB_BASE}/${repo}/-/ai/chat/completions`, {
        method: "POST",
        headers: baseHeaders({
          "Content-Type": "application/json",
          Accept: wantedStream ? "text/event-stream" : "application/json",
          Cookie: cookies.join("; "),
          Origin: WEB_BASE,
          Referer: `${WEB_BASE}/${repo}`,
          ...(csrfkey ? { Csrftoken: csrfkey } : {}),
        }),
        body: JSON.stringify(clean),
        signal: init.signal,
      })
    } catch (error) {
      if (error?.name === "AbortError") throw error
      return chatError(`连不上 cnb.cool：${error?.message || error}`)
    }

    const contentType = response.headers.get("content-type") || ""
    if (!response.ok || contentType.includes("text/html")) {
      const body = await readBody(response)
      const message = contentType.includes("text/html")
        ? `上游返回 HTML（${response.status}），通常说明仓库路径不对或登录态过期：${WEB_BASE}/${repo}/-/ai/chat/completions`
        : `CNB 上游 ${response.status}：${errorText(body)}`
      return chatError(message, {
        status: response.status === 200 ? 502 : response.status,
        type: "cnb_error",
        signIn: loginBroken(response.status, body) ? "expired" : undefined,
      })
    }

    if (wantedStream) {
      return new Response(response.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      })
    }
    const folded = await foldSse(response, String(clean.model || DEFAULT_MODEL))
    return jsonResponse(folded, 200, { "X-Magpie-Sign-In": "kept" })
  }
}

function buildDirectFetch({ account, options, getAuth }) {
  return async function directFetch(input, init = {}) {
    const auth = await getAuth()
    const live = resolveAccount(auth)
    const token = live.token || account.token
    const repo = repoPath(live, options)
    if (!token) return chatError("未登录 CNB", { status: 401, type: "auth_error", signIn: "expired" })
    if (!repo) return chatError("缺少仓库路径：在插件选项里填 org/repo", { status: 400, type: "config_error" })

    let payload
    try {
      payload = await requestBody(input, init)
    } catch (error) {
      return chatError(`请求体解析失败：${error.message}`, { status: 400, type: "invalid_request_error" })
    }
    const wantedStream = payload.stream === true
    const clean = { ...payload, stream: true }
    delete clean.tools
    delete clean.tool_choice
    delete clean.stream_options

    let response
    try {
      response = await fetch(`${API_BASE}/${repo}/-/ai/chat/completions`, {
        method: "POST",
        headers: baseHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
        body: JSON.stringify(clean),
        signal: init.signal,
      })
    } catch (error) {
      if (error?.name === "AbortError") throw error
      return chatError(`连不上 api.cnb.cool：${error?.message || error}`)
    }

    if (!response.ok) {
      const body = await readBody(response)
      return chatError(
        `api.cnb.cool ${response.status}：${errorText(body)}\n官方文档写明 /-/ai/chat/completions 仅允许在 CNB 流水线内用 CNB_TOKEN 调用；个人 PAT 直连会被拒。请改用 transport=relay（路线 A）或 cookie（路线 B）。`,
        { status: response.status, type: "cnb_error", signIn: loginBroken(response.status, body) ? "expired" : undefined },
      )
    }
    if (wantedStream) {
      return new Response(response.body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
    }
    const folded = await foldSse(response, String(clean.model || DEFAULT_MODEL))
    return jsonResponse(folded, 200, { "X-Magpie-Sign-In": "kept" })
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
function authMethods(options) {
  return [
    // -----------------------------------------------------------------------
    // 方式一：一键登录。0 个问题，读本机已有的 CNB 凭证；过期了自动用 refresh_token 续期。
    // -----------------------------------------------------------------------
    {
      type: "oauth",
      label: "一键登录（读取本机已登录的 CNB 凭证）",
      async authorize() {
        const local = readLocalCnbToken()
        return {
          url: ROUTES.token,
          instructions: local?.token
            ? "已在本机找到 CNB 凭证，正在校验（过期会自动续期）…"
            : "本机没找到 CNB 凭证。刚打开的页面里可以生成一个访问令牌，复制后回来点「粘贴访问令牌」；或者装一下 CLI 再回来点这个按钮：npm i -g @cnbcool/cnb-cli && cnb login",
          method: "auto",
          async callback() {
            return authorizeFromLocal(options)
          },
        }
      },
    },

    // -----------------------------------------------------------------------
    // 方式二：一个输入框。PAT 和 CNBSESSION 都接受，插件自己认 —— 用户不需要选。
    // -----------------------------------------------------------------------
    {
      type: "api",
      label: "粘贴访问令牌（CNB 的 PAT，或浏览器的 CNBSESSION）",
      placeholder: "直接粘贴，不用管是哪一种，插件会自己判断",
      async authorize(inputs) {
        const raw = pickCredential(inputs)
        if (!raw) {
          return {
            type: "failed",
            error: "没有读到输入内容。粘贴 CNB 的访问令牌（在 " + ROUTES.token + " 生成），或者浏览器里 CNBSESSION 的值。",
          }
        }
        const who = await identifyCredential(raw)
        if (who.kind === "pat") return successFromPat({ options, token: raw, user: who.user })
        if (who.kind === "session") return successFromSession({ options, session: raw, csrf: who.csrf })
        return {
          type: "failed",
          error:
            "这个值既不是可用的访问令牌，也不是有效的 CNBSESSION。" +
            "如果是访问令牌，确认它在 " + ROUTES.token + " 生成、复制完整、没过期；" +
            "如果是 CNBSESSION，确认 cnb.cool 还处于登录状态（首页拿到 " + (who.htmlLength || 0) + " 字节，登录态应在 200KB 以上）。",
        }
      },
    },
  ]
}

/** 从 magpie 传来的 inputs 里把用户输入捞出来。不同版本放的 key 不一样，别赌一个。 */
function pickCredential(inputs) {
  if (typeof inputs === "string") return inputs.trim()
  if (!inputs || typeof inputs !== "object") return ""
  for (const key of ["key", "token", "value", "secret", "apiKey", "api_key", "credential"]) {
    const v = inputs[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  for (const v of Object.values(inputs)) {
    if (typeof v === "string" && v.trim().length > 20) return v.trim()
  }
  return ""
}

/**
 * 一个输入框要同时认两种凭证，所以不靠"长得像"猜，直接都试一遍：
 *   1. 当访问令牌打 /user → 200 就是 PAT
 *   2. 当 CNBSESSION 抓首页 → 有登录态就成立
 * 这样用户粘哪个都能进，不用先想清楚自己手里是什么。
 */
async function identifyCredential(raw) {
  const value = String(raw || "").trim()
  let patError = ""
  try {
    const user = await fetchUser(value)
    if (user) return { kind: "pat", user }
    patError = "/user 返回空"
  } catch (error) {
    patError = error?.message || String(error)
  }

  let htmlLength = 0
  try {
    const csrf = await grabCsrf(value)
    htmlLength = csrf.htmlLength
    if (csrf.looksLoggedIn) return { kind: "session", csrf }
  } catch {
    htmlLength = 0
  }

  return { kind: "invalid", patError, htmlLength }
}

function scopeFor(options, groups) {
  const org = String(options.org || groups[0]?.path || "").replace(/^\/+|\/+$/g, "")
  const repo = String(options.repo || (org ? org + "/" + options.repoName : "")).replace(/^\/+|\/+$/g, "")
  return { org, repo }
}

async function successFromPat({ options, token, user }) {
  const groups = await fetchTopGroups(token)
  const { org, repo } = scopeFor(options, groups)
  let created = null
  if (options.autoCreateRepo && org) {
    const existing = await listRepos(token, org)
    if (!repoExists(existing, options.repoName)) {
      created = await createRepo({ token, org, name: options.repoName, visibility: options.visibility })
    }
  }
  return {
    type: "success",
    key: token,
    metadata: {
      org,
      repo,
      username: user.username || "",
      transport: options.transport,
      loginMethod: "pat",
      groups: groups.map((g) => g.path),
      ...(created?.ok ? { createdRepo: created.path } : {}),
      ...(created && !created.ok ? { createRepoError: created.error } : {}),
    },
  }
}

function successFromSession({ options, session, csrf }) {
  const repo = String(options.repo || "").replace(/^\/+|\/+$/g, "")
  const org = repo.includes("/") ? repo.split("/")[0] : options.org
  return {
    type: "success",
    key: session,
    metadata: {
      kind: "cookie",
      session,
      csrfkey: csrf.csrfkey || "",
      csrfToken: csrf.csrfToken || "",
      org,
      repo,
      transport: "cookie",
      loginMethod: "session",
      htmlLength: csrf.htmlLength,
    },
  }
}

/**
 * 一键登录的全部逻辑：读本机凭证 → 校验 → 过期就 refresh → 再校验 → 顺手探测组织和仓库。
 * 每一步失败都给出"接下来该做什么"，而不是一句"登录失败"。
 */
async function authorizeFromLocal(options) {
  const local = readLocalCnbToken()
  if (!local || (!local.token && !local.refresh)) {
    const probe = describeLocalTokenProbe()
    return {
      type: "failed",
      error:
        "本机没有可用的 CNB 凭证（" +
        probe.slice(0, 2).join("；") +
        "）。两条路选一条：① 在 " +
        ROUTES.token +
        " 生成访问令牌，回来点「粘贴访问令牌」；② 跑 npm i -g @cnbcool/cnb-cli && cnb login，再点一次「一键登录」。",
    }
  }

  let token = local.token || ""
  let refresh = local.refresh || ""
  let expires = local.expires || 0
  let user = null
  let refreshed = false

  // 1. 直接校验
  if (token) {
    try {
      user = await fetchUser(token)
    } catch {
      user = null
    }
  }

  // 2. 过期或被拒 → 用 refresh_token 续期（实测 cnb.cool/oauth2/token 可用）
  if (!user && refresh) {
    const fresh = await refreshCnbToken({ refresh, clientId: local.clientId })
    if (fresh) {
      token = fresh.access
      refresh = fresh.refresh
      expires = fresh.expires
      refreshed = true
      writeBackCliToken(fresh)
      try {
        user = await fetchUser(token)
      } catch {
        user = null
      }
    }
  }

  if (!user) {
    return {
      type: "failed",
      error:
        "本机凭证已失效，" +
        (refresh ? "自动续期也失败了" : "而且没有 refresh_token 可以续期") +
        "。跑一次 cnb login 重新扫码，或在 " +
        ROUTES.token +
        " 生成访问令牌后点「粘贴访问令牌」。",
    }
  }

  const groups = await fetchTopGroups(token)
  const { org, repo } = scopeFor(options, groups)

  if (options.autoCreateRepo && org) {
    const existing = await listRepos(token, org)
    if (!repoExists(existing, options.repoName)) {
      await createRepo({ token, org, name: options.repoName, visibility: options.visibility })
    }
  }

  return {
    type: "success",
    access: token,
    refresh,
    expires,
    accountId: user.username || local.accountId || "cnb-user",
    uid: String(user.id || user.username || ""),
    org,
    repo,
    metadata: {
      org,
      repo,
      username: user.username || "",
      transport: options.transport,
      loginMethod: "local",
      source: local.source,
      clientId: local.clientId || "cnb_cli",
      refreshed,
      groups: groups.map((g) => g.path),
    },
  }
}

function repoExists(repos, name) {
  const target = String(name || "").replace(/^\/+|\/+$/g, "").split("/").pop()
  if (!target) return false
  return (repos || []).some((p) => String(p).replace(/^\/+|\/+$/g, "").split("/").pop() === target)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------
const CnbAccountPlugin = async (_input, pluginOptions) => {
  const options = normaliseOptions(pluginOptions)

  return {
    // --- 供应商声明 -----------------------------------------------------------
    config: async (cfg) => {
      cfg.provider ??= {}
      const provider = (cfg.provider[PROVIDER_ID] ??= {})
      provider.name ??= PROVIDER_NAME
      provider.npm ??= NPM
      provider.api ??= options.relay.url ? stripV1(options.relay.url) : WEB_BASE
      provider.models = { ...configModels(), ...(provider.models || {}) }
    },

    // --- 账号 ---------------------------------------------------------------
    auth: {
      provider: PROVIDER_ID,
      maxConcurrency: 4,
      methods: authMethods(options),

      // magpie 会在 access_token 到期前替你续期，同一时间只续一次。
      // CNB 的令牌 8 小时（expires_in≈28800），提前半小时续。
      refreshLead: 30 * 60 * 1000,
      async refresh(auth) {
        const next = await refreshCnbToken({
          refresh: auth?.refresh,
          clientId: auth?.metadata?.clientId || "cnb_cli",
        })
        if (!next) return undefined // 没什么可续的就什么都不返回，账号保持原样
        writeBackCliToken(next)
        return { access: next.access, refresh: next.refresh, expires: next.expires }
      },

      loader: async (getAuth) => {
        const auth = await getAuth()
        const account = resolveAccount(auth)
        const transport = pickTransport(account, options)

        if (transport === "relay") {
          // 路线 A：中继机本身就是 OpenAI 兼容网关，直通即可。
          const base = stripV1(options.relay.url || "")
          if (!base) return { baseURL: WEB_BASE, apiKey: account.token || PROVIDER_ID }
          return { baseURL: `${base}/v1`, apiKey: options.relay.key || PROVIDER_ID }
        }
        if (transport === "cookie") {
          const repo = repoPath(account, options)
          return {
            baseURL: repo ? `${WEB_BASE}/${repo}/-/ai` : `${WEB_BASE}/-/ai`,
            apiKey: PROVIDER_ID,
            fetch: buildCookieFetch({ account, options, getAuth }),
          }
        }
        const repo = repoPath(account, options)
        return {
          baseURL: repo ? `${API_BASE}/${repo}/-/ai` : `${API_BASE}/-/ai`,
          apiKey: account.token || PROVIDER_ID,
          fetch: buildDirectFetch({ account, options, getAuth }),
        }
      },

      // --- 用量 / 积分 ------------------------------------------------------
      async usage(getAuth) {
        const auth = await getAuth()
        const account = resolveAccount(auth)
        if (!account.token) {
          // 只粘了 CNBSESSION 的账号拿不到额度（api.cnb.cool 要 Bearer 令牌），
          // 这不算登录失效，别把账号标红。
          if (account.session) {
            return {
              error: "额度需要访问令牌：在 https://cnb.cool/profile/token 生成 PAT，然后点「粘贴访问令牌」补上（CNBSESSION 只够跑 AI 通道）。",
              windows: [],
            }
          }
          return { error: "未登录 CNB：点「一键登录」，或粘贴访问令牌", signIn: "expired", windows: [] }
        }
        let snapshot
        try {
          snapshot = await refreshSnapshot({ auth, options })
        } catch (error) {
          if (error?.signIn === "expired") return { error: error.message, signIn: "expired", windows: [] }
          return { error: `读取 CNB 额度失败：${error?.message || error}`, windows: [] }
        }
        if (snapshot.signIn === "expired") {
          return { error: snapshot.error || "CNB 登录已失效，请重新登录", signIn: "expired", windows: [] }
        }

        const credit = snapshot.credit
        const badges = snapshot.account.badges || []
        const windows = []

        if (credit.total !== null || credit.used !== null) {
          const parts = []
          if (credit.used !== null) parts.push(`已用 ${credit.used}`)
          if (credit.total !== null) parts.push(`总 ${credit.total}`)
          if (credit.privilege) parts.push(`特权 ${credit.privilege}`)
          windows.push({
            name: "AI Credit（当月）",
            ...(credit.used !== null ? { amount: credit.used } : {}),
            ...(credit.total !== null ? { limit: credit.total } : {}),
            unit: "credits",
            resetsAt: credit.resetsAt,
            display: parts.join(" / ") || "—",
          })
        }
        for (const row of snapshot.sideQuotas || []) windows.push(row)
        if (!windows.length) {
          windows.push({ name: "AI Credit（当月）", display: "额度接口没返回数字（可能是组织 slug 不对）" })
        }

        return {
          plan: badges.map((b) => b.label).join(" · ") || "CNB 免费额度",
          user: snapshot.account.username || account.username || "",
          balance: credit.total !== null ? `${credit.total} credits` : undefined,
          windows,
          signIn: "kept",
        }
      },

      // --- 每日领取 ----------------------------------------------------------
      async checkin(getAuth) {
        const auth = await getAuth()
        const account = resolveAccount(auth)
        if (!options.claim.url) {
          return {
            outcome: "inactive",
            message:
              "CNB 没有公开的「每日签到」接口；免费额度是每月自动发放的。要接入领取动作，把插件选项 claim.url 指向你的领取端点（支持 {{org}}/{{repo}}/{{token}} 占位符）。",
          }
        }
        const url = options.claim.url
          .replaceAll("{{org}}", orgSlug(account, options, repoPath(account, options)))
          .replaceAll("{{repo}}", repoPath(account, options))
          .replaceAll("{{token}}", account.token)
        let payload = {}
        try {
          payload = JSON.parse(options.claim.body || "{}")
        } catch {
          payload = {}
        }
        let response
        try {
          response = await fetch(url, {
            method: options.claim.method,
            headers: baseHeaders({ Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" }),
            body: options.claim.method === "GET" ? undefined : JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
          })
        } catch (error) {
          return { outcome: "failed", message: `领取请求失败：${error?.message || error}` }
        }
        const body = await readBody(response)
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) return { outcome: "ineligible", message: errorText(body) }
          if (response.status === 429) return { outcome: "failed", message: "被限流，稍后重试" }
          return { outcome: "failed", message: `HTTP ${response.status}：${errorText(body)}` }
        }
        if (body?.captcha || body?.need_captcha) return { outcome: "captcha", message: "需要验证码，请到 CNB 站点自己操作" }
        const credit = numberOrNull(body?.credit ?? body?.amount ?? body?.points)
        const already = body?.already === true || body?.claimed === false
        if (already) return { outcome: "done", credit: credit ?? undefined }
        if (credit === null && body?.ok === false) return { outcome: "failed", message: errorText(body) }
        return {
          outcome: "claimed",
          credit: credit ?? undefined,
          streak: numberOrNull(body?.streak ?? body?.days) ?? undefined,
          message: String(body?.message || body?.msg || "领取成功"),
        }
      },
    },

    // --- 每个账号的模型 -----------------------------------------------------
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        const account = auth ? resolveAccount(auth) : { session: "", token: "" }
        const transport = pickTransport(account, options)
        const supportsTools = transport !== "cookie"
        const base = provider.models || {}
        const models = {}
        for (const spec of MODEL_SPECS) {
          const configured = base[spec.id] || {}
          models[spec.id] = {
            ...configured,
            id: configured.id || spec.id,
            name: configured.name || spec.name,
            limit: { context: spec.context, output: spec.output, ...(configured.limit || {}) },
            capabilities: {
              ...(configured.capabilities || {}),
              reasoning: Boolean(spec.reasoning),
              toolcall: supportsTools,
              attachment: Boolean(spec.image),
              input: { text: true, image: Boolean(spec.image) },
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, ...(configured.cost || {}) },
            status: "active",
          }
        }
        // 顺手把身份快照写出去（页面靠它渲染），失败不影响列模型。
        try {
          if (auth && resolveAccount(auth).token) await refreshSnapshot({ auth, options })
        } catch {
          /* ignore */
        }
        return models
      },
    },

    // --- 工具：给 agent 调的三件事 ------------------------------------------
    tool: buildTools({ options }),

    // --- 请求头 -------------------------------------------------------------
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER_ID) return
      output.headers["x-cnb-client"] = USER_AGENT
    },
  }
}

function stripV1(url) {
  return String(url || "").replace(/\/+$/, "").replace(/\/v1$/, "")
}

function configModels() {
  return Object.fromEntries(
    MODEL_SPECS.map((spec) => [
      spec.id,
      {
        name: spec.name,
        limit: { context: spec.context, output: spec.output },
        reasoning: Boolean(spec.reasoning),
        tool_call: true,
        attachment: Boolean(spec.image),
        modalities: { input: spec.image ? ["text", "image"] : ["text"], output: ["text"] },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
    ]),
  )
}

// ---------------------------------------------------------------------------
// 工具（不用 @opencode-ai/plugin 依赖，args 直接给 JSON Schema）
// ---------------------------------------------------------------------------
/**
 * 工具侧拿登录态：
 *  - magpie 若在 ctx 上给了 auth()，优先用它（账号作用域，多账号时才是对的）
 *  - 否则回退到本机 cnb-cli 登录态，保证「装了插件就能用工具」而不是必须先在 UI 里登录
 */
async function resolveToolAuth(ctx) {
  if (ctx && typeof ctx.auth === "function") {
    try {
      const auth = await ctx.auth()
      if (auth && resolveAccount(auth).token) return auth
    } catch {
      /* 落回本机登录态 */
    }
  }
  const local = readLocalCnbToken()
  if (local?.token) {
    return { type: "api", key: local.token, access: local.token, expires: local.expires || 0, metadata: { source: local.source } }
  }
  return null
}

function buildTools({ options }) {
  return {
    cnb_account: {
      description: "查看当前 CNB 账号的认证徽章（天才程序员 / 高校认证 / TDP）、当月 Credit 用量与各认证入口链接。",
      args: {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "true 则跳过 60 秒缓存重新拉取" },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const auth = await resolveToolAuth(ctx)
        if (!auth) return "没有可用的 CNB 登录态：先在 magpie 的插件页登录 cnb。"
        const snapshot = await refreshSnapshot({
          auth,
          options,
          signal: ctx?.abort,
          force: Boolean(args?.refresh),
        })
        const lines = []
        const a = snapshot.account
        lines.push(`账号：${a.username || "(未取到)"}${a.nickname ? ` / ${a.nickname}` : ""}`)
        lines.push(`认证徽章：${a.badges.length ? a.badges.map((b) => b.label).join(" · ") : "暂无"}`)
        lines.push(`组织：${snapshot.scope.org || "(未设置)"}　仓库：${snapshot.scope.repo || "(未设置)"}　通道：${snapshot.transport}`)
        const c = snapshot.credit
        lines.push(
          `当月 Credit：${c.used ?? "?"} 已用 / ${c.total ?? "?"} 总额${c.privilege ? `（其中特权 ${c.privilege}）` : ""}${
            c.percent !== null ? `，占 ${c.percent}%` : ""
          }`,
        )
        if (c.special) lines.push(`特权额度：${c.special} credits${c.specialDesc ? ` — ${c.specialDesc}` : ""}`)
        if (snapshot.error) lines.push(`注意：${snapshot.error}`)
        lines.push("认证入口：")
        for (const e of snapshot.entrances) {
          const state = e.earned === true ? "已获得" : e.earned === false ? "未获得" : "查看"
          lines.push(`  - ${e.title}（${state}）${e.url}　奖励：${e.reward}`)
        }
        return lines.join("\n")
      },
    },

    cnb_create_repo: {
      description: "在 CNB 指定组织下创建仓库（POST /{slug}/-/repos）。失败会返回手工创建步骤。",
      args: {
        type: "object",
        properties: {
          name: { type: "string", description: "仓库名，不含组织前缀" },
          description: { type: "string", description: "仓库描述" },
          visibility: { type: "string", enum: ["public", "private", "secret"], description: "可见性，默认 private" },
          org: { type: "string", description: "组织 slug，留空用插件选项或登录时的组织" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const auth = await resolveToolAuth(ctx)
        if (!auth) return "没有可用的 CNB 登录态：先在 magpie 的插件页登录 cnb。"
        const account = resolveAccount(auth)
        const org = String(args?.org || options.org || account.org || "").replace(/^\/+|\/+$/g, "")
        if (!org) {
          return [
            "缺少组织 slug，无法自动建仓。",
            `手工创建：打开 ${ROUTES.newRepo} → 选组织 → 填仓库名 → 可见性选 private。`,
            "或者先建组织：" + ROUTES.newGroup,
          ].join("\n")
        }
        const result = await createRepo({
          token: account.token,
          org,
          name: args?.name,
          description: args?.description,
          visibility: args?.visibility || options.visibility,
          signal: ctx?.abort,
        })
        if (result.ok) {
          await refreshSnapshot({ auth, options, force: true }).catch(() => {})
          return `已创建仓库 ${result.path}\n地址：${result.url}\n提示：把插件选项 repo 设为 ${result.path}，AI 通道才能用。`
        }
        return [`自动建仓失败：${result.error}`, "手工步骤：", ...result.manual].join("\n")
      },
    },

    cnb_claim_points: {
      description: "触发一次积分/额度领取（走插件选项 claim.url 配的端点；CNB 本身没有公开签到接口）。",
      args: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const auth = await resolveToolAuth(ctx)
        if (!auth) return "没有可用的 CNB 登录态。"
        if (!options.claim.url) {
          return [
            "未配置领取端点，无法执行领取。",
            "CNB 的免费额度是每月自动发放的（免费 500 / 月，完成 hello-cnb 挑战后 1166 / 月），没有公开的每日签到接口。",
            `特权额度（认证带来的那部分）在这里看：${ROUTES.extIdentityPrivilege}`,
            "确实有领取端点时，把插件选项 claim.url 配上再调用本工具。",
          ].join("\n")
        }
        const account = resolveAccount(auth)
        const url = options.claim.url
          .replaceAll("{{org}}", orgSlug(account, options, repoPath(account, options)))
          .replaceAll("{{repo}}", repoPath(account, options))
          .replaceAll("{{token}}", account.token)
        const response = await fetch(url, {
          method: options.claim.method,
          headers: baseHeaders({ Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" }),
          body: options.claim.method === "GET" ? undefined : options.claim.body || "{}",
          signal: ctx?.abort,
        })
        const body = await readBody(response)
        return `HTTP ${response.status}\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`
      },
    },
  }
}

export const _internal = Object.freeze({
  PROVIDER_ID,
  MODEL_SPECS,
  ROUTES,
  OAUTH_TOKEN_URL,
  CnbError,
  authorizeFromLocal,
  badgesFromUser,
  buildCreditView,
  buildSnapshot,
  cliTokenFile,
  configModels,
  createRepo,
  describeLocalTokenProbe,
  foldSse,
  grabCsrf,
  identifyCredential,
  identityEntrances,
  badgesFromSpecialClaim,
  collectBadges,
  normaliseOptions,
  normalizeExpiry,
  parseTokenText,
  pickAuthEntry,
  pickCredential,
  pickTransport,
  publishState,
  readLocalCnbToken,
  refreshCnbToken,
  repoPath,
  resolveAccount,
  STATE_FILE,
  writeBackCliToken,
})

export default CnbAccountPlugin
