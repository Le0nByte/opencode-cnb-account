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
      if (a.username) parts.push("@" + a.username)
      if (st.scope && st.scope.repo) parts.push("仓库 " + st.scope.repo)
      else if (st.scope && st.scope.org) parts.push("组织 " + st.scope.org)
      else parts.push("未绑定仓库")
      parts.push("通道 " + (st.transport || "auto"))
      if (st.generatedAt) parts.push("快照 " + new Date(st.generatedAt).toLocaleString("zh-CN"))
      sub.textContent = parts.join(" · ")
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
          if (b.tooltip) span.title = b.tooltip
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

  // --- 一键操作 -----------------------------------------------------------
  function bindActions(st) {
    var routes = st.routes || {}

    var login = $("btn-login")
    if (login) {
      login.addEventListener("click", function () {
        copyText("magpie plugin login cnb")
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
    renderCredit(st)
    renderEntrances(st)
    renderHints(st)
  }

  // --- 启动 ---------------------------------------------------------------
  function boot() {
    var bridge = window.magpie
    var start = bridge && bridge.ready ? bridge.ready : Promise.resolve(null)
    start
      .then(function (theme) {
        applyTheme(theme)
        if (bridge && bridge.onTheme) bridge.onTheme(applyTheme)
        return reloadState()
      })
      .then(function (st) {
        renderAll(st || window.__CNB_STATE__ || {})
        bindActions(window.__CNB_STATE__ || {})
        renderMagpie()
      })
      .catch(function (error) {
        var sub = $("sub")
        if (sub) sub.textContent = "页面初始化失败：" + (error && error.message ? error.message : error)
      })
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
  else boot()
})();
