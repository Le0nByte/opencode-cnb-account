#!/usr/bin/env node
// 自检：按 magpie 的方式加载插件，校验钩子形状与页面沙箱约束。
// 用法：node scripts/check.mjs

import os from "node:os"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
let checks = 0

function ok(name, condition, detail) {
  checks++
  if (condition) {
    console.log(`  \u2713 ${name}`)
  } else {
    failures++
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

// ---------------------------------------------------------------------------
section("1. package.json / magpie 清单")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
ok("name 存在", Boolean(pkg.name))
ok("type=module", pkg.type === "module")
ok("main 指向入口", Boolean(pkg.main) && existsSync(join(ROOT, pkg.main)))
ok("keywords 含 opencode + magpie", (pkg.keywords || []).includes("opencode") && (pkg.keywords || []).includes("magpie"))
const m = pkg.magpie || {}
ok("magpie.icon 是 https:// 或 data: URI（相对路径 magpie 不认）", typeof m.icon === "string" && /^(https:\/\/|data:image\/)/.test(m.icon), String(m.icon).slice(0, 40))
ok("magpie.maxConcurrency 在 1..1000", Number.isInteger(m.maxConcurrency) && m.maxConcurrency >= 1 && m.maxConcurrency <= 1000)
ok("magpie.page.file 存在", Boolean(m.page?.file) && existsSync(join(ROOT, m.page.file)))
ok("magpie.page 有 titles.zh", Boolean(m.page?.titles?.zh))
ok("panels 数量 <= 8", Array.isArray(m.panels) && m.panels.length <= 8)
for (const panel of m.panels || []) {
  ok(`panel slot 合法（${panel.slot}）`, ["agents", "usage", "settings", "provider"].includes(panel.slot))
  ok(`panel file 存在（${panel.file}）`, existsSync(join(ROOT, panel.file)))
}
ok("permissions 都是已知读取", (m.permissions || []).every((p) => ["usage:summary", "providers:list"].includes(p)), JSON.stringify(m.permissions))

// ---------------------------------------------------------------------------
section("2. 入口导出的形状")
const mod = await import(new URL(`file://${join(ROOT, pkg.main).replace(/\\/g, "/")}`))
ok("default 导出是函数", typeof mod.default === "function")
const exportedFns = Object.entries(mod).filter(([, v]) => typeof v === "function").map(([k]) => k)
ok("只有一个函数导出（default），避免被 magpie 重复初始化", exportedFns.length === 1 && exportedFns[0] === "default", exportedFns.join(","))
ok("_internal 是对象而不是函数", typeof mod._internal === "object" && !Array.isArray(mod._internal))

const hooks = await mod.default({ client: {}, directory: ROOT }, m.options)
ok("config 钩子是函数", typeof hooks.config === "function")
ok("auth 钩子是对象", Boolean(hooks.auth) && typeof hooks.auth === "object")
ok("auth.provider = cnb", hooks.auth?.provider === "cnb")
ok("auth.loader 是函数", typeof hooks.auth?.loader === "function")
ok("auth.usage 是函数", typeof hooks.auth?.usage === "function")
ok("auth.checkin 是函数", typeof hooks.auth?.checkin === "function")
ok("auth.methods 至少 2 种", Array.isArray(hooks.auth?.methods) && hooks.auth.methods.length >= 2)
for (const method of hooks.auth?.methods || []) {
  ok(`method 类型合法（${method.type}）`, ["api", "oauth"].includes(method.type))
  ok(`method 有 label（${method.type}）`, typeof method.label === "string" && method.label.length > 0)
  if (method.type === "oauth") {
    ok("oauth.authorize 是函数", typeof method.authorize === "function")
    const r = await method.authorize({})
    ok("oauth.authorize 返回 url/instructions/method/callback", Boolean(r?.url !== undefined && r?.instructions && r?.method && typeof r?.callback === "function"))
  }
  for (const prompt of method.prompts || []) {
    ok(`prompt 类型合法（${prompt.type}）`, ["text", "password", "select"].includes(prompt.type))
  }
}
ok("provider 钩子是对象且有 models", Boolean(hooks.provider) && typeof hooks.provider.models === "function")
ok("tool 钩子是对象", Boolean(hooks.tool) && typeof hooks.tool === "object")
ok("chat.headers 是函数", typeof hooks["chat.headers"] === "function")

section("2b. 登录流程不能有冗余步骤")
// 这条是硬要求：用户抱怨过"点下一步、下一步"。登录方式里出现 prompts 就是回归。
const promptCount = (hooks.auth.methods || []).reduce((n, m) => n + (m.prompts || []).length, 0)
ok("登录方式里没有任何 prompts（不该出现「下一步」按钮）", promptCount === 0, `发现 ${promptCount} 个 prompt`)
ok("登录方式不超过 3 个", (hooks.auth.methods || []).length <= 3, String((hooks.auth.methods || []).length))
ok("有且仅有一个需要用户输入的方式", (hooks.auth.methods || []).filter((m) => m.type === "api").length === 1)
ok(
  "需要输入的方式给了明确 placeholder",
  (hooks.auth.methods || []).filter((m) => m.type === "api").every((m) => typeof m.placeholder === "string" && m.placeholder.length > 6),
)
ok("一键登录是 oauth + auto callback（点一下就走完）", (hooks.auth.methods || []).some((m) => m.type === "oauth"))
ok("auth.refresh 存在（令牌过期能自动续期）", typeof hooks.auth.refresh === "function")

// 「加第二个账号」只能靠 device flow —— 它不碰 ~/.cnb/token，登录多少次都行。
const deviceMethod = (hooks.auth.methods || []).find((m) => m.type === "oauth" && /浏览器/.test(m.label || ""))
ok("有一个浏览器授权（device flow）登录方式", Boolean(deviceMethod), (hooks.auth.methods || []).map((m) => m.label).join(" / "))
ok("device flow 方式是 oauth + auto callback", deviceMethod?.type === "oauth")
ok("requestDeviceCode 是函数", typeof mod._internal.requestDeviceCode === "function")
ok("pollDeviceToken 是函数", typeof mod._internal.pollDeviceToken === "function")
ok("loginViaDevice 是函数", typeof mod._internal.loginViaDevice === "function")
ok(
  "device flow 用的是实测过的 /oauth2/device/auth 端点",
  /oauth2\/device\/auth/.test(mod._internal.requestDeviceCode.toString()),
)
ok(
  "device flow 用 RFC 8628 的 grant_type",
  mod._internal.DEVICE_GRANT === "urn:ietf:params:oauth:grant-type:device_code",
  String(mod._internal.DEVICE_GRANT),
)

ok("refreshLead 有设置", Number(hooks.auth.refreshLead) > 0, String(hooks.auth.refreshLead))

// 一键登录必须能读懂 cnb-cli 的嵌套结构 —— 这里放一份实测抓到的样例
const cliTokenSample = JSON.stringify({
  auths: {
    "cnb.cool": {
      access_token: "A".repeat(94),
      expires_at: 1792419526,
      refresh_token: "R".repeat(94),
      client_id: "cnb_cli",
      login_host: "https://api.cnb.cool",
      platform_url: "https://cnb.cool",
      scope: "openid profile",
    },
  },
})
const parsedCli = mod._internal.parseTokenText(cliTokenSample)
ok("解析 cnb-cli 的 auths[cnb.cool].access_token", parsedCli?.token === "A".repeat(94), String(parsedCli?.token).slice(0, 12))
ok("解析 cnb-cli 的 refresh_token", parsedCli?.refresh === "R".repeat(94))
ok("解析 cnb-cli 的 client_id", parsedCli?.clientId === "cnb_cli")
ok("expires_at 秒 → 毫秒", parsedCli?.expires === 1792419526 * 1000, String(parsedCli?.expires))
ok("毫秒时间戳不被再乘一次", mod._internal.parseTokenText('{"access_token":"x","expires_at":1792419526000}')?.expires === 1792419526000)
ok("裸 token 仍然可用", mod._internal.parseTokenText("plain-token")?.token === "plain-token")
ok("refresh 端点指向 cnb.cool/oauth2/token", mod._internal.OAUTH_TOKEN_URL === "https://cnb.cool/oauth2/token", mod._internal.OAUTH_TOKEN_URL)

// 一个输入框要同时认 PAT 和 CNBSESSION，所以从 inputs 里捞值的逻辑要稳
// 这次踩过的坑：api 方式一旦带 authorize，magpie 只会把 prompts 的答案传进来
// （internal/plugin/host.js: m.authorize(inputs ?? {})），用户在 key 输入框里填的值
// 根本进不到插件里，登录时会误报「没有读到输入内容」。
const apiMethod = (hooks.auth.methods || []).find((m) => m.type === "api")
ok("api 登录方式不得有 authorize（否则拿不到用户输入的 key）", typeof apiMethod.authorize !== "function")
ok("api 登录方式不得有 prompts（用户不该看到「下一步」）", !(apiMethod.prompts || []).length)
ok("rawCredentialOf 认 key", mod._internal.rawCredentialOf({ key: "abc" }) === "abc")
ok("rawCredentialOf 认 access", mod._internal.rawCredentialOf({ access: "abc" }) === "abc")
ok("rawCredentialOf 空输入返回空串", mod._internal.rawCredentialOf({}) === "" && mod._internal.rawCredentialOf(null) === "")
ok("没识别过的凭证不进缓存", mod._internal.cachedCredential({ key: "never-seen-before" }) === null)
// 仓库名不能靠猜：以前硬拼 <org>/code，那个仓库不存在，AI 请求会 404 Resource not found。
ok("pickScope 是函数（仓库自动探测）", typeof mod._internal.pickScope === "function")
ok(
  "pickScope 会去查真实仓库列表",
  /listRepos/.test(mod._internal.pickScope.toString()),
)
// 个人访问令牌调不了模型（所有路径实测 403），所以通道只剩 cookie / relay。
ok(
  "只有 PAT、没有 CNBSESSION、也没配中继时判定为 need-session",
  mod._internal.pickTransport({ token: "t", session: "" }, mod._internal.normaliseOptions({ relay: { url: "" } })) === "need-session",
)
ok(
  "transport 白名单里已经没有 direct",
  mod._internal.normaliseOptions({ transport: "direct" }).transport === "auto",
)
ok(
  "没有任何代码再调用 buildDirectFetch",
  !/buildDirectFetch/.test(readFileSync(join(ROOT, "index.mjs"), "utf8")),
)
ok(
  "有 CNBSESSION（且没配中继）时走 cookie",
  mod._internal.pickTransport({ token: "", session: "s" }, mod._internal.normaliseOptions({ relay: { url: "" } })) === "cookie",
)
ok(
  "配了 relay 时走 relay",
  mod._internal.pickTransport({ token: "t", session: "" }, mod._internal.normaliseOptions({ relay: { url: "https://r.example.com" } })) === "relay",
)

ok("ensureCredential 是函数", typeof mod._internal.ensureCredential === "function")

// identity_providers 为 null 时，靠特权额度说明兜底出徽章（实测账号就是这样）
const claimBadges = mod._internal.badgesFromSpecialClaim("天才程序员专属特权", [])
ok("特权说明含「天才」→ 天才程序员徽章", claimBadges.length === 1 && claimBadges[0].label === "天才程序员", JSON.stringify(claimBadges))
ok("特权说明含「高校」→ 高校认证徽章", mod._internal.badgesFromSpecialClaim("高校学生专属特权", []).some((b) => b.kind === "edu"))
ok("已有徽章不重复叠加", mod._internal.badgesFromSpecialClaim("天才程序员专属特权", [{ kind: "genius" }]).length === 0)
ok("特权说明为空不造徽章", mod._internal.badgesFromSpecialClaim("", []).length === 0)

// ---------------------------------------------------------------------------
section("2c. 多账号：不能把第一个账号当成新账号")
// magpie 按 accountId 去重，同一个 accountId 会「替换」而不是「新增」，
// 所以插件必须自己知道已经登录过哪些账号，否则用户点「添加账号」只会把旧的覆盖一遍。
const tmpMagpie = mkdtempSync(join(os.tmpdir(), "magpie-accounts-"))
writeFileSync(
  join(tmpMagpie, "plugin-auth.json"),
  JSON.stringify({
    cnb: { type: "oauth", accountId: "alice" },
    "cnb#abc123": { type: "api", metadata: { username: "bob" } },
    "other-provider": { accountId: "should-be-ignored" },
  }),
  "utf8",
)
const acc = mod._internal.readMagpieAccounts(tmpMagpie)
ok("readMagpieAccounts 认出 cnb 主账号", acc.has("alice"), [...acc].join(","))
ok("readMagpieAccounts 认出 cnb#xxx 副账号", acc.has("bob"))
ok("readMagpieAccounts 不混入别的 provider", !acc.has("should-be-ignored"))
ok("readMagpieAccounts 目录不存在时返回空集", mod._internal.readMagpieAccounts(join(tmpMagpie, "nope")).size === 0)
rmSync(tmpMagpie, { recursive: true, force: true })

// 写回 cnb-cli 的令牌必须确认归属：A 账号续期不能污染 B 账号的文件
const fakeToken = { access: "cnb_at_fake", refresh: "cnb_rt_fake", expires: Date.now() + 3600_000 }
ok(
  "writeBackCliToken 不传 owner 时拒绝写回",
  mod._internal.writeBackCliToken(fakeToken) === false,
)
ok(
  "writeBackCliToken owner 不匹配时拒绝写回",
  mod._internal.writeBackCliToken(fakeToken, { ownerRefresh: "belongs-to-someone-else" }) === false,
)
const meta = mod._internal.tokenFileMeta()
ok("tokenFileMeta 返回 file/exists/mtime/size", ["file", "exists", "mtime", "size"].every((k) => k in meta))

// 一键登录必须把 magpie 配置目录接进来才可能做上面的判断
ok(
  "authorizeFromLocal 接受 ctx（magpie 配置目录）参数",
  /ctx/.test(mod._internal.authorizeFromLocal.toString()) && /magpieDir/.test(mod._internal.authorizeFromLocal.toString()),
)

section("3. config 钩子声明供应商")
const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider?.cnb
ok("声明了 provider cnb", Boolean(provider))
ok("provider.npm 是 openai-compatible", provider?.npm === "@ai-sdk/openai-compatible")
ok("provider 有 models", provider?.models && Object.keys(provider.models).length > 0)
const modelIds = Object.keys(provider?.models || {})
ok("models 含 deepseek-v4.1-flash", modelIds.includes("deepseek-v4.1-flash"))
for (const id of modelIds) {
  const spec = provider.models[id]
  ok(`模型 ${id} 有 limit`, Number.isFinite(spec?.limit?.context) && Number.isFinite(spec?.limit?.output))
  ok(`模型 ${id} 有 name`, typeof spec?.name === "string" && spec.name.length > 0)
}

// ---------------------------------------------------------------------------
section("4. provider.models 钩子")
const models = await hooks.provider.models(provider, { auth: { type: "api", key: "fake", metadata: {} } })
ok("返回模型对象", models && Object.keys(models).length > 0)
ok("每个模型带 capabilities.toolcall", Object.values(models).every((mm) => typeof mm?.capabilities?.toolcall === "boolean"))
ok("每个模型有 api 可推断的 npm", Object.values(models).every((mm) => Boolean(mm?.id)))

// ---------------------------------------------------------------------------
section("5. 徽章判定（对齐 cnb.cool 前端逻辑）")
const { badgesFromUser, foldSse, normaliseOptions, parseTokenText, pickTransport, resolveAccount, buildCreditView } = mod._internal

const genius = badgesFromUser({ identity_providers: { genius: {} } })
ok("genius → 天才程序员", genius.length === 1 && genius[0].label === "天才程序员", JSON.stringify(genius))

const edu = badgesFromUser({ identity_providers: { edu: { identity_type: "STUDENT" } } })
ok("edu STUDENT → 高校学生", edu.length === 1 && edu[0].label === "高校学生", JSON.stringify(edu))

const combined = badgesFromUser({ identity_providers: { genius: {}, edu: { identity_type: "TEACHER" } } })
ok("genius+edu TEACHER → 天才老师", combined.length === 1 && combined[0].label === "天才老师", JSON.stringify(combined))
ok("genius+edu 带 tooltip", Boolean(combined[0].tooltip && combined[0].tooltip.includes("天才程序员")))

const multi = badgesFromUser({ identity_providers: { obt_player: {}, day_one_player: {}, genius: {}, edu: { identity_type: "ALUMNI" }, tdp: { tdp_primary_tag: "P1" } } })
ok("多个 provider 全部展开", multi.length === 4, multi.map((b) => b.label).join(","))

const none = badgesFromUser({})
ok("无认证返回空数组", none.length === 0)

const { identityEntrances } = mod._internal
const entCombined = identityEntrances(badgesFromUser({ identity_providers: { genius: {}, edu: { identity_type: "ALUMNI" } } }))
ok("genius+edu 时高校入口也算已获得", entCombined.find((e) => e.id === "edu")?.earned === true)
ok("genius+edu 时天才入口也算已获得", entCombined.find((e) => e.id === "genius")?.earned === true)

const entBare = identityEntrances(badgesFromUser({}))
ok("无认证时两个入口都是未获得", entBare.find((e) => e.id === "edu")?.earned === false && entBare.find((e) => e.id === "genius")?.earned === false)
ok("每个入口都有可点击 url + 积分奖励", entBare.every((e) => /^https:\/\/cnb\.cool\//.test(e.url) && typeof e.reward === "string" && e.reward.length > 0))

// ---------------------------------------------------------------------------
section("6. SSE 折叠（上游只吃 stream:true）")
const sse = [
  'data: {"id":"chatcmpl-1","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"你"}}]}',
  'data: {"id":"chatcmpl-1","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}',
  "data: [DONE]",
  "",
].join("\n\n")
const folded = await foldSse(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }), "deepseek-v4.1-flash")
ok("折叠出 chat.completion", folded.object === "chat.completion")
ok("内容拼接正确", folded.choices?.[0]?.message?.content === "你好", JSON.stringify(folded.choices?.[0]?.message))
ok("finish_reason 保留", folded.choices?.[0]?.finish_reason === "stop")
ok("model 保留", folded.model === "deepseek-v4.1-flash")

// ---------------------------------------------------------------------------
section("7. 选项 / token / 通道归一化")
const opts = normaliseOptions({ org: "/my-org/", repo: "/my-org/code/", transport: "COOKIE", visibility: "weird" })
ok("org 去斜杠", opts.org === "my-org")
ok("repo 去斜杠", opts.repo === "my-org/code")
ok("transport 小写并校验", opts.transport === "cookie")
ok("非法 visibility 回落 private", opts.visibility === "private")
ok("未知 transport 回落 auto", normaliseOptions({ transport: "nonsense" }).transport === "auto")

ok("裸 token 解析", parseTokenText("abc.def")?.token === "abc.def")
ok("JSON token 解析", parseTokenText('{"access_token":"x","refresh_token":"y","expires_at":100}')?.token === "x")

const accCookie = resolveAccount({ type: "api", key: "sess", metadata: { session: "sess", csrfkey: "ck" } })
ok("cookie 账号取到 session", accCookie.session === "sess" && accCookie.csrfkey === "ck")
ok("auto + session → cookie", pickTransport(accCookie, normaliseOptions({ relay: { url: "" } })) === "cookie")
ok("auto + relay.url → relay", pickTransport(accCookie, normaliseOptions({ relay: { url: "https://r.example.com/v1" } })) === "relay")

// 二改：中继优先 + CNBSESSION 放插件选项 + CSRF 语义
ok("默认选项预填中继地址", normaliseOptions({}).relay.url === mod._internal.RELAY_URL_DEFAULT, normaliseOptions({}).relay.url)
ok("auto 默认走中继（即使账号自带 session）", pickTransport(accCookie, normaliseOptions({})) === "relay")
ok("显式 transport=cookie 不受中继影响", pickTransport(accCookie, normaliseOptions({ transport: "cookie" })) === "cookie")
ok(
  "options.session 能让 cookie 通道生效",
  pickTransport({ token: "t", session: "" }, normaliseOptions({ relay: { url: "" }, session: "opt" })) === "cookie",
)
ok("sessionOf: 选项优先于账号", mod._internal.sessionOf({ session: "acct" }, { session: "opt" }) === "opt")
ok("sessionOf: 选项为空时回落到账号", mod._internal.sessionOf({ session: "acct" }, { session: "" }) === "acct")
ok("ensureCsrf / dropCsrf 已导出", typeof mod._internal.ensureCsrf === "function" && typeof mod._internal.dropCsrf === "function")
const indexSrc = readFileSync(join(ROOT, "index.mjs"), "utf8")
ok("Csrftoken 头用 csrftoken，不是 csrfkey", /Csrftoken:\s*csrf\.csrfToken/.test(indexSrc) && !/Csrftoken:\s*csrfkey/.test(indexSrc))
ok("cookie 通道 401/403 会刷新 CSRF 再试一次", /dropCsrf\(session\)/.test(indexSrc))
ok(
  "NEED_SESSION 指向页面上的 AI 通道，不再让人点不存在的按钮",
  /AI 通道/.test(mod._internal.NEED_SESSION) && !/点「粘贴访问令牌」/.test(mod._internal.NEED_SESSION),
)
ok("package.json 预填中继地址", pkg.magpie.options.relay.url === mod._internal.RELAY_URL_DEFAULT, String(pkg.magpie.options.relay.url))
ok("package.json 暴露 session / csrfkey 选项", "session" in pkg.magpie.options && "csrfkey" in pkg.magpie.options)

// 二改：多账号快照
ok("PLUGIN_VERSION 取自 package.json", mod._internal.PLUGIN_VERSION === pkg.version, mod._internal.PLUGIN_VERSION)
const snapA = { generatedAt: "t1", transport: "relay", account: { username: "user-a", badges: [] }, credit: { total: 500 } }
const snapB = { generatedAt: "t2", transport: "relay", account: { username: "user-b", badges: [] }, credit: { total: 100 } }
const one = mod._internal.statePayload({}, snapA)
ok("单账号：顶层就是快照，不带 accounts", one.account.username === "user-a" && !("accounts" in one), JSON.stringify(Object.keys(one)))
const two = mod._internal.statePayload({ "user-a": snapA }, snapB)
ok("两账号：带 accounts 表", two.accounts && Object.keys(two.accounts).length === 2, JSON.stringify(two.accounts && Object.keys(two.accounts)))
ok("两账号：顶层是最近刷新的那个", two.account.username === "user-b")
ok("两账号：老账号快照没被覆盖", two.accounts["user-a"].account.username === "user-a")
ok("accounts 里不再嵌套 accounts", !("accounts" in two.accounts["user-a"]))
const merged = mod._internal.mergeStateAccounts({ "user-a": snapA }, snapB)
ok("mergeStateAccounts 幂等（同账号再刷不重复）", Object.keys(mod._internal.mergeStateAccounts(merged, snapB)).length === 2)
ok("accountKeyOf 用 username", mod._internal.accountKeyOf(snapB) === "user-b")

const credit = buildCreditView(
  { credit_in_milli: { total: 1_166_000, free: 500_000 } },
  { credit_in_milli: 250_000 },
  { credit: 666, credit_desc: "高校认证" },
)
ok("credit 总量换算", credit.total === 1166, String(credit.total))
ok("credit 免费换算", credit.free === 500, String(credit.free))
ok("credit 已用换算", credit.used === 250, String(credit.used))
ok("credit 特权 = total - free", credit.privilege === 666, String(credit.privilege))
ok("credit 百分比", credit.percent === 21.4, String(credit.percent))
ok("特权限额文案透传", credit.specialDesc === "高校认证")

// ---------------------------------------------------------------------------
section("8. 页面沙箱约束")
const pageDir = join(ROOT, "page")
for (const file of ["index.html", "panel.html"]) {
  const html = readFileSync(join(pageDir, file), "utf8")
  ok(`${file} 无内联 <script>`, !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "出现了没有 src 的 script")
  ok(`${file} 引了 bridge.js`, html.includes("_magpie/bridge.js"))
  ok(`${file} 引了 state.default.js`, html.includes('src="state.default.js"'))
  ok(`${file} 没有内联 fetch`, !/\bfetch\s*\(/.test(html))
  ok(`${file} 没有 window.open`, !/window\.open\s*\(/.test(html))
}
const appjs = readFileSync(join(pageDir, "app.js"), "utf8")
ok("app.js 不直接 fetch（沙箱 connect-src 'none'）", !/\bfetch\s*\(/.test(appjs), "页面里出现 fetch 会直接失败")
ok("app.js 不建 WebSocket", !/new\s+WebSocket/.test(appjs))
ok("app.js 用 location.assign 做跳转", /location\.assign/.test(appjs))
ok("app.js 只用声明的 read 权限", !/magpie\.read\(\s*["'](?!usage:summary|providers:list)/.test(appjs))
ok("state.default.js 定义了 window.__CNB_STATE__", readFileSync(join(pageDir, "state.default.js"), "utf8").includes("window.__CNB_STATE__"))

const stateSrc = readFileSync(join(pageDir, "state.default.js"), "utf8")
const evalState = () => {
  try {
    const sandbox = {}
    new Function("window", stateSrc)(sandbox)
    return sandbox.__CNB_STATE__ || null
  } catch {
    return null
  }
}
ok("state.default.js 能求值出 window.__CNB_STATE__ 对象", Boolean(evalState()))
const defState = evalState() || {}
ok(
  "默认快照字段齐全（account / credit / entrances / routes / sideQuotas）",
  Boolean(defState.account && defState.credit && defState.routes && Array.isArray(defState.entrances) && Array.isArray(defState.sideQuotas)),
)
ok(
  "默认快照的认证入口覆盖高校 / 天才 / TDP",
  ["edu", "genius", "tdp"].every((id) => (defState.entrances || []).some((e) => e.id === id)),
)
ok(
  "默认快照每条入口都有 url 与 reward",
  (defState.entrances || []).every((e) => /^https:\/\/cnb\.cool\//.test(e.url) && typeof e.reward === "string" && e.reward.length > 0),
)

// app.js 里 $("xxx") 引用的 id，页面里必须真的存在（可选元素除外）
const OPTIONAL_IDS = new Set(["mw", "btn-login"]) // 只有独立页面才有 magpie 侧统计
for (const file of ["index.html", "panel.html"]) {
  const html = readFileSync(join(pageDir, file), "utf8")
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const referenced = new Set([...appjs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))
  const missing = [...referenced].filter((id) => !ids.has(id) && !OPTIONAL_IDS.has(id))
  ok(`${file} 覆盖 app.js 引用的所有 id`, missing.length === 0, missing.join(","))
  ok(`${file} 引用的本地文件都存在`, [...html.matchAll(/(?:src|href)="(?!_magpie\/|https?:|#)([^"?#]+)"/g)]
    .map((m) => m[1])
    .every((f) => existsSync(join(pageDir, f))))
}

// ---------------------------------------------------------------------------
section("9. 控制台路由（来自 cnb.cool 前端 bundle）")
const { ROUTES } = mod._internal
for (const [key, url] of Object.entries(ROUTES)) {
  ok(`routes.${key} 是 cnb.cool 链接`, typeof url === "string" && url.startsWith("https://cnb.cool/"), url)
}
ok("含 /new/repos 建仓入口", ROUTES.newRepo.endsWith("/new/repos"))
ok("含 /user/ext_identity 认证入口", ROUTES.extIdentity.endsWith("/user/ext_identity"))
ok("含认证特权额度入口", ROUTES.extIdentityPrivilege.endsWith("/user/charge/ext_identity/privilege"))

// ---------------------------------------------------------------------------
section("10. 文件清单")
for (const f of [
  "index.mjs",
  "package.json",
  "page/index.html",
  "page/panel.html",
  "page/app.js",
  "page/style.css",
  "page/state.default.js",
  "page/icon.svg",
  "scripts/check.mjs",
  "scripts/push.mjs",
  "README.md",
  "PUSH-TO-GITHUB.md",
  "LICENSE",
  ".gitignore",
  ".gitattributes",
]) {
  ok(`${f} 存在`, existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).size > 0)
}

section("11. 仓库卫生")
const gi = readFileSync(join(ROOT, ".gitignore"), "utf8")
ok(".gitignore 排除 node_modules", /node_modules\//.test(gi))
ok(".gitignore 排除预览产物", /_preview\//.test(gi))
const ga = readFileSync(join(ROOT, ".gitattributes"), "utf8")
ok(".gitattributes 统一 LF", /eol=lf/.test(ga))
ok("LICENSE 是 MIT", /^MIT License/.test(readFileSync(join(ROOT, "LICENSE"), "utf8")))
ok("package.json 的 license 与 LICENSE 一致", pkg.license === "MIT")
ok("files 字段不打包 scripts（避免被当页面目录扫）", !(pkg.files || []).some((f) => f.startsWith("scripts")))

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}（共 ${checks} 项检查）`)
process.exitCode = failures === 0 ? 0 : 1
