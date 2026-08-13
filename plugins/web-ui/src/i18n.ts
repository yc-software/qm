import { html as litHtml, type TemplateResult } from "lit";

export type AppLocale = "en" | "zh-CN";

export const LOCALE_KEY = "qm:locale";

const ZH: Record<string, string> = {
  "(default timezone)": "（默认时区）",
  "(no action)": "（无操作）",
  "(no output yet)": "（暂无输出）",
  "(untitled cron)": "（未命名定时任务）",
  "Access revoked ✓": "已撤销访问权限 ✓",
  "Act immediately": "立即执行",
  Active: "使用中",
  All: "全部",
  "All contexts": "所有上下文",
  "All files": "所有文件",
  "All types": "所有类型",
  "Allow always": "始终允许",
  "Allow for session": "本会话允许",
  "Allow once": "允许一次",
  "Already open in a pane": "已在窗格中打开",
  "Another keychain change is still in progress.": "另一项密钥链更改仍在进行中。",
  "Approval needed": "需要审批",
  "Approve or deny to continue": "请批准或拒绝后继续",
  "Archive skill": "归档技能",
  "Archiving…": "正在归档…",
  "Archiving deployment…": "正在归档部署…",
  "Ask anything": "输入任何问题",
  Apps: "应用",
  Archive: "归档",
  Archived: "已归档",
  Auto: "自动",
  "Back to admin": "返回管理端",
  "Back to skills": "返回技能",
  "Background activity": "后台活动",
  "Batch updates": "批量更新",
  Browse: "浏览",
  "Can manage": "可管理",
  "Can view": "可查看",
  Cancel: "取消",
  Channel: "频道",
  "Channels & messages": "频道和消息",
  Chats: "对话",
  Close: "关闭",
  "Close pane": "关闭窗格",
  "Close sidebar": "关闭侧边栏",
  "Clone or push a new version with this short-lived authenticated URL.": "使用此短期有效的认证 URL 克隆或推送新版本。",
  "Clone source with this short-lived read-only authenticated URL.": "使用此短期有效的只读认证 URL 克隆源码。",
  "Color scheme: light / dark / system": "颜色模式：浅色 / 深色 / 跟随系统",
  "Color row": "设置行颜色",
  "Clear color": "清除颜色",
  "Clear row color": "清除行颜色",
  "Connect account": "连接账户",
  Connectors: "连接器",
  Continue: "继续",
  context: "上下文",
  Conversation: "对话",
  "Conversation options": "对话选项",
  Copied: "已复制",
  Contexts: "上下文",
  "Context settings": "上下文设置",
  "Core returned an invalid project": "核心服务返回了无效项目",
  "Could not attach that file.": "无法附加该文件。",
  "Could not create the one-time page.": "无法创建一次性页面。",
  "Could not delete the key.": "无法删除密钥。",
  "Could not disconnect.": "无法断开连接。",
  "Could not revoke access.": "无法撤销访问权限。",
  "Could not start the connector.": "无法启动连接器。",
  "Could not deliver the message — the running task ended mid-send. It is back in the composer.":
    "无法送达消息——正在运行的任务在发送途中结束。消息已返回编辑器。",
  "Could not deliver the message — the running task never settled. It is back in the composer.":
    "无法送达消息——正在运行的任务始终未完成。消息已返回编辑器。",
  "Could not load runtime settings.": "无法加载运行时设置。",
  "Could not send message.": "无法发送消息。",
  "Could not start the conversation.": "无法开始对话。",
  "Custom color (RGB picker)": "自定义颜色（RGB 选择器）",
  "Custom row color": "自定义行颜色",
  "Couldn't change the model — try again.": "无法更改模型——请重试。",
  "Couldn't load this project's model.": "无法加载此项目的模型。",
  "Couldn't create that project.": "无法创建该项目。",
  "Couldn't load this conversation. Check your connection and click it again.":
    "无法加载此对话。请检查网络连接后重新点击。",
  "Couldn't save — try again.": "无法保存——请重试。",
  "Create project": "创建项目",
  "Cron updated.": "定时任务已更新。",
  "Copy link": "复制链接",
  "Create skill": "创建技能",
  "Creating…": "正在创建…",
  "Created here": "在此创建",
  Created: "已创建",
  Current: "当前",
  Crons: "定时任务",
  "Default model for this project": "此项目的默认模型",
  "Delete this cron? This can't be undone.": "删除此定时任务？此操作无法撤销。",
  "Delete this skill? This can't be undone.": "删除此技能？此操作无法撤销。",
  "Delete credential": "删除凭据",
  Delete: "删除",
  Deployments: "部署",
  "Deploy with Agent": "使用智能体部署",
  "Deployment time unavailable": "无法获取部署时间",
  "Direct message": "私信",
  Disable: "禁用",
  Documents: "文档",
  "Discard and refresh": "放弃并刷新",
  "Discard unsaved memory changes?": "放弃未保存的记忆更改？",
  "Disconnect account": "断开账户连接",
  "Display name": "显示名称",
  "Drag to resize · double-click to reset": "拖动调整大小 · 双击重置",
  "Drop files": "拖入文件",
  "Drop files here or choose files": "将文件拖到此处或选择文件",
  "Batch into one message": "合并为一条消息",
  "Enter a project name.": "请输入项目名称。",
  "Enter at least two characters.": "请至少输入两个字符。",
  "Edit notebook": "编辑笔记本",
  "Encrypted at rest": "已加密存储",
  Enable: "启用",
  Enter: "确定",
  Effort: "思考强度",
  "Facts view": "事实视图",
  Fast: "快速",
  "Fast mode": "快速模式",
  "Fast mode active": "快速模式已启用",
  "Fast mode is only available on Opus models": "快速模式仅适用于 Opus 模型",
  Files: "文件",
  "Files & folders": "文件和文件夹",
  "Attach files": "添加附件",
  "Following the org default — it changes when the org's does.": "跟随组织默认值——组织设置更改时会同步更改。",
  "Filter skills by scope": "按范围筛选技能",
  "Filter skills by source": "按来源筛选技能",
  "Finished step": "已完成步骤",
  "Focus this pane over the grid": "聚焦此窗格",
  Group: "群组",
  Harness: "调度器",
  High: "高",
  Ignore: "忽略",
  Images: "图片",
  "Gmail, Calendar, Drive, Sheets": "Gmail、日历、云端硬盘、表格",
  "Google Workspace": "Google Workspace",
  "Group DM": "群组私信",
  "Hi — I'm your AI teammate 👋": "你好——我是你的 AI 队友 👋",
  "Instructions unavailable.": "指令不可用。",
  "Just you — your web chats and DMs with the agent live here.": "仅你可见——你与智能体的 Web 对话和私信保存在此。",
  "Hide background activity": "隐藏后台活动",
  "Hide disabled": "隐藏已禁用项",
  Hide: "隐藏",
  "Hide non-web conversations": "隐藏非 Web 对话",
  "Hide output": "隐藏输出",
  "Hide sidebar": "隐藏侧边栏",
  "Interrupted — resuming…": "已中断——正在恢复…",
  "Issues & projects": "问题和项目",
  Keychain: "密钥链",
  "Load more": "加载更多",
  "Loading apps…": "正在加载应用…",
  "Loading conversations…": "正在加载对话…",
  "Loading conversations...": "正在加载对话…",
  "Loading crons…": "正在加载定时任务…",
  "Loading earlier messages…": "正在加载更早的消息…",
  "Loading files…": "正在加载文件…",
  "Failed to load all matching files.": "无法加载所有匹配的文件。",
  "Failed to load background activity.": "无法加载后台活动。",
  "Failed to load connectors.": "无法加载连接器。",
  "Failed to load files.": "无法加载文件。",
  "Failed to load more files.": "无法加载更多文件。",
  "Failed to load stored keys.": "无法加载已存储的密钥。",
  "Loading instructions…": "正在加载指令…",
  "Loading output…": "正在加载输出…",
  "Loading projects…": "正在加载项目…",
  "Loading runtime…": "正在加载运行时…",
  "Loading skill instructions…": "正在加载技能指令…",
  "Loading skills…": "正在加载技能…",
  "Loading your keychain…": "正在加载密钥链…",
  "It will immediately revoke": "将立即撤销",
  "It will also stop": "还将停止",
  "Managed process": "已管理进程",
  "Managing process": "正在管理进程",
  Memory: "记忆",
  "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version.":
    "记忆已在另一个对话中发生变化。你的草稿仍保留在此；如有需要请先复制，然后刷新以合并最新版本。",
  Low: "低",
  Max: "最高",
  Medium: "中",
  Message: "消息",
  Model: "模型",
  Name: "名称",
  "Needs your approval": "需要你批准",
  Never: "从未",
  "Never fired": "从未触发",
  "New chat": "新建对话",
  "New cron": "新建定时任务",
  "New session": "新建会话",
  "New skill": "新建技能",
  "No audited use yet": "暂无已审计使用记录",
  "No active crons.": "暂无启用的定时任务。",
  "No authorization URL was returned.": "未返回授权 URL。",
  "Service and purpose are required.": "服务名称和用途为必填项。",
  "No apps in this context.": "此上下文中暂无应用。",
  "No apps match your search.": "没有匹配搜索条件的应用。",
  "No apps of your own yet.": "你还没有自己的应用。",
  "No apps shared with you.": "暂无共享给你的应用。",
  "No conversations match.": "没有匹配的对话。",
  "No conversations yet — start a new chat.": "暂无对话——请开始新对话。",
  "No conversations yet.": "暂无对话。",
  "No crons in this context.": "此上下文中暂无定时任务。",
  "No crons shared with you.": "暂无共享给你的定时任务。",
  "No crons yet.": "暂无定时任务。",
  "No files match these filters.": "没有匹配筛选条件的文件。",
  "No files yet. Upload one here or ask the agent to create one.": "暂无文件。可在此上传，或让智能体创建。",
  "No projects match your search.": "没有匹配搜索条件的项目。",
  "No projects yet.": "暂无项目。",
  "No remembered facts match this search.": "没有匹配搜索条件的记忆事实。",
  "No skills available yet.": "暂无可用技能。",
  "No recorded access": "暂无访问记录",
  "None required": "无需操作",
  Newest: "最新",
  Older: "较旧",
  Oldest: "最旧",
  "Open full screen": "全屏打开",
  "Open here": "在此打开",
  "Open in Slack": "在 Slack 中打开",
  Organization: "组织",
  Other: "其他",
  Ownership: "所有权",
  "Pages & databases": "页面和数据库",
  "Personal — only you": "个人——仅你可见",
  Personal: "个人",
  Pin: "置顶",
  Pinned: "已置顶",
  Project: "项目",
  Projects: "项目",
  Published: "已发布",
  Publishing: "正在发布",
  "Pick a conversation, or start a new chat.": "选择一个对话，或开始新对话。",
  "Posts & profile": "帖子和个人资料",
  "Previous 30 days": "过去 30 天",
  "Previous 7 days": "过去 7 天",
  "Preparing…": "正在准备…",
  "Project settings": "项目设置",
  "Project options": "项目选项",
  "Pinned for this project. Anyone in a chat can still pick a different model for that conversation.":
    "已为此项目固定。对话中的任何人仍可为该对话选择其他模型。",
  "Publish change": "发布更改",
  "Publish skill": "发布技能",
  "Ran command": "已运行命令",
  "Read file": "已读取文件",
  "Reading file": "正在读取文件",
  "Refresh title": "刷新标题",
  "Refreshing title": "正在刷新标题",
  Rename: "重命名",
  "Rename conversation": "重命名对话",
  "Rename project": "重命名项目",
  "Repos, issues & PRs": "仓库、问题和 PR",
  Reconnect: "重新连接",
  "Resize sidebar": "调整侧边栏大小",
  "Restore revision": "恢复修订版",
  "Restore to grid (Esc)": "恢复网格视图 (Esc)",
  "Restoring deployment…": "正在恢复部署…",
  "Revision restored ✓": "已恢复修订版 ✓",
  "Revision restored ✓ History could not refresh.": "已恢复修订版 ✓，但历史记录未能刷新。",
  "Run started. Refresh recent runs after it completes.": "运行已开始。完成后请刷新最近运行记录。",
  "Revoke access": "撤销访问权限",
  "Revoke access for": "撤销以下范围的访问权限：",
  Restore: "恢复",
  "Running command": "正在运行命令",
  "Save changes": "保存更改",
  "Saving…": "正在保存…",
  Save: "保存",
  "Saved ✓": "已保存 ✓",
  "Saved ✓ History could not refresh.": "已保存 ✓，但历史记录未能刷新。",
  "Scope variant": "范围变体",
  "Search apps": "搜索应用",
  "Search chats…": "搜索对话…",
  "Search crons": "搜索定时任务",
  "Search skills…": "搜索技能…",
  "Describe the cron you want.": "请描述你想创建的定时任务。",
  Send: "发送",
  Sessions: "会话",
  "Searched history": "已搜索历史记录",
  "Searched memory": "已搜索记忆",
  "Searching history": "正在搜索历史记录",
  "Searching memory": "正在搜索记忆",
  "Thinking…": "正在思考…",
  "Shared channel": "共享频道",
  "Shared context": "共享上下文",
  Shared: "已共享",
  "Shared personal space": "共享个人空间",
  "Show disabled": "显示已禁用项",
  Show: "显示",
  "Show earlier messages": "显示更早的消息",
  "Show less": "收起",
  "Show live output": "显示实时输出",
  "Show more": "显示更多",
  "Show sidebar": "显示侧边栏",
  "Showing web chats only": "仅显示 Web 对话",
  "Sign-in failed.": "登录失败。",
  "Sign out": "退出登录",
  "Signing in…": "正在登录…",
  Skills: "技能",
  "Sort apps": "应用排序",
  Sort: "排序",
  "Split down": "向下拆分",
  "Split left": "向左拆分",
  "Split right": "向右拆分",
  "Split this pane with a new session": "拆分此窗格并新建会话",
  "Split up": "向上拆分",
  "Start the chat first, then open it full screen": "请先开始对话，再全屏打开",
  "Steer the running task": "调整正在运行的任务",
  "Steer the running task (attachments stay for your next message)": "调整正在运行的任务（附件保留至下条消息）",
  "Steer the running task…": "调整正在运行的任务…",
  standing: "长期",
  This: "此项",
  "Still syncing this conversation — try again in a moment": "正在同步此对话——请稍后重试",
  "That conversation wasn't found, or you don't have access to it.": "未找到该对话，或你无权访问。",
  "That cron wasn't found, or you don't have access to it.": "未找到该定时任务，或你无权访问。",
  "The agent hasn’t noted any facts yet.": "智能体尚未记录任何事实。",
  "This conversation is read-only here.": "此对话在这里为只读状态。",
  "This conversation lives in Slack. Replies happen there.": "此对话位于 Slack 中，请在那里回复。",
  "This chat runs in the": "此对话运行于",
  "context — the agent works with that context's files and memory, separate from your personal context.":
    "上下文中——智能体使用该上下文的文件和记忆，并与个人上下文隔离。",
  "This app is shared with a context you can access. You can open and clone it, but not change it.":
    "此应用已共享到你可访问的上下文。你可以打开和克隆，但不能修改。",
  "Read-only": "只读",
  "Timed out waiting for the agent to respond.": "等待智能体响应超时。",
  "Title and task are required.": "标题和任务为必填项。",
  "Title is required.": "标题为必填项。",
  "Switch to Chinese": "切换到中文",
  "Switch to English": "切换到英文",
  "Treat like a person": "像对待真人一样",
  Unavailable: "不可用",
  Task: "任务",
  Thinking: "正在思考",
  Today: "今天",
  Type: "类型",
  "Tried command": "已尝试命令",
  "Tried managing process": "已尝试管理进程",
  "Tried publishing": "已尝试发布",
  "Tried reading file": "已尝试读取文件",
  "Tried searching history": "已尝试搜索历史记录",
  "Tried searching memory": "已尝试搜索记忆",
  "Tried step": "已尝试步骤",
  "Tried using memory": "已尝试使用记忆",
  "Tried writing file": "已尝试写入文件",
  "URL slug": "URL 标识",
  "Unknown owner": "未知所有者",
  Unknown: "未知",
  Unarchive: "取消归档",
  Unpin: "取消置顶",
  "Unsaved changes": "有未保存的更改",
  "Used memory": "已使用记忆",
  "Using URL slug": "正在使用 URL 标识",
  "Using memory": "正在使用记忆",
  Uploaded: "已上传",
  "a group DM": "群组私信",
  "a personal DM": "个人私信",
  "a Slack channel": "Slack 频道",
  "a team": "团队",
  "Version unknown": "版本未知",
  "Upload failed.": "上传失败。",
  "Slack conversations hidden.": "Slack 对话已隐藏。",
  "Revision history": "修订历史",
  "Revision history is unavailable for this memory store.": "此记忆存储无法提供修订历史。",
  Revoke: "撤销",
  Disconnect: "断开连接",
  "Add credential": "添加凭据",
  "Connected accounts": "已连接账户",
  "Stored credentials": "已存储凭据",
  "Active grants": "有效授权",
  "Need attention": "需要处理",
  "Linked accounts": "已连接账户",
  enabled: "已启用",
  disabled: "已禁用",
  archived: "已归档",
  "Web chat": "Web 对话",
  "Web only": "仅 Web",
  "Work continuing on the agent's computer — click to inspect": "智能体正在电脑上继续工作——点击查看",
  Waiting: "等待中",
  Working: "工作中",
  "Writing file": "正在写入文件",
  "Wrote file": "已写入文件",
  "Your personal context": "你的个人上下文",
  "You no longer have access to the original conversation.": "你已无权访问原对话。",
  "You own this app or have permission to manage it.": "你拥有此应用，或具备管理权限。",
  "Your one-time page is ready.": "你的一次性页面已准备完成。",
  "Automations using it may stop working. The credential cannot be recovered.":
    "使用此凭据的自动化可能停止工作。该凭据无法恢复。",
  "access ends immediately. Automations using it may stop working.": "访问权限将立即终止。使用它的自动化可能停止工作。",
  "for this account.": "针对该账户。",
  "Automations using this account may stop working.": "使用该账户的自动化可能停止工作。",
  Yesterday: "昨天",
  You: "你",
  Yours: "我的",
  "agent is working": "智能体正在工作",
  "approval denied": "审批已拒绝",
  "automatic capture": "自动捕获",
  "first run": "首次运行",
  "just now": "刚刚",
  "never fired": "从未触发",
  "no live URL for this app": "此应用没有可用的实时 URL",
  "only you": "仅你",
  pinned: "已置顶",
  "read-only": "只读",
  "run failed": "运行失败",
  "the whole org": "整个组织",
  "this context": "此上下文",
  "this project": "此项目",
  "waiting for your reply": "等待你的回复",
  "your account": "你的账户",
  Added: "添加于",
  changed: "已更改",
  "created by": "创建者",
  Deployed: "已部署",
  Deploying: "部署中",
  Description: "描述",
  Disabled: "已禁用",
  due: "到期",
  Enabled: "已启用",
  "Everyone in this context can invoke and edit these instructions.": "此上下文中的所有人都可以调用和编辑这些指令。",
  "Everyone in this context can invoke the updated instructions.": "此上下文中的所有人都可以调用更新后的指令。",
  exit: "退出码",
  Expires: "到期时间",
  "Filter by:": "筛选：",
  first: "首次",
  "Forked from": "分支自",
  group: "群组",
  hide: "隐藏",
  In: "位于",
  in: "位于",
  instructions: "指令",
  last: "上次",
  "Last used": "上次使用",
  live: "在线",
  "Loading…": "正在加载…",
  manage: "管理",
  next: "下次",
  "None of your own crons yet.": "你还没有自己的定时任务。",
  "Nothing archived.": "暂无归档内容。",
  "one-time": "一次性",
  org: "组织",
  "org-wide": "组织范围",
  owned: "拥有",
  Pack: "技能包",
  pending: "待发布",
  private: "私有",
  Publish: "发布",
  "Publish this change to": "将此更改发布到",
  read: "只读",
  run: "运行",
  Running: "运行中",
  shared: "共享",
  "Shared with everyone in this channel.": "与此频道中的所有人共享。",
  "Shared with everyone in this group conversation.": "与此群组对话中的所有人共享。",
  show: "显示",
  source: "来源",
  stopped: "已停止",
  Stopped: "已停止",
  Team: "团队",
  "The channel description in Slack names this model.": "Slack 中的频道描述会注明此模型。",
  "This edit link is missing a valid app name.": "此编辑链接缺少有效的应用名称。",
  "timed out": "已超时",
  to: "到",
  "To change the message, schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.":
    "要更改消息、计划、时区、目标或运行模式，请使用智能体，以便验证最终行为和权限。",
  "To change the schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.":
    "要更改计划、时区、目标或运行模式，请使用智能体，以便验证最终行为和权限。",
  unchanged: "未更改",
  "Working…": "处理中…",
  "any new output": "任何新输出",
  armed: "已就绪",
  "connected.": "已连接。",
  "connection failed.": "连接失败。",
  exited: "已退出",
  expiring: "即将到期",
  for: "持续",
  "interrupted — resuming…": "已中断——正在恢复…",
  "last fired": "上次触发",
  "Nothing running here anymore.": "此处已无运行中的任务。",
  "output matching": "匹配输出",
  Remove: "移除",
  started: "开始于",
  Uploading: "正在上传",
  "Uploading…": "正在上传…",
  used: "已使用",
  "Watch — wakes on": "监视——唤醒条件",
};

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return null;
}

export function resolveLocale(stored?: string | null, languages?: readonly string[]): AppLocale {
  const saved = normalizeLocale(stored);
  if (saved) return saved;
  const detected =
    languages ??
    (typeof navigator === "undefined"
      ? []
      : [...(navigator.languages ?? []), navigator.language].filter((value): value is string => Boolean(value)));
  for (const language of detected) {
    const inferred = normalizeLocale(language);
    if (inferred) return inferred;
  }
  return "en";
}

function storedLocale(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

export function currentLocale(): AppLocale {
  return resolveLocale(storedLocale());
}

export function localeCode(locale: AppLocale = currentLocale()): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function translatePattern(source: string): string | null {
  let match = source.match(/^(\d+)m ago$/);
  if (match) return `${match[1]} 分钟前`;
  match = source.match(/^(\d+)h ago$/);
  if (match) return `${match[1]} 小时前`;
  match = source.match(/^(\d+)d ago$/);
  if (match) return `${match[1]} 天前`;
  match = source.match(/^(\d+) conversations?$/);
  if (match) return `${match[1]} 个对话`;
  match = source.match(/^(\d+) files?$/);
  if (match) return `${match[1]} 个文件`;
  match = source.match(/^Uploading (\d+) files?…$/);
  if (match) return `正在上传 ${match[1]} 个文件…`;
  match = source.match(/^Uploaded (\d+) files?\.$/);
  if (match) return `已上传 ${match[1]} 个文件。`;
  match = source.match(/^Uploaded (\d+) of (\d+)\. (.+)$/);
  if (match) return `已上传 ${match[1]} / ${match[2]}。${match[3]}`;
  match = source.match(/^(\d+) results?$/);
  if (match) return `${match[1]} 条结果`;
  match = source.match(/^(\d+) saved$/);
  if (match) return `已保存 ${match[1]} 条`;
  match = source.match(/^(\d+) tool calls?$/);
  if (match) return `${match[1]} 次工具调用`;
  match = source.match(/^(\d+) runs?$/);
  if (match) return `${match[1]} 次运行`;
  match = source.match(/^(\d+) members?$/);
  if (match) return `${match[1]} 位成员`;
  match = source.match(/^(\d+) messages?$/);
  if (match) return `${match[1]} 条消息`;
  match = source.match(/^(\d+) assets?$/);
  if (match) return `${match[1]} 个资源`;
  match = source.match(/^(\d+) variants?$/);
  if (match) return `${match[1]} 个变体`;
  match = source.match(/^(\d+) skills? in (\d+) groups?$/);
  if (match) return `${match[1]} 个技能，分为 ${match[2]} 组`;
  match = source.match(/^(\d+) background jobs? running$/);
  if (match) return `${match[1]} 个后台任务正在运行`;
  match = source.match(/^(\d+) watches? armed$/);
  if (match) return `${match[1]} 个监视器已就绪`;
  match = source.match(/^(\d+) tools?$/);
  if (match) return `${match[1]} 个工具`;
  match = source.match(/^(\d+) attempts?$/);
  if (match) return `${match[1]} 次尝试`;
  match = source.match(/^(\d+) active grants?$/);
  if (match) return `${match[1]} 项有效授权`;
  match = source.match(/^(\d+) active credential grants?$/);
  if (match) return `${match[1]} 项有效凭据授权`;
  match = source.match(/^(\d+)m left$/);
  if (match) return `剩余 ${match[1]} 分钟`;
  match = source.match(/^(\d+)h (\d+)m left$/);
  if (match) return `剩余 ${match[1]} 小时 ${match[2]} 分钟`;
  match = source.match(/^Working for (\d+)s$/);
  if (match) return `已工作 ${match[1]} 秒`;
  match = source.match(/^Worked for (\d+)s$/);
  if (match) return `工作了 ${match[1]} 秒`;
  match = source.match(/^Failed after (\d+)s$/);
  if (match) return `${match[1]} 秒后失败`;
  match = source.match(/^Saved — new conversations here run on (.+)\.$/);
  if (match) return `已保存——此处的新对话将使用 ${match[1]}。`;
  match = source.match(/^Remove (.+) from (.+)\?$/);
  if (match) return `从 ${match[2]} 移除 ${match[1]}？`;
  match = source.match(/^every (.+)$/);
  if (match) return `每 ${match[1]}`;
  match = source.match(/^New chat in (.+)$/);
  if (match) return `在 ${match[1]} 中新建对话`;
  match = source.match(/^Options for (.+)$/);
  if (match) return `${match[1]} 的选项`;
  match = source.match(/^Copy link to (.+)$/);
  if (match) return `复制 ${match[1]} 的链接`;
  match = source.match(/^More actions for (.+)$/);
  if (match) return `${match[1]} 的更多操作`;
  match = source.match(/^Handling for (.+)$/);
  if (match) return `${match[1]} 的处理方式`;
  match = source.match(/^Batch interval for (.+) in hours$/);
  if (match) return `${match[1]} 的批处理间隔（小时）`;
  match = source.match(/^Remove (.+) from the ledger$/);
  if (match) return `从记录中移除 ${match[1]}`;
  match = source.match(/^Archive (.+)$/);
  if (match) return `归档 ${match[1]}`;
  match = source.match(/^In (.+)$/);
  if (match) return `位于 ${match[1]}`;
  match = source.match(/^Filter by: (.+)$/);
  if (match) return `筛选：${match[1]}`;
  match = source.match(/^(.+) project$/);
  if (match) return `${match[1]} 项目`;
  match = source.match(/^tomorrow (.+)$/);
  if (match) return `明天 ${match[1]}`;
  match = source.match(/^Next run: (.+)$/);
  if (match) return `下次运行：${match[1]}`;
  match = source.match(/^Last fired: (.+)$/);
  if (match) return `上次触发：${match[1]}`;
  match = source.match(/^First run: (.+)$/);
  if (match) return `首次运行：${match[1]}`;
  match = source.match(/^Revision (.+)$/);
  if (match) return `修订版 ${match[1]}`;
  return null;
}

export function translateText(source: string, locale: AppLocale = currentLocale()): string {
  if (locale === "en") return source;
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const value = source.trim().replace(/\s+/g, " ");
  if (!value) return source;
  const translated = ZH[value] ?? translatePattern(value);
  return translated == null ? source : `${leading}${translated}${trailing}`;
}

export const t = (source: string): string => translateText(source);

const localizedTemplates = new WeakMap<TemplateStringsArray, TemplateStringsArray>();

function localizedMarkup(value: string): string {
  const attributes = value.replace(/\b(title|aria-label|placeholder)=(['"])(.*?)\2/g, (_, name, quote, content) => {
    return `${name}=${quote}${translateText(content, "zh-CN")}${quote}`;
  });
  return attributes.replace(/(^|>)([^<>]+)(?=<|$)/g, (_, opening, content) => {
    return `${opening}${translateText(content, "zh-CN")}`;
  });
}

function localizedTemplate(strings: TemplateStringsArray): TemplateStringsArray {
  if (currentLocale() === "en") return strings;
  const cached = localizedTemplates.get(strings);
  if (cached) return cached;
  const values = strings.map(localizedMarkup);
  const raw = [...values];
  Object.defineProperty(values, "raw", { value: raw });
  const result = values as unknown as TemplateStringsArray;
  localizedTemplates.set(strings, result);
  return result;
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult {
  return litHtml(localizedTemplate(strings), ...values);
}

export function installI18n(root: HTMLElement = document.documentElement): void {
  const locale = currentLocale();
  root.lang = locale;
}

export function setLocale(locale: AppLocale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    void 0;
  }
  document.documentElement.lang = locale;
  location.reload();
}
