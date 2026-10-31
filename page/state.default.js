/* 默认快照（入库，作为页面首次打开时的兜底）。
 *
 * 真正的数据由插件宿主写出到 state.js —— 那个文件是运行时产物，不进仓库。
 * 宿主写出的时机：magpie 读额度（auth.usage）、列模型（provider.models）、
 * 或调用任一 cnb_* 工具。
 *
 * 页面本身没有网络权限（magpie 沙箱的 CSP 是 connect-src 'none'），
 * 所以插件的账务数据只能从这两个 js 文件里拿。
 */
window.__CNB_STATE__ = {
  generatedAt: "",
  plugin: { name: "opencode-cnb-account", version: "0.2.1", provider: "cnb" },
  transport: "auto",
  account: {
    username: "",
    nickname: "",
    email: "",
    avatar: "",
    id: "",
    verified: null,
    verifiedExpireIn: "",
    badges: [],
    hasGenius: false,
    hasEdu: false,
    hasTdp: false
  },
  scope: { org: "", repo: "", groups: [], repos: [] },
  credit: {
    total: null,
    free: null,
    used: null,
    frozen: null,
    privilege: null,
    special: null,
    specialDesc: "",
    specialExpire: "",
    percent: null,
    unit: "credits",
    resetsAt: ""
  },
  sideQuotas: [],
  entrances: [
    { id: "edu", title: "高校认证（高校师生）", desc: "高校学生 / 老师 / 校友 / 职工 / 合作企业 / 开放实验室", earned: false, label: "", url: "https://cnb.cool/user/ext_identity", urlLabel: "去认证 / 查看", reward: "认证后解锁高校师生专属额度档位" },
    { id: "genius", title: "天才程序员", desc: "CNB 天才计划徽章，与高校身份可叠加为「天才学生 / 天才老师」", earned: false, label: "", url: "https://cnb.cool/user/ext_identity", urlLabel: "去申请 / 查看", reward: "天才计划专属特权额度" },
    { id: "tdp", title: "TDP 会员", desc: "TDP 主标签，显示在徽章行", earned: false, label: "", url: "https://cnb.cool/user/ext_identity", urlLabel: "去开通 / 查看", reward: "TDP 会员特权额度" },
    { id: "realname", title: "实名认证", desc: "微信扫码 + 手机号实名，未实名的账号额度会被回收", earned: null, label: "", url: "https://cnb.cool/user/identity", urlLabel: "去实名", reward: "全部免费额度的前置条件" },
    { id: "privilege", title: "认证特权积分", desc: "各认证叠加后生效的特权额度，含 Credit / 核时 / 存储", earned: null, label: "", url: "https://cnb.cool/user/charge/ext_identity/privilege", urlLabel: "查看特权额度", reward: "按认证项累加" },
    { id: "quota", title: "额度总览", desc: "当月 Credit、云原生开发核时、云原生构建核时、存储", earned: null, label: "", url: "https://cnb.cool/user/quota", urlLabel: "打开额度页", reward: "免费 500 / 月，完成 hello-cnb 挑战后 1166 / 月" }
  ],
  routes: {
    identity: "https://cnb.cool/user/identity",
    extIdentity: "https://cnb.cool/user/ext_identity",
    extIdentityPrivilege: "https://cnb.cool/user/charge/ext_identity/privilege",
    quota: "https://cnb.cool/user/quota",
    newRepo: "https://cnb.cool/new/repos",
    newGroup: "https://cnb.cool/new/groups",
    newMission: "https://cnb.cool/new/missions",
    profile: "https://cnb.cool/profile",
    token: "https://cnb.cool/profile/token"
  },
  realnameVerified: false,
  signIn: "",
  hints: [],
  error: ""
};
