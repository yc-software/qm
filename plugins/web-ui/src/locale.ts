export type UiLocale = "en" | "zh-CN";

export const LOCALE_STORAGE_KEY = "qm:locale";

const ZH_CN: Record<string, string> = {
  Language: "语言",
  English: "English",
  "Simplified Chinese": "简体中文",
  Navigation: "导航",
  "Hide sidebar": "隐藏侧栏",
  "Show sidebar": "显示侧栏",
  "Close sidebar": "关闭侧栏",
  "Resize sidebar": "调整侧栏宽度",
  "Drag to resize · double-click to reset": "拖动调整宽度 · 双击恢复默认",
  "Color scheme: light / dark / system": "配色方案：浅色 / 深色 / 跟随系统",
  "Sign out": "退出登录",
  "New chat": "新建聊天",
  Browse: "浏览",
  Projects: "项目",
  Chats: "聊天",
  Files: "文件",
  Crons: "定时任务",
  Webhooks: "Webhook",
  Keychain: "密钥链",
  Apps: "应用",
  Memory: "记忆",
  Skills: "技能",
  Admin: "管理",
  Sessions: "会话",
  "Search your chats": "搜索聊天",
  "Showing web chats only": "仅显示网页聊天",
  "Hide non-web conversations": "隐藏非网页会话",
  "Web only": "仅网页",
  "Pick a conversation, or start a new chat.": "选择一个会话，或新建聊天。",
  "Sign in through the portal": "通过门户登录",
  "This surface is reached through the portal, and signing in there didn't produce a session for it. Open the portal address directly rather than this one.":
    "此界面需要通过门户登录，但门户没有为它建立会话。请直接打开门户地址。",
  "If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.":
    "如果你直接打开了此界面的地址，就会出现这个问题，因为它自身无法完成身份验证。",
  "Your session ended": "会话已结束",
  "You've been signed out. Sign in again and you'll come back to this page.": "你已退出登录。重新登录后将返回此页面。",
  "Sign in": "登录",
  "You don't have access": "你没有访问权限",
  "Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.":
    "你的账户已登录并通过验证，但尚未获准访问此实例。请联系管理员添加权限。",
  "This instance lists its principals in": "此实例在以下配置中列出可访问身份：",
  "We couldn't reach the assistant": "无法连接到助手",
  "The service didn't respond. This is usually temporary.": "服务没有响应，通常只是暂时故障。",
  "Try again": "重试",
  "If this keeps happening, the core service may be down.": "如果持续出现此问题，Core 服务可能已停止。",
  "Dev sign-in": "开发环境登录",
  "No identity provider is configured, so this instance trusts a local cookie. Set":
    "当前未配置身份提供方，因此此实例信任本地 Cookie。请设置",
  "and run the portal to use real sign-in.": "并启动门户以使用正式登录。",
  "Signing in…": "正在登录…",
  Continue: "继续",
  "Sign-in failed.": "登录失败。",
  Principal: "身份",
  "Viewing the assistant as": "正在以以下身份查看助手",
  "Exit impersonation": "退出模拟身份",
  "Dev mode": "开发模式",
  Pinned: "已置顶",
  Archived: "已归档",
  "Loading conversations...": "正在加载会话...",
  "Project options": "项目选项",
  "View project": "查看项目",
  Rename: "重命名",
  "Conversation status": "会话状态",
  Surface: "来源",
  "All surfaces": "全部来源",
  Web: "网页",
  Slack: "Slack",
  "Agent is working": "助手正在工作",
  "Waiting for your reply": "等待你的回复",
  "Read-only": "只读",
  "Copy link": "复制链接",
  Unpin: "取消置顶",
  Pin: "置顶",
  Unarchive: "取消归档",
  Archive: "归档",
  "Conversation options": "会话选项",
  "Row color": "行颜色",
  "Custom color (RGB picker)": "自定义颜色（RGB 选择器）",
  "Custom row color": "自定义行颜色",
  "Clear color": "清除颜色",
  "Clear selection": "清除选择",
  "Color selected": "设置所选颜色",
  "Preparing files...": "正在准备文件...",
  "Loading runtime settings…": "正在加载运行设置…",
  "Keep mine": "保留我的设置",
  "View pasted text": "查看粘贴文本",
  Remove: "移除",
  "Attach files": "添加附件",
  Fast: "快速",
  "Make default": "设为默认",
  "Use org default": "使用组织默认值",
  "Pasted text": "粘贴的文本",
  Close: "关闭",
  "Insert into message": "插入消息",
  Done: "完成",
  Send: "发送",
  Stop: "停止",
  "Queue for after this turn": "加入队列，在本轮后执行",
  "Queued messages": "排队中的消息",
  Queued: "已排队",
  Steer: "调整方向",
  "Remove queued message": "移除排队消息",
  "Command approval": "命令审批",
  Model: "模型",
  Harness: "运行框架",
  Effort: "推理强度",
  "Search models": "搜索模型",
  "Search models…": "搜索模型…",
  "No models found": "未找到模型",
  "Loading skills…": "正在加载技能…",
  Search: "搜索",
  "Add people": "添加成员",
  "Search by name or handle": "按姓名或用户名搜索",
  "Project settings": "项目设置",
  "Context settings": "上下文设置",
  "View all": "查看全部",
  Open: "打开",
  "New project": "新建项目",
  "Close new project": "关闭新建项目窗口",
  Name: "名称",
  Settings: "设置",
  Save: "保存",
  Cancel: "取消",
  Delete: "删除",
  Create: "创建",
  Refresh: "刷新",
  Loading: "正在加载",
  "Loading…": "正在加载…",
  "No results": "没有结果",
  Unavailable: "不可用",
  Copied: "已复制",
  "Copy failed": "复制失败",
  "just now": "刚刚",
  Status: "状态",
  Active: "启用",
  Disabled: "已禁用",
  Enabled: "已启用",
  Optional: "可选",
  Required: "必填",
  Connected: "已连接",
  Disconnected: "未连接",
  "Not configured": "未配置",
  "Save changes": "保存更改",
  "Discard changes": "放弃更改",
  "No files yet": "暂无文件",
  "No sessions yet": "暂无会话",
  "No projects yet": "暂无项目",
  "No skills found": "未找到技能",
  "No apps found": "未找到应用",
  "Upload files": "上传文件",
  Upload: "上传",
  Download: "下载",
  "Run now": "立即运行",
  "Last run": "上次运行",
  "Next run": "下次运行",
  "Created at": "创建时间",
  "Updated at": "更新时间",
  Description: "描述",
};

const SKIP_SELECTOR = [
  "script",
  "style",
  "pre",
  "code",
  "textarea",
  "option",
  "markdown-block",
  "[data-no-localize]",
  ".tool-body",
  ".entry",
  ".raw-json",
  ".pre",
  ".user-name",
  ".scope-chip",
  ".list-row-title",
  ".list-row-meta .badge",
  ".session .tl",
  ".session .row-context",
  ".group-dm-title",
  ".group-dm-names",
  ".recent-project-name",
  ".chat-search-group > b",
  ".chat-search-snippet",
  ".cron-preview",
  ".context-row-title",
  ".project-member-name",
  ".context-panel-title",
  ".context-session-title",
  ".context-resource-desc",
  ".chat-title",
  ".miniapp-card-title",
  ".queued-text",
  ".slash-name",
  ".slash-desc",
  ".skill-variant-description",
  ".ambient-bot-name",
  ".split-pane-title-text",
  ".session-title",
  ".file-chip",
  ".file-image",
].join(", ");
const ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;

let activeLocale: UiLocale = readLocale();
let observer: MutationObserver | null = null;

export function readLocale(storage: Pick<Storage, "getItem"> | null = safeStorage()): UiLocale {
  try {
    const stored = storage?.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    void 0;
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function currentLocale(): UiLocale {
  return activeLocale;
}

export function setLocale(locale: UiLocale, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  activeLocale = locale;
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    void 0;
  }
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function translateUiText(value: string, locale: UiLocale = activeLocale): string {
  if (locale !== "zh-CN") return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const text = value.trim().replace(/\s+/g, " ");
  const direct = ZH_CN[text];
  if (direct) return `${leading}${direct}${trailing}`;
  const selected = text.match(/^(\d+) conversations selected$/);
  if (selected) return `${leading}已选择 ${selected[1]} 个会话${trailing}`;
  const hide = text.match(/^Hide (.+)$/);
  if (hide) return `${leading}隐藏${ZH_CN[hide[1]!] ?? hide[1]}${trailing}`;
  const show = text.match(/^Show (.+)$/);
  if (show) return `${leading}显示${ZH_CN[show[1]!] ?? show[1]}${trailing}`;
  const signedIn = text.match(/^Signed in as (.+)$/);
  if (signedIn) return `${leading}已登录：${signedIn[1]}${trailing}`;
  return value;
}

export function localizeTree(root: Node): void {
  if (activeLocale !== "zh-CN" || typeof document === "undefined") return;
  localizeNode(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    localizeNode(node);
    node = walker.nextNode();
  }
}

export function startLocalization(root: Node = document.documentElement): void {
  document.documentElement.lang = activeLocale;
  localizeTree(root);
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") localizeNode(mutation.target);
      else mutation.addedNodes.forEach(localizeTree);
      if (mutation.type === "attributes") localizeNode(mutation.target);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_STORAGE_KEY && (event.newValue === "en" || event.newValue === "zh-CN")) {
      location.reload();
    }
  });
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function localizeNode(node: Node): void {
  let parent: Element | null = null;
  if (node.nodeType === Node.TEXT_NODE) parent = node.parentElement;
  else if (node instanceof Element) parent = node;
  if (parent?.closest(SKIP_SELECTOR)) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const translated = translateUiText(node.nodeValue ?? "");
    if (translated !== node.nodeValue) node.nodeValue = translated;
    return;
  }
  if (!(node instanceof Element)) return;
  for (const attribute of ATTRIBUTES) {
    const value = node.getAttribute(attribute);
    if (!value) continue;
    const translated = translateUiText(value);
    if (translated !== value) node.setAttribute(attribute, translated);
  }
}
