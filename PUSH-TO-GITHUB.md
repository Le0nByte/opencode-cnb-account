# 推到 GitHub

这个目录已经是 `main` 分支的 git 仓库，并且有一个已完成的提交。**只差一个远程地址和一份凭证** —— 这台机器上没有 `gh` CLI、没有 `GITHUB_TOKEN`，`~/.ssh/id_ed25519` 也没被 GitHub 授权（`git@github.com: Permission denied (publickey)`），所以远程那一步留给你填。

把下面命令里的 `你的用户名` 换成你的 GitHub 用户名，`REPO` 换成仓库名（建议就叫 `opencode-cnb-account`）。

---

## 方式 1：HTTPS + Personal Access Token（最快）

在 GitHub → Settings → Developer settings → Personal access tokens 建一个带 `repo` 权限的 token，然后：

```bash
cd opencode-cnb-account
git remote add origin https://github.com/411304344/opencode-cnb-account.git
git push -u origin main
# 提示密码时粘贴 token（不是账号密码）
```

或者一次性把 token 写进 URL（注意会留在 shell history / git config 里）：

```bash
git remote add origin https://<TOKEN>@github.com/411304344/opencode-cnb-account.git
git push -u origin main
```

想让它记住凭证：

```bash
git config --global credential.helper manager   # Windows 自带 GCM
```

## 方式 2：SSH

先把公钥加到 GitHub → Settings → SSH and GPG keys：

```bash
cat ~/.ssh/id_ed25519.pub
```

然后：

```bash
cd opencode-cnb-account
ssh -T git@github.com          # 应回 "Hi 你的用户名! You've successfully authenticated"
git remote add origin git@github.com:411304344/opencode-cnb-account.git
git push -u origin main
```

## 方式 3：gh CLI 一把梭（连建仓一起）

```bash
# Windows
winget install --id GitHub.cli -e
gh auth login
cd opencode-cnb-account
gh repo create REPO --public --source=. --remote=origin --push \
  --description "Magpie / OpenCode provider plugin for CNB (cnb.cool): login, identity badges, credits, repo bootstrap, AI relay"
gh repo edit --add-topic magpie-plugin --add-topic opencode-plugin --add-topic cnb
```

`magpie-plugin` 这个 topic 有用：magpie 的「插件 → 发现 → 非官方插件 · GitHub」就是按它抓仓库的（最多十分钟拉一次）。

---

## 仓库建好后，别人怎么用

```bash
# 直接从 GitHub 装（Bun 拉仓库当前代码）
magpie plugin add github:411304344/opencode-cnb-account

# 或先克隆再本地加载（改代码立刻生效）
git clone https://github.com/411304344/opencode-cnb-account.git
magpie plugin add ./REPO
```

> 仓库里 `package.json` 必须在根目录，且 magpie 加载的文件要**提交进仓库** —— 只在发布时才构建 `dist` 的仓库不会出现在发现页。

想更好的话发 npm：

```bash
npm publish --access public
# 之后 magpie plugin add opencode-cnb-account
```

`keywords` 里已经有 `opencode` / `opencode-plugin` / `magpie`，符合 magpie 搜索的匹配规则（名字或 keywords 里同时含 `opencode` + `auth|plugin|provider` 之一）。

---

## 推送后自查

```bash
git log --oneline --stat | head -40
git remote -v
curl -s https://api.github.com/repos/411304344/opencode-cnb-account | head -5     # 确认仓库真的建出来了
```

## 待填占位符

| 占位符 | 换成 |
|---|---|
| `你的用户名` | 你的 GitHub 用户名或组织名 |
| `REPO` | 仓库名，建议 `opencode-cnb-account` |
| `<TOKEN>` | 带 `repo` 权限的 PAT |
