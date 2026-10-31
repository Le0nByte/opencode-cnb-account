#!/usr/bin/env node
// 一条命令把本仓库推到 GitHub。
//
// 用法：
//   node scripts/push.mjs https://github.com/OWNER/REPO.git
//   node scripts/push.mjs git@github.com:OWNER/REPO.git
//   node scripts/push.mjs https://github.com/OWNER/REPO.git --branch main
//
// 会做：校验当前目录是 git 仓库 → 确认工作区干净 → 设置/更新 origin → push → 打印 magpie 安装命令。
// 凭证走你系统的 git credential helper（Windows 默认 Git Credential Manager），脚本不碰 token。

import { execFileSync } from "node:child_process"

const args = process.argv.slice(2)
const remote = args.find((a) => !a.startsWith("--"))
const branchIdx = args.indexOf("--branch")
const branch = branchIdx >= 0 ? args[branchIdx + 1] : "main"

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe" }).trim()
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exitCode = 1
  process.exit()
}

if (!remote) {
  fail(
    "缺少远程地址",
    "用法：node scripts/push.mjs https://github.com/OWNER/REPO.git\n" +
      "     node scripts/push.mjs git@github.com:OWNER/REPO.git\n" +
      "详见 PUSH-TO-GITHUB.md",
  )
}
if (!/^(https:\/\/|git@|ssh:\/\/)/.test(remote)) {
  fail(`远程地址看起来不对：${remote}`, "应该是 https://github.com/OWNER/REPO.git 或 git@github.com:OWNER/REPO.git")
}

try {
  run("git", ["rev-parse", "--is-inside-work-tree"])
} catch {
  fail("当前目录不是 git 仓库", "先 git init -b main 并提交，或在 opencode-cnb-account 目录内运行")
}

const dirty = run("git", ["status", "--porcelain"])
if (dirty) {
  console.log("⚠ 工作区还有未提交的改动：")
  console.log(dirty)
  console.log("  推送的只是已提交的内容。要继续就先 git add -A && git commit -m \"…\"")
}

const hasOrigin = (() => {
  try {
    return Boolean(run("git", ["remote", "get-url", "origin"]))
  } catch {
    return false
  }
})()

if (hasOrigin) {
  const current = run("git", ["remote", "get-url", "origin"])
  if (current !== remote) {
    console.log(`· origin 从 ${current} 改为 ${remote}`)
    run("git", ["remote", "set-url", "origin", remote])
  } else {
    console.log(`· origin 已经是 ${remote}`)
  }
} else {
  run("git", ["remote", "add", "origin", remote])
  console.log(`· 已添加 origin = ${remote}`)
}

const head = run("git", ["log", "--oneline", "-1"])
console.log(`· 即将推送 ${branch}：${head}`)

console.log("\n正在 push（凭证交给系统的 credential helper）…\n")
try {
  run("git", ["push", "-u", "origin", branch], { inherit: true })
} catch {
  fail(
    "push 失败",
    "常见原因：\n" +
      "  - 远程仓库还没建：先去 https://github.com/new 建一个空仓库（不要勾 README/.gitignore）\n" +
      "  - 没有凭证：装 Git Credential Manager，或用 https://<TOKEN>@github.com/OWNER/REPO.git\n" +
      "  - SSH 公钥没加到 GitHub：cat ~/.ssh/id_ed25519.pub 然后贴到 Settings → SSH and GPG keys\n" +
      "  - 远程已有提交：git fetch origin && git rebase origin/" + branch,
  )
}

const slug = remote
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/^git@github\.com:/, "")
  .replace(/^ssh:\/\/git@github\.com\//, "")
  .replace(/\.git$/, "")

console.log("\n✓ 推送完成")
console.log(`  仓库：https://github.com/${slug}`)
console.log("\n别人现在可以这样装：")
console.log(`  magpie plugin add github:${slug}`)
console.log("\n给自己补两个 topic，magpie 的「发现 → 非官方插件」靠它抓仓库：")
console.log(`  gh repo edit ${slug} --add-topic magpie-plugin --add-topic opencode-plugin --add-topic cnb`)
