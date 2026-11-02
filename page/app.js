/* CNB 账户页逻辑。
 *
 * 硬约束（来自 magpie 页面沙箱）：
 *   - 只有脚本能跑：sandbox="allow-scripts"，CSP 里 connect-src 'none'
 *     → 没有 fetch / XHR / WebSocket，页面**不能直接调 CNB API**。
 *   - 脚本必须是文件，不能内联。
 *   - 唯一数据来源：宿主写出的 state.js（window.__CNB_STATE__）。
 *   - 允许 location 跳转，所以"点入口"用 location.assign 而不是 window.open。
 */
(function () {
  "use strict"

  var $ = function (id) { return document.getElementById(id) }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = String(text)
    return node
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild) }

  function num(v) { return typeof v === "number" && isFinite(v) ? v : null }

  function fmt(v, suffix) {
    if (v === null || v === undefined) return "—"
    var n = Number(v)
    if (!isFinite(n)) return "—"
    var s = Math.abs(n) >= 1000 ? n.toLocaleString("zh-CN") : String(n)
    return suffix ? s + suffix : s
  }

  // --- 主题 ---------------------------------------------------------------
  function applyTheme(theme) {
    if (!theme) return
    var root = document.documentElement
    if (theme.dark != null) root.dataset.theme = theme.dark ? "dark" : "light"
    if (theme.lang) root.lang = theme.lang
    var tokens = theme.tokens || {}
    for (var key in tokens) {
      if (Object.prototype.hasOwnProperty.call(tokens, key)) {
        var name = key.indexOf("--") === 0 ? key : "--magpie-" + key
        try { root.style.setProperty(name, tokens[key]) } catch (e) { /* ignore */ }
      }
    }
  }

  // --- 快照刷新 -----------------------------------------------------------
  // 重新插入 state.js（带 cache buster）。CSP 允许加载自己目录的文件。
  function reloadState() {
    return new Promise(function (resolve) {
      var old = document.getElementById("state-live")
      if (old && old.parentNode) old.parentNode.removeChild(old)
      var s = document.createElement("script")
      s.id = "state-live"
      s.src = "state.js?_=" + Date.now()
      var done = false
      var finish = function () { if (!done) { done = true; resolve(window.__CNB_STATE__) } }
      s.onload = finish
      s.onerror = finish
      document.head.appendChild(s)
      setTimeout(finish, 1500)
    })
  }

  // --- 剪贴板：三级降级 -----------------------------------------------
  function copyText(text) {
    var finish = function (ok) {
      var cmd = $("cmd")
      if (cmd) cmd.textContent = text
      toast(ok ? "已复制，粘贴到终端或聊天框执行" : "复制被沙箱拦了，直接选中下面的文本复制")
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { finish(true) }, function () { legacyCopy(text, finish) })
      return
    }
    legacyCopy(text, finish)
  }

  function legacyCopy(text, finish) {
    try {
      var ta = document.createElement("textarea")
      ta.value = text
      ta.setAttribute("readonly", "")
      ta.style.position = "fixed"
      ta.style.top = "-1000px"
      document.body.appendChild(ta)
      ta.select()
      var ok = document.execCommand && document.execCommand("copy")
      document.body.removeChild(ta)
      finish(Boolean(ok))
    } catch (e) {
      finish(false)
    }
  }

  function toast(message) {
    var host = $("note")
    if (!host || !host.parentNode) return
    var node = document.getElementById("toast")
    if (!node) {
      node = document.createElement("div")
      node.id = "toast"
      node.style.cssText =
        "margin-top:8px;padding:7px 11px;border-radius:8px;font-size:12px;" +
        "background:rgba(47,107,255,.12);border:1px solid rgba(47,107,255,.32);color:inherit;"
      host.parentNode.insertBefore(node, host.nextSibling)
    }
    node.textContent = message
    if (node._timer) clearTimeout(node._timer)
    node._timer = setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node) }, 6000)
  }

  function openUrl(url) {
    if (!url) return
    try { location.assign(url) } catch (e) { /* ignore */ }
  }

  // --- 渲染 ---------------------------------------------------------------
  function renderAccount(st) {
    var a = st.account || {}
    var nameNode = $("name")
    if (nameNode) nameNode.textContent = a.nickname || a.username || "未登录 CNB"

    var sub = $("sub")
    if (sub) {
      var parts = []
      // 名字已经是 nickname 时才补 @username，否则会显示成 "xiaopangdev / @xiaopangdev"
      if (a.username && a.nickname) parts.push("@" + a.username)
      if (st.scope && st.scope.repo) parts.push("仓库 " + st.scope.repo)
      else if (st.scope && st.scope.org) parts.push("组织 " + st.scope.org)
      else if (a.username) parts.push("未绑定仓库")
      if (a.username) parts.push("通道 " + (st.transport || "auto"))
      if (st.generatedAt) parts.push("快照 " + new Date(st.generatedAt).toLocaleString("zh-CN"))
      sub.textContent = parts.join(" · ") || "还没登录"
    }

    var avatar = $("avatar")
    if (avatar) {
      if (a.avatar) { avatar.src = a.avatar; avatar.hidden = false } else { avatar.hidden = true }
    }

    var badges = $("badges")
    if (badges) {
      clear(badges)
      var list = Array.isArray(a.badges) ? a.badges.slice() : []
      if (!list.length) {
        badges.appendChild(el("span", "badge muted", "暂无认证徽章"))
      } else {
        list.forEach(function (b) {
          var span = el("span", "badge " + (b.tone || "success"), b.label)
          var tip = b.tooltip || (b.source ? "来源：" + b.source : "")
          if (tip) span.title = tip
          badges.appendChild(span)
        })
      }
      if (a.verified) {
        var v = el("span", "badge info", "已实名")
        if (a.verifiedExpireIn) v.title = "认证有效期至 " + a.verifiedExpireIn
        badges.appendChild(v)
      }
    }
  }

  function renderCredit(st) {
    var c = st.credit || {}
    var stats = $("stats")
    if (!stats) return
    clear(stats)

    var cells = [
      ["已用", c.used, "credits"],
      ["总额度", c.total, "credits"],
      ["免费部分", c.free, "credits"],
      ["特权部分", c.privilege, "credits"]
    ]
    cells.forEach(function (cell) {
      var box = el("div", "stat")
      box.appendChild(el("div", "k", cell[0]))
      var v = el("div", "v", fmt(cell[1]))
      if (cell[1] !== null && cell[1] !== undefined) v.appendChild(el("span", "u", cell[2]))
      box.appendChild(v)
      stats.appendChild(box)
    })

    if (Array.isArray(st.sideQuotas)) {
      st.sideQuotas.forEach(function (q) {
        var box = el("div", "stat")
        box.appendChild(el("div", "k", q.name))
        var v = el("div", "v", fmt(q.amount))
        if (q.limit !== null && q.limit !== undefined) v.appendChild(el("span", "u", "/ " + fmt(q.limit) + (q.unit ? " " + q.unit : "")))
        else if (q.unit) v.appendChild(el("span", "u", q.unit))
        box.appendChild(v)
        stats.appendChild(box)
      })
    }

    var meter = $("meter")
    var fill = $("fill")
    var pct = num(c.percent)
    if (meter && fill && pct !== null) {
      meter.hidden = false
      var clamped = Math.max(0, Math.min(100, pct))
      fill.style.width = clamped + "%"
      fill.className = "fill" + (pct >= 100 ? " full" : pct >= 80 ? " hot" : "")
      $("meter-left").textContent = "已用 " + pct + "%"
      $("meter-right").textContent = c.resetsAt ? "下次重置 " + new Date(c.resetsAt).toLocaleDateString("zh-CN") : ""
    }
  }

  function renderEntrances(st) {
    var tbody = $("entries")
    if (!tbody) return
    clear(tbody)
    var list = Array.isArray(st.entrances) ? st.entrances : []
    list.forEach(function (e) {
      var tr = document.createElement("tr")

      tr.appendChild(el("td", "title", e.title))

      var stateTd = document.createElement("td")
      if (e.earned === true) stateTd.appendChild(el("span", "badge success", "已获得" + (e.label ? " · " + e.label : "")))
      else if (e.earned === false) stateTd.appendChild(el("span", "badge muted", "未获得"))
      else stateTd.appendChild(el("span", "badge info", "查看"))
      tr.appendChild(stateTd)

      var linkTd = document.createElement("td")
      var a = document.createElement("a")
      a.className = "entry"
      a.href = e.url || "#"
      a.textContent = e.urlLabel || "打开"
      a.addEventListener("click", function (ev) {
        ev.preventDefault()
        openUrl(e.url)
      })
      linkTd.appendChild(a)
      if (e.desc) {
        linkTd.appendChild(document.createElement("br"))
        linkTd.appendChild(el("span", "desc", e.desc))
      }
      tr.appendChild(linkTd)

      tr.appendChild(el("td", "reward", e.reward || "—"))
      tbody.appendChild(tr)
    })
  }

  function renderHints(st) {
    var note = $("note")
    if (!note) return
    clear(note)
    if (st.signIn === "expired") {
      var warn = el("div", "err")
      warn.appendChild(el("b", "", "登录已失效："))
      warn.appendChild(document.createTextNode(
        "CNB 拒绝了当前凭证。点「一键登录」重新读取本机登录态，或在插件里重新登录 cnb。"
      ))
      note.appendChild(warn)
    }
    if (st.error) {
      note.appendChild(el("div", "err", "取数失败：" + st.error))
    }
    var hints = Array.isArray(st.hints) ? st.hints : []
    hints.forEach(function (h) { note.appendChild(el("div", "", h)) })
    if (!st.error && !hints.length && st.signIn !== "expired") {
      var frag = document.createElement("span")
      frag.appendChild(el("b", "", "提示："))
      frag.appendChild(document.createTextNode(
        "页面没有网络权限，显示的是宿主写出的快照。点「刷新快照」重新读取；如果还是旧的，先在 magpie 里看一眼这个供应商的额度（会触发 usage 钩子重写快照）。"
      ))
      note.appendChild(frag)
    }
  }

  // --- 未登录引导 ---------------------------------------------------------
  function renderOnboarding(st) {
    var box = $("onboarding")
    if (!box) return
    var logged = Boolean(st && st.account && st.account.username)
    box.hidden = logged

    var link = $("link-token")
    if (link) {
      var tokenUrl = (st && st.routes && st.routes.token) || "https://cnb.cool/profile/token"
      link.setAttribute("href", tokenUrl)
      link.textContent = tokenUrl.replace(/^https?:\/\//, "")
    }
  }

  // --- 一键操作 -----------------------------------------------------------
  function bindActions(st) {
    var routes = st.routes || {}
    var tokenUrl = routes.token || "https://cnb.cool/profile/token"

    var login = $("btn-login")
    if (login) {
      login.addEventListener("click", function () {
        copyText("magpie plugin login cnb")
      })
    }

    var copyLogin = $("btn-copy-login")
    if (copyLogin) {
      copyLogin.addEventListener("click", function () {
        copyText("magpie plugin login cnb")
      })
    }

    var linkToken = $("link-token")
    if (linkToken) {
      linkToken.addEventListener("click", function (ev) {
        ev.preventDefault()
        openUrl(tokenUrl)
      })
    }

    var repo = $("btn-repo")
    if (repo) {
      repo.addEventListener("click", function () {
        var org = (st.scope && st.scope.org) || "<组织 slug>"
        copyText(
          "用 cnb_create_repo 工具在组织 " + org + " 下创建仓库 code（visibility=private），" +
          "建完后把插件选项 repo 设为 " + org + "/code"
        )
        toast("已复制建仓指令。也可以直接打开 " + (routes.newRepo || "https://cnb.cool/new/repos") + " 手工建。")
      })
    }

    var claim = $("btn-claim")
    if (claim) {
      claim.addEventListener("click", function () {
        copyText(
          "用 cnb_claim_points 工具领取积分；如果返回未配置领取端点，就打开 " +
          (routes.extIdentityPrivilege || "https://cnb.cool/user/charge/ext_identity/privilege") +
          " 看认证特权额度"
        )
      })
    }

    var quota = $("btn-quota")
    if (quota) {
      quota.addEventListener("click", function () { openUrl(routes.quota || "https://cnb.cool/user/quota") })
    }

    var refresh = $("btn-refresh")
    if (refresh) {
      refresh.addEventListener("click", function () {
        refresh.disabled = true
        reloadState().then(function (next) {
          refresh.disabled = false
          if (next) renderAll(next)
          toast("快照已重新读取")
        })
      })
    }
  }

  // --- 多账号列表：宿主把每个账号的快照并进 state.accounts ----------------
  function renderAccountList(state) {
    var existing = document.querySelector(".cnb-accounts")
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    var book = state && state.accounts && typeof state.accounts === "object" ? state.accounts : null
    var list = book ? Object.keys(book).map(function (k) { return book[k] }) : (state && state.account ? [state] : [])
    list = list.filter(function (s) { return s && s.account && (s.account.username || s.account.id) })
    if (list.length < 2) return

    var host = el("section", "cnb-section cnb-accounts")
    host.appendChild(el("h2", "", "账号（" + list.length + "）"))
    var wrap = el("div", "cnb-account-list")
    var current = String((state.account && state.account.username) || "")

    list.forEach(function (snap) {
      var a = snap.account || {}
      var card = el("div", "cnb-account-card" + (a.username === current ? " on" : ""))
      var head = el("div", "cnb-account-head")
      head.appendChild(el("span", "cnb-account-name", a.nickname || a.username || "CNB 账号"))
      head.appendChild(el("span", "cnb-account-user", "@" + (a.username || "?")))
      if (a.username === current) head.appendChild(el("span", "cnb-account-tag", "最近刷新"))
      card.appendChild(head)

      var badges = el("div", "cnb-account-badges")
      var earned = (a.badges || []).filter(function (b) { return b.earned !== false })
      earned.forEach(function (b) { badges.appendChild(el("span", "cnb-account-badge", b.label)) })
      if (!earned.length) badges.appendChild(el("span", "cnb-account-badge off", "无认证徽章"))
      card.appendChild(badges)

      var credit = snap.credit || {}
      var numbers = el("div", "cnb-account-line")
      numbers.textContent =
        "AI Credit " + (credit.used == null ? "—" : credit.used) +
        " / " + (credit.total == null ? "—" : credit.total) +
        (credit.privilege ? "（特权 " + credit.privilege + "）" : "")
      card.appendChild(numbers)

      var ch = el("div", "cnb-account-line dim")
      var scope = snap.scope || {}
      ch.textContent =
        "通道 " + (snap.transport || "auto") +
        " · " + (scope.repo || scope.org || "未定范围") +
        (a.verified ? " · 已实名" : "")
      card.appendChild(ch)
      wrap.appendChild(card)
    })

    host.appendChild(wrap)
    var first = document.querySelector("body > .cnb-section")
    if (first && first.parentNode) first.parentNode.insertBefore(host, first)
    else document.body.appendChild(host)
  }

  // --- AI 通道：中继 / CNBSESSION 的入口 -----------------------------------
  // 为什么要这个区块：magpie 的登录流程只在「登录」那一步给方式选择，
  // 登录完成后没有任何补/换凭据的入口（宿主 apiKey() 只有 auth.single=true 才覆盖老账号，
  // 否则永远新建账号）。而插件页有 bridge 的 magpie.options.set()，
  // 所以把「中继地址 / 中继 Key / CNBSESSION」做成插件选项，在这里填、在这里改。
  function optionsApi() {
    var b = window.magpie
    if (!b || !b.options || typeof b.options.get !== "function" || typeof b.options.set !== "function") return null
    return b.options
  }

  function inputBox(type, placeholder) {
    var node = document.createElement("input")
    node.className = "cnb-input"
    node.type = type
    node.autocomplete = "off"
    node.spellcheck = false
    node.placeholder = placeholder
    return node
  }

  function field(labelText, node, hint) {
    var row = el("div", "cnb-field")
    var lab = document.createElement("label")
    lab.className = "cnb-label"
    lab.appendChild(el("span", "cnb-label-text", labelText))
    lab.appendChild(node)
    row.appendChild(lab)
    if (hint) row.appendChild(el("div", "cnb-hint", hint))
    return row
  }

  function mountChannel() {
    var host = el("section", "cnb-section cnb-channel")
    host.appendChild(el("h2", "", "AI 通道"))

    var api = optionsApi()
    if (!api) {
      host.appendChild(el("div", "cnb-hint", "当前 magpie 不支持页面写插件选项（bridge 没有 options.set）。"))
      var tip = el("div", "cmd", "magpie plugin options opencode-cnb-account '{\"transport\":\"relay\"}'")
      host.appendChild(tip)
      insertChannelSection(host)
      return
    }

    var select = document.createElement("select")
    select.className = "cnb-input"
      ;[
        ["auto", "自动：先中继，再 CNBSESSION"],
        ["relay", "只用中继机（支持 tools）"],
        ["cookie", "只用 CNBSESSION 直连（不支持 tools）"]
      ].forEach(function (pair) {
        var o = document.createElement("option")
        o.value = pair[0]
        o.textContent = pair[1]
        select.appendChild(o)
      })

    var relayUrl = inputBox("text", "http://127.0.0.1:3000/v1")
    var relayKey = inputBox("password", "中继机的 Key（留空 = 不改）")
    var session = inputBox("password", "CNBSESSION：123456.789012.<hex>")
    var status = el("div", "cnb-hint", "读取中…")

    var save = el("button", "cnb primary", "保存并生效")
    var clearSession = el("button", "cnb", "清空 CNBSESSION")
    var clearKey = el("button", "cnb", "清空中继 Key")

    function fill(saved) {
      var o = saved || {}
      var relay = o.relay || {}
      select.value = o.transport || "auto"
      relayUrl.value = relay.url || ""
      relayKey.placeholder = relay.key ? "已保存（" + String(relay.key).length + " 字符），留空不改" : "中继机的 Key"
      session.placeholder = o.session ? "已保存（" + String(o.session).length + " 字符），留空不改" : "CNBSESSION：123456.789012.<hex>"
      var snap = window.__CNB_STATE__ || {}
      status.textContent =
        "快照通道 " + (snap.transport || "auto") +
        " · 中继 " + (relay.url ? relay.url : "未填") +
        " · Key " + (relay.key ? "已配置" : "未配置") +
        " · CNBSESSION " + (o.session ? "已配置" : "未配置")
    }

    function persist(mutate, okText) {
      save.disabled = true
      clearKey.disabled = true
      clearSession.disabled = true
      status.textContent = "保存中…"
      api
        .get()
        .then(function (current) {
          var next = Object.assign({}, current || {})
          next.relay = Object.assign({}, next.relay || {})
          mutate(next)
          return api.set(next)
        })
        .then(function (saved) {
          relayKey.value = ""
          session.value = ""
          fill(saved)
          toast(okText)
          status.textContent = status.textContent + " · 已保存，发一条消息验证"
        })
        .catch(function (e) {
          status.textContent = "保存失败：" + (e && e.message ? e.message : e)
        })
        .then(function () {
          save.disabled = false
          clearKey.disabled = false
          clearSession.disabled = false
        })
    }

    save.addEventListener("click", function () {
      persist(function (next) {
        next.transport = select.value
        next.relay.url = relayUrl.value.trim()
        if (relayKey.value.trim()) next.relay.key = relayKey.value.trim()
        if (session.value.trim()) next.session = session.value.trim()
      }, "AI 通道已保存")
    })

    clearSession.addEventListener("click", function () {
      persist(function (next) {
        next.session = ""
      }, "已清空 CNBSESSION")
    })

    clearKey.addEventListener("click", function () {
      persist(function (next) {
        next.relay.key = ""
      }, "已清空中继 Key")
    })

    host.appendChild(field("通道", select, "自动 = 有中继地址就走中继，否则看 CNBSESSION。"))
    host.appendChild(field("中继地址", relayUrl, "OpenAI 兼容网关，例如本机 new-api 的 /v1 出口。"))
    host.appendChild(field("中继 Key", relayKey, "中继机要求的 Bearer Key。已保存的值不会回显。"))
    host.appendChild(field("CNBSESSION", session, "浏览器登录 cnb.cool → F12 → Application → Cookies → https://cnb.cool → 复制 CNBSESSION 的值。"))
    var actions = el("div", "actions")
    actions.appendChild(save)
    actions.appendChild(clearSession)
    actions.appendChild(clearKey)
    host.appendChild(actions)
    host.appendChild(status)

    api.get().then(fill).catch(function (e) {
      status.textContent = "读取插件选项失败：" + (e && e.message ? e.message : e)
    })

    insertChannelSection(host)
  }

  function insertChannelSection(host) {
    var anchor = $("cmd")
    var section = anchor && anchor.closest ? anchor.closest(".cnb-section") : null
    if (section && section.parentNode) section.parentNode.insertBefore(host, section)
    else document.body.appendChild(host)
  }

  // --- magpie 侧统计（需要 package.json 里声明 usage:summary） -----------
  function renderMagpie() {
    var host = $("mw")
    if (!host || !window.magpie || !window.magpie.read) return
    window.magpie
      .read("usage:summary", { period: "today" })
      .then(function (s) {
        clear(host)
        var cells = [
          ["今日调用", s.calls],
          ["错误", s.errors],
          ["token", s.tokens],
          ["费用", s.cost]
        ]
        cells.forEach(function (cell) {
          var box = el("div", "stat")
          box.appendChild(el("div", "k", cell[0]))
          box.appendChild(el("div", "v", fmt(cell[1])))
          host.appendChild(box)
        })
        var section = host.closest ? host.closest(".cnb-section") : null
        if (section) section.hidden = false
      })
      .catch(function () {
        var section = host.closest ? host.closest(".cnb-section") : null
        if (section) section.hidden = true
      })
  }

  function renderAll(st) {
    if (!st) return
    renderAccount(st)
    renderOnboarding(st)
    renderCredit(st)
    renderEntrances(st)
    renderHints(st)
  }

  // --- 启动 ---------------------------------------------------------------
  function boot() {
    // 先用已经加载的 state.default.js（或上次写出的快照）立刻渲染，不等 state.js。
    renderAll(window.__CNB_STATE__ || {})
    bindActions(window.__CNB_STATE__ || {})
    renderMagpie()
    renderAccountList(window.__CNB_STATE__ || {})
    mountChannel()

    var bridge = window.magpie
    var start = bridge && bridge.ready ? bridge.ready : Promise.resolve(null)
    start
      .then(function (theme) {
        applyTheme(theme)
        if (bridge && bridge.onTheme) bridge.onTheme(applyTheme)
        // 再尝试拉运行时快照 state.js（不存在就保持默认，onerror 静默）
        return reloadState()
      })
      .then(function (st) {
        if (st) {
          renderAll(st)
          renderAccountList(st)
        }
      })
      .catch(function (error) {
        var sub = $("sub")
        if (sub) sub.textContent = "页面初始化失败：" + (error && error.message ? error.message : error)
      })
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
  else boot()
})();
