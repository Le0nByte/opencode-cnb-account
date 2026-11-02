// 二改回归：CSRF 语义、401/403 重试、relay 优先、need-session。
// 用法：node scripts/check-channel.mjs（纯 Node，无外部依赖，不需要 magpie 在跑）
import { mkdtempSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mod = await import(pathToFileURL(join(ROOT, "index.mjs")).href)
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

let fails = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : " — " + (detail ?? "")}`)
  if (!cond) fails++
}

// --- fetch 桩 -------------------------------------------------------------
const calls = []
let csrfSeq = 0
let chatStatus = 200
let lastHome = null

const LOGGED_IN = (t) => `<html><script>window.csrftoken="ab12cd${t}ef";</script>${"x".repeat(250_000)}</html>`
const ANON = `<html>${"x".repeat(145_000)}</html>`

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url
  const headers = init.headers || {}
  const method = init.method || "GET"
  calls.push({ url, method, headers })

  if (url.startsWith("https://api.cnb.cool/user")) {
    const auth = String(headers.Authorization || "")
    if (auth.endsWith("PAT-OK")) {
      return new Response(JSON.stringify({ id: 1, username: "tester", identity_providers: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ errcode: 401, errmsg: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }
  if (url === "https://cnb.cool/") {
    const cookie = String(headers.Cookie || "")
    if (!/CNBSESSION=SESS-/.test(cookie)) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => "text/html", getSetCookie: () => [] },
        text: async () => ANON,
      }
    }
    csrfSeq++
    lastHome = { token: `ab12cd${csrfSeq}ef`, key: `CK${csrfSeq}` }
    return {
      status: 200,
      ok: true,
      headers: {
        get: () => "text/html",
        getSetCookie: () => [`csrfkey=CK${csrfSeq}; Path=/; HttpOnly`, "other=1; Path=/"],
      },
      text: async () => LOGGED_IN(csrfSeq),
    }
  }
  if (url.includes("/-/ai/chat/completions")) {
    if (chatStatus !== 200) {
      const s = chatStatus
      chatStatus = 200
      return new Response(JSON.stringify({ errmsg: "csrf mismatch" }), {
        status: s,
        headers: { "content-type": "application/json" },
      })
    }
    const sse = [
      'data: {"id":"c1","created":1700000000,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"通"}}]}',
      'data: {"id":"c1","created":1700000000,"choices":[{"index":0,"delta":{"content":"了"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  throw new Error("unexpected fetch: " + url)
}

const tmp = mkdtempSync(join(tmpdir(), "cnb-harness-"))
const baseOptions = { org: "realleon", repo: "realleon/cnb2api" }
const CHAT_URL = "https://cnb.cool/realleon/cnb2api/-/ai/chat/completions"
const chatRequest = (extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: false, ...extra }),
})

// ---------------------------------------------------------------------------
console.log("\n1. 默认选项 / 通道判定")
const dflt = mod._internal.normaliseOptions({})
ok("relay.url 默认预填本机 new-api", dflt.relay.url === "http://127.0.0.1:3000/v1", dflt.relay.url)
ok("package.json 与代码里的默认值一致", pkg.magpie.options.relay.url === mod._internal.RELAY_URL_DEFAULT)
ok("auto 默认走 relay（中继优先）", mod._internal.pickTransport({ token: "t", session: "" }, dflt) === "relay")
const noRelay = mod._internal.normaliseOptions({ relay: { url: "" } })
ok("清空 relay 后：有 session → cookie", mod._internal.pickTransport({ token: "t", session: "s" }, noRelay) === "cookie")
ok("清空 relay 后：没 session → need-session", mod._internal.pickTransport({ token: "t", session: "" }, noRelay) === "need-session")
ok("选项里的 session 也算数", mod._internal.pickTransport({ token: "t", session: "" }, mod._internal.normaliseOptions({ relay: { url: "" }, session: "opt" })) === "cookie")

// ---------------------------------------------------------------------------
console.log("\n2. cookie 通道：Csrftoken 必须是 csrftoken，csrfkey 只进 Cookie")
const hooks = await mod.default(
  { client: {}, directory: tmp },
  { ...baseOptions, transport: "auto", relay: { url: "" }, session: "SESS-A", key: "" },
)
const getAuth = async () => ({ type: "api", key: "SESS-A", metadata: { org: "realleon", repo: "realleon/cnb2api" } })
const loader = await hooks.auth.loader(getAuth)
ok("loader 给出 cookie 通道的 fetch", typeof loader.fetch === "function")
ok("cookie 通道 baseURL 指向仓库 AI 端点", loader.baseURL === "https://cnb.cool/realleon/cnb2api/-/ai", loader.baseURL)

calls.length = 0
const res = await loader.fetch(CHAT_URL, chatRequest())
const body = await res.json()
const chatCall = calls.find((c) => c.url.includes("/-/ai/chat/completions"))
ok("请求成功折叠成 chat.completion", res.status === 200 && body.object === "chat.completion", JSON.stringify(body).slice(0, 140))
ok("内容拼接正确", body.choices?.[0]?.message?.content === "通了")
ok("Csrftoken 头 = 首页 window.csrftoken", chatCall?.headers?.Csrftoken === lastHome?.token, `${chatCall?.headers?.Csrftoken} vs ${lastHome?.token}`)
ok("csrfkey 在 Cookie 里", new RegExp(`csrfkey=${lastHome?.key}`).test(chatCall?.headers?.Cookie || ""), String(chatCall?.headers?.Cookie))
ok("CNBSESSION 在 Cookie 里", /CNBSESSION=SESS-A/.test(chatCall?.headers?.Cookie || ""))
ok("没有把 csrfkey 当 Csrftoken 发", chatCall?.headers?.Csrftoken !== lastHome?.key)
ok("带 User-Agent（Cloudflare 1010）", typeof chatCall?.headers?.["User-Agent"] === "string")
ok("第二次请求复用 CSRF 缓存（不再抓首页）", calls.filter((c) => c.url === "https://cnb.cool/").length === 1, String(calls.filter((c) => c.url === "https://cnb.cool/").length))

// ---------------------------------------------------------------------------
console.log("\n3. 401/403 时刷新 CSRF 并重试一次")
calls.length = 0
chatStatus = 403
mod._internal.dropCsrf("SESS-A")
const beforeKey = lastHome?.key
const res2 = await loader.fetch(CHAT_URL, chatRequest())
const chats = calls.filter((c) => c.url.includes("/-/ai/chat/completions"))
ok("被拒后重试并成功", res2.status === 200, String(res2.status))
ok("重试前重新抓了首页 CSRF（先刷一次 + 被拒后再刷一次）", calls.filter((c) => c.url === "https://cnb.cool/").length === 2, String(calls.filter((c) => c.url === "https://cnb.cool/").length))
ok("重试用的是新 csrfkey", lastHome?.key !== beforeKey && new RegExp(`csrfkey=${lastHome?.key}`).test(chats.at(-1)?.headers?.Cookie || ""), String(chats.at(-1)?.headers?.Cookie))
ok("两次都发到了上游", chats.length === 2, String(chats.length))

// ---------------------------------------------------------------------------
console.log("\n4. tools 请求在 cookie 通道被提前拒绝")
const res3 = await loader.fetch(CHAT_URL, chatRequest({ tools: [{ type: "function", function: { name: "f" } }] }))
const res3text = await res3.text()
ok("返回 403", res3.status === 403, String(res3.status))
ok("说明去「CNB 账户」页填中继", /中继/.test(res3text) && /CNB 账户/.test(res3text), res3text.slice(0, 90))

// ---------------------------------------------------------------------------
console.log("\n5. relay 通道")
const relayHooks = await mod.default(
  { client: {}, directory: tmp },
  { ...baseOptions, transport: "auto", relay: { url: "http://127.0.0.1:3000/v1", key: "relay-key" } },
)
const relayLoader = await relayHooks.auth.loader(getAuth)
ok("baseURL = 中继地址 + /v1", relayLoader.baseURL === "http://127.0.0.1:3000/v1", relayLoader.baseURL)
ok("apiKey 用中继 Key", relayLoader.apiKey === "relay-key", String(relayLoader.apiKey))
ok("relay 通道不插手 fetch（交给 SDK 直连中继）", relayLoader.fetch === undefined)

// ---------------------------------------------------------------------------
console.log("\n6. 两条路都没配时给出可执行提示")
const bareHooks = await mod.default({ client: {}, directory: tmp }, { ...baseOptions, relay: { url: "" } })
const bareLoader = await bareHooks.auth.loader(async () => ({ type: "api", key: "BADPAT", metadata: {} }))
const bare = await bareLoader.fetch("https://cnb.cool/realleon/cnb2api/-/ai/chat/completions", chatRequest())
const bareText = await bare.text()
ok("返回 503", bare.status === 503, String(bare.status))
ok("提示指向「CNB 账户」页的 AI 通道", /CNB 账户/.test(bareText) && /AI 通道/.test(bareText), bareText.slice(0, 90))
ok("不再让人点不存在的「粘贴访问令牌」", !/点「粘贴访问令牌」/.test(bareText))

console.log(`\n${fails === 0 ? "全部通过" : fails + " 项失败"}`)
process.exitCode = fails === 0 ? 0 : 1
