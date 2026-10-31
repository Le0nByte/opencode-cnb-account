# opencode-cnb-account

Magpie（以及 OpenCode）的 **CNB（cnb.cool）账户插件**。把一个 CNB 账号变成 magpie 里的一个供应商：

- **一键登录**：读取本机 `cnb-cli` 登录态，或粘贴 PAT / 浏览器登录态
- **创建仓库**：`POST /{slug}/-/repos` 直接建仓，失败时给出可直接照做的手工步骤
- **积分调用 / 领取**：当月 Credit 用量、特权额度、认证特权入口，以及可配置的领取端点
- **面板展示认证信息**：`天才程序员` / `高校学生·老师·校友·职工` / `天才学生…` / `TDP 会员` / `内测玩家` / `开服玩家`，每条认证都带**可点击入口**和**对应的积分奖励**说明

> 插件 = OpenCode v1 供应商插件。所有 magpie 私有钩子（`auth.usage` / `auth.checkin` / `magpie.*` 清单字段）OpenCode 会忽略，所以同一个包两边都能装。

---

## 1. 装法

```bash
# 文件夹就地加载，不安装任何东西（改完关掉插件再打开即可生效）
magpie plugin add ./opencode-cnb-account

magpie plugin            # 应该看到 cnb (CNB (cnb.cool), 8 models)
magpie plugin login cnb  # 选登录方式
magpie quota             # 看认证徽章 + 当月 Credit
magpie provider test cnb # 发一个很小的请求验证 AI 通道
```

应用里：打开 **插件 → 添加插件 → 填文件夹绝对路径**，然后在 `cnb` 那一行点登录。

沙箱里试（不碰你正在用的 magpie）：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache magpie "$@"; }
m plugin add "$PWD/opencode-cnb-account" </dev/null
m plugin --json
m plugin login cnb
m quota
```

自检：

```bash
node scripts/check.mjs     # 146 项：钩子形状、沙箱约束、徽章判定、SSE 折叠、路由、id 交叉校验
```

---

## 2. 三种登录方式

| 方式 | 适用 | 拿到什么 | 注意 |
|---|---|---|---|
| **一键登录**（oauth） | 本机已经 `cnb login` 过 | `CNB_TOKEN` 环境变量 / `~/.cnb/token` | 只读本机文件，不联网登录；找不到时会提示去装 `@cnbcool/cnb-cli` |
| **个人访问令牌 PAT**（api） | 有 PAT，走 API | `/user`、`/user/groups`、额度、建仓 | PAT 需要 `account-profile:r` + `group-resource:rw` 才能建仓 |
| **浏览器登录态 CNBSESSION**（api） | 要用路线 B 直连 AI | `CNBSESSION` + `csrfkey` | 会先抓一次 `cnb.cool/` 验证：匿名首页约 145KB、登录态约 350KB，长度不对直接判失败 |

登录时还会问三个问题（可留空）：

- `org` —— 顶级组织 slug，留空自动取 `/user/groups` 的第一个
- `repo` —— 仓库路径 `org/repo`，AI 通道要用
- `transport` —— AI 通道，见下一节

登录成功后，账号卡片上的 `plan` 会显示认证徽章串（例如 `天才程序员 · 高校老师`），`user` 显示 CNB 用户名。

---

## 3. AI 通道：三条，能力不同

插件按 `transport` 选通道；`auto` 的判定顺序是 **relay → cookie → direct**。

| transport | 端点 | tools | 说明 |
|---|---|---|---|
| `relay` | 你的中继机 `/v1/chat/completions` | ✅ 原生 | 路线 A。中继机本身就是 OpenAI 兼容网关，插件直通，不碰 CNB 鉴权 |
| `cookie` | `https://cnb.cool/{org}/{repo}/-/ai/chat/completions` | ❌ | 路线 B。带 `CNBSESSION` + `Csrftoken`，上游结构性拒绝 tools（`403 Agent calls are not allowed`），插件会**提前**返回 403 说明，而不是静默降级 |
| `direct` | `https://api.cnb.cool/{org}/{repo}/-/ai/chat/completions` | ❌ | 保留通道。官方文档写明「仅允许在 CNB 流水线内用 CNB_TOKEN 调用」，个人 PAT 直连会被拒，插件会把这句话原样回给你 |

三条通道都做了两件事：

1. **恒以 `stream:true` 调上游**（上游对非流式直接回 `code 11101`），
2. 客户端要非流式时，把 SSE **折叠**成一次性 `chat.completion`（`choices[0].message.content`、`finish_reason`、`tool_calls` 都会还原）。

所有请求都带 `User-Agent` —— 缺 UA 会被 Cloudflare 判 bot，回 `403 Error 1010 browser_signature_banned`。

`cookie` / `direct` 通道下，模型列表里的 `capabilities.toolcall` 会自动变成 `false`，免得 agent 以为能调工具。

### 选项

改 `~/.config/magpie/plugins.json` 里这一项的 `options`，或在应用里点「选项」：

```json
{
  "org": "my-org",
  "repo": "my-org/code",
  "transport": "auto",
  "relay": { "url": "https://cnb.example.com/v1", "key": "<PROXY_KEY>" },
  "claim": { "url": "", "method": "POST", "body": "{}" },
  "autoCreateRepo": false,
  "repoName": "code",
  "visibility": "private"
}
```

---

## 4. 页面与面板：认证信息 + 积分入口

插件带一个**独立页面**（侧边栏 `CNB 账户`）和一个**供应商面板**（任一已保存 Supplier 的编辑页底部），两者同一份数据、同一套渲染。

```
账号  avatar  昵称 / @username
徽章  [天才程序员] [高校老师] [TDP P1] [内测玩家] [已实名]
积分  已用 250   总额度 1,166   免费 500   特权 666
      ├ 云原生开发 48 / 1600 core·h ├ 云原生构建 0 / 160 core·h ├ Git 存储 1.2 / 50 GiB
      ▓▓▓▓░░░░░░░░░░  已用 21.4%      下次重置 2026/11/1
认证与积分入口
      项目                状态            入口                积分奖励
      高校认证（高校师生）  未获得         去认证 / 查看 →     认证后解锁高校师生专属额度档位
      天才程序员          已获得 天才程序员  去申请 / 查看 →     天才计划专属特权额度
      TDP 会员            未获得         去开通 / 查看 →     TDP 会员特权额度
      实名认证            已实名          去实名 →            全部免费额度的前置条件
      认证特权积分         —              查看特权额度 →      按认证项累加
      额度总览             —              打开额度页 →        免费 500 / 月，完成 hello-cnb 后 1166 / 月
一键操作  [一键登录] [创建仓库] [领取积分] [额度页] [刷新快照]
```

### 为什么页面不直接请求 CNB

magpie 的插件页面跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 的框架里：**没有 fetch / WebSocket / beacon，也不给窗口的 cookie 和存储**。`magpie.read` 只开放 `usage:summary` 和 `providers:list`，都不会给出账号或登录信息。

所以本插件的做法是：

1. **宿主侧**（Bun，有完整网络权限）在 `auth.usage` / `provider.models` / 工具调用时采集一份快照，
2. 写成 `page/state.js`（`window.__CNB_STATE__`），
3. 页面只读这份快照；点「刷新快照」用 `state.js?_=时间戳` 重新加载。

入库的是 `page/state.default.js`（默认兜底，页面先渲染它，再动态拉 `state.js` 覆盖）；`page/state.js` 是运行时产物，写进 `.gitignore`，否则每次读额度都会让仓库变 dirty。

也就是说：**页面显示的是宿主写出来的快照，点一次 magpie 里的额度就能刷新**。这是沙箱约束下的唯一正解，不是偷懒。

页面跳转用 `location.assign()`（沙箱允许自己导航，不允许 `window.open`）。复制用 `navigator.clipboard` → `execCommand` → 显示可选文本，三级降级。

---

## 5. 积分：调用与领取

### 调用（用量）

`auth.usage` 每次把下面这些推给 magpie，显示在账号卡片、`magpie quota`、`GET /v1/magpie/quotas`：

| 字段 | 来源 |
|---|---|
| `plan` | 认证徽章串，如 `天才程序员 · 高校学生` |
| `user` | `/user` 的 `username` |
| `balance` | `<总额度> credits` |
| `windows[0]` `AI Credit（当月）` | `/{org}/-/charge/quota` 的 `credit_in_milli.total` × `/{org}/-/charge/volume` 的 `credit_in_milli`（1000 milli = 1 credit） |
| `windows[1..]` `云原生开发 / 云原生构建 / Git 存储 / 对象存储` | 同两个接口的核时与字节项，标记 `aside: true`（用超了也不影响账号可用性） |

当月重置时间按 UTC 次月 1 日算。

### 领取

**CNB 没有公开的「每日签到」接口**，免费额度是每月自动发放的。所以 `auth.checkin` 默认返回 `outcome: "inactive"` 并说明原因，不假装成功。

确实有领取端点时（自建活动接口、组织内的领取 API 等），配 `claim`：

```json
"claim": { "url": "https://api.cnb.cool/{{org}}/-/claim", "method": "POST", "body": "{\"source\":\"magpie\"}" }
```

占位符支持 `{{org}}` / `{{repo}}` / `{{token}}`。响应按这些字段解析：

- `credit` / `amount` / `points` → 本次领到的额度
- `streak` / `days` → 连续天数
- `already: true` 或 `claimed: false` → `outcome: "done"`
- `captcha` / `need_captcha` → `outcome: "captcha"`（不去解，让用户自己去站点签到）
- 401/403 → `ineligible`，429 → `failed`（当天稍后重试）

配好之后 magpie 每个北京日会自动为一个已登录账号调一次，也可以让 agent 直接调 `cnb_claim_points`。

---

## 6. 三个工具（agent 可直接调用）

插件用 `tool` 钩子提供工具，magpie 把它们聚合成 `http://127.0.0.1:3425/mcp/magpie/tools` 这一个 MCP 服务器，任何 agent 都能用。工具名是 `cnb_account` / `cnb_create_repo` / `cnb_claim_points`（magpie 侧会加 `<插件短名>_` 前缀，实际叫 `opencode-cnb-account_cnb_account` 这种形式）。

| 工具 | 作用 |
|---|---|
| `cnb_account` | 返回认证徽章、组织/仓库、当月 Credit、每条认证的入口和奖励。`{"refresh": true}` 跳过 60s 缓存 |
| `cnb_create_repo` | `{name, description?, visibility?, org?}` → 建仓；失败返回手工步骤 |
| `cnb_claim_points` | 触发一次领取（走 `claim` 配置），没配就说明为什么不做 |

工具的 `args` 直接给 **JSON Schema**，不依赖 `@opencode-ai/plugin`，装包时不会因为 `postinstall` 被禁而挂掉。

---

## 7. 创建仓库

三条路，按可靠性排序：

**① 工具自动建（推荐）**

```bash
用 cnb_create_repo 工具在组织 my-org 下创建仓库 code（visibility=private）
```

对应 `POST https://api.cnb.cool/{org}/-/repos`，body `{name, description, visibility}`，需要 PAT 带 `group-resource:rw`。

**② 登录时顺手建**

选项里把 `autoCreateRepo` 设成 `true`、`repoName` 设成 `code`，登录流程会先 `GET /{org}/-/repos` 看有没有同名仓库，没有就建。

**③ 手工建（一定成功）**

1. 打开 <https://cnb.cool/new/repos>
2. 组织选 `my-org`，仓库名填 `code`
3. **可见性选 private** —— 路线 A 的 `.cnb.yml` 里会写明文密钥
4. 建完把插件选项 `repo` 设成 `my-org/code`

> 没有顶级组织时先去 <https://cnb.cool/new/groups> 建一个。实名认证（微信扫码 + 手机号）是建组织的前置条件。

自动建仓失败不会静默：`cnb_create_repo` 会把失败原因 + 上面这四步一起返回，页面「创建仓库」按钮复制的是可直接粘给 agent 的指令。

---

## 8. 认证徽章字典

判定逻辑照搬 cnb.cool 前端的徽章组件（`identity_providers` → 徽章），i18n 键来自 `EXT_IDENTITY_*`：

| `identity_providers` | 徽章 |
|---|---|
| `genius` | **天才程序员** |
| `edu.identity_type = STUDENT` | 高校学生 |
| `edu.identity_type = TEACHER` | 高校老师 |
| `edu.identity_type = ALUMNI` | 高校校友 |
| `edu.identity_type = STAFF` | 高校职工 |
| `edu.identity_type = ENTERPRISE` | 高校合作企业 |
| `edu.identity_type = ORGANIZATION` | 高校开放实验室 |
| `genius` + `edu` | **天才学生 / 天才老师 / 天才校友 / 天才职工 / 天才合作企业 / 天才开放实验室**（tooltip 显示「天才程序员 + 高校xx」） |
| `tdp.tdp_primary_tag = X` | `TDP X` |
| `obt_player` | 内测玩家 |
| `day_one_player` | 开服玩家 |
| `user.verified ≠ 0` | 已实名（附有效期） |

对照的是 cnb.cool 前端 bundle 里的判定顺序：多个 provider 可以同时显示，`genius + edu` 会合并成「天才X」而不是显示两枚。

---

## 9. 用到的 CNB 端点

全部来自 `https://api.cnb.cool/swagger.json`（199 个路径）与 cnb.cool 前端 bundle，不是猜的：

| 方法 | 路径 | 用途 | 权限 |
|---|---|---|---|
| GET | `/user` | 用户详情，含 `identity_providers` / `verified` | `account-profile:r` |
| GET | `/user/groups` | 顶级组织列表 | `account-engage:r` |
| GET | `/{slug}/-/charge/quota` | 当月额度（`credit_in_milli.{free,total}` 等） | `group-resource:r` |
| GET | `/{slug}/-/charge/volume` | 当月用量（含 `freeze_*` 预扣） | `group-resource:r` |
| GET | `/{slug}/-/charge/special-amount` | 特权额度（`credit` + `credit_desc` + `credit_expire`） | 根组织 master+ |
| GET | `/{slug}/-/repos` | 组织可见仓库 | `group-resource:r` |
| POST | `/{slug}/-/repos` | 创建仓库 | `group-resource:rw` |
| POST | `/{repo}/-/ai/chat/completions` | AI 对话 | `repo-code:r`，**仅流水线内 CNB_TOKEN** |
| POST | `https://cnb.cool/{repo}/-/ai/chat/completions` | 路线 B AI 端点（cookie + csrf） | 登录态 |

控制台路由：`/user/identity`（实名）、`/user/ext_identity`（高校/天才/TDP）、`/user/charge/ext_identity/privilege`（认证特权额度）、`/user/quota`（额度）、`/new/repos`（建仓）、`/new/groups`（建组织）。

---

## 10. 已知限制

1. **页面不能联网**（沙箱硬约束）。要刷新数据得让宿主跑一次 → 在 magpie 里看一眼额度，或调 `cnb_account` 工具，或点面板的「刷新快照」（只是重读快照，不会触发采集）。
2. **`cookie` 通道不支持工具调用**，这是 CNB 上游的结构性限制，不是插件的锅。要 tools 就用 `relay` 走路线 A。
3. **`direct` 通道对个人 PAT 基本不可用**，官方写明只允许流水线内的 `CNB_TOKEN`。保留它是因为在流水线里跑时确实能用。
4. **`CNBSESSION` 会过期**，没有自动续期。失效时插件会判 `signIn: "expired"` 并让 magpie 把账号标记成需要重新登录。
5. **`online` 状态不会自己刷新**：`signIn` 只在 401/403 且报错提到 token/login/session 时才标 `expired`，报「模型不可用」的 401 按 `kept` 处理，避免一次故障把账号全标红。
6. **`special-amount` 需要根组织 master 权限**，无权限时该字段为空，界面显示「—」而不是 0。

---

## 11. 文件

```
opencode-cnb-account/
├── package.json          magpie 清单：icon / maxConcurrency / page / panels / permissions / options
├── index.mjs             config + auth(methods,loader,usage,checkin) + provider.models + tool + chat.headers
├── page/
│   ├── index.html        独立页面
│   ├── panel.html        供应商面板（slot: provider）
│   ├── app.js            渲染 + 复制 + 跳转（不联网）
│   ├── style.css         --magpie-* 变量 + 自己的规则
│   ├── state.default.js  默认快照（入库兜底）
│   │                   state.js 是宿主写出的运行时快照，已在 .gitignore 里
│   └── icon.svg          插件图标
├── scripts/
│   ├── check.mjs         146 项自检
│   └── push.mjs          一条命令推到 GitHub
├── PUSH-TO-GITHUB.md     推送的三种方式（HTTPS token / SSH / gh CLI）
├── .gitignore .gitattributes   统一 LF（Windows 上编辑不会污染模板字符串）
├── LICENSE               MIT
└── README.md
```

## 12. 发布与上架

**推到 GitHub 就能被装：**

```bash
node scripts/push.mjs https://github.com/OWNER/REPO.git   # 或看 PUSH-TO-GITHUB.md 走 SSH / gh
magpie plugin add github:OWNER/REPO                       # 别人这样装
```

**进 magpie 的「发现」页**需要两件事，仓库里都已备好：

1. `package.json` 在仓库根目录，且 magpie 要加载的文件（`index.mjs`、`page/*`）**已提交进仓库** —— 只在发布时才构建 `dist` 的仓库不显示
2. 给仓库打 `magpie-plugin` topic：

```bash
gh repo edit OWNER/REPO --add-topic magpie-plugin --add-topic opencode-plugin --add-topic cnb
```

关键词也符合搜索规则（名字或 `keywords` 里同时含 `opencode` + `auth|plugin|provider` 之一）。

**发 npm**（可选，装法更短）：

```bash
npm publish --access public
magpie plugin add opencode-cnb-account
```

> `files` 里只放 `index.mjs` / `page` / `README.md`，`scripts` 和文档不进包。

## 13. 许可

MIT（见 [LICENSE](LICENSE)）
