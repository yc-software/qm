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

Object.assign(ZH_CN, {
  "Agent behavior": "助手行为",
  "Ambient behavior": "环境消息行为",
  "Standing orders": "常驻指令",
  "Automated posters": "自动发布者",
  "Choose what this project should notice and act on.": "选择此项目中助手应关注并采取行动的事项。",
  "Plain-language guidance for proactive work. Leave empty to respond only when addressed.":
    "用自然语言说明需要主动处理的事项。留空时仅在被明确提及时响应。",
  "Control how messages from bots and integrations wake the agent.": "控制机器人和集成消息如何唤醒助手。",
  "When off, the agent never acts on overheard messages here — it only responds to direct @mentions. Default: on only when standing orders (or an action-mode bot) are set below — otherwise mention-only.":
    "关闭后，助手不会处理此处旁听到的消息，只响应直接 @提及。默认仅在下方设置常驻指令（或行动模式机器人）时启用，否则仅响应提及。",
  "Act immediately": "立即行动",
  "Batch updates": "批量处理更新",
  "Treat like a person": "视同真人",
  Ignore: "忽略",
  "Add bot": "添加机器人",
  "Bot name": "机器人名称",
  "No bots added. All bot posts are treated as activity.": "尚未添加机器人。所有机器人消息均按普通活动处理。",
  "Default (on when standing orders are set)": "默认（设置常驻指令时启用）",
  "For example: Flag anything that could delay the launch.": "例如：标记任何可能延误上线的事项。",
  "Couldn't load this scope's standing orders.": "无法加载当前范围的常驻指令。",
  "Couldn't save — try again.": "保存失败，请重试。",
  "Saved.": "已保存。",
  "Saving…": "正在保存…",
  "Pinned header": "置顶标题",
  "Pinned Slack header for this channel": "此频道的 Slack 置顶标题",
  "A small pinned message in the Slack channel naming the model in use.":
    "在 Slack 频道中置顶一条简短消息，注明当前使用的模型。",
  "Turning it on posts and pins the header; turning it off unpins and removes it. Default follows the org-wide setting. Model changes edit the pinned message in place.":
    "启用后会发布并置顶标题；关闭后取消置顶并删除。默认跟随组织设置，模型变化时会直接更新置顶消息。",
  "Couldn't load the pinned header setting.": "无法加载置顶标题设置。",
  "Couldn't update the pinned header setting.": "无法更新置顶标题设置。",
  "Header pinned in the channel.": "标题已在频道中置顶。",
  "Pinned header removed.": "置顶标题已移除。",
  "The model every conversation here starts on.": "此项目中每个新会话使用的初始模型。",
  "Default model for this project": "此项目的默认模型",
  "Default effort": "默认推理强度",
  "Default effort level for this project": "此项目的默认推理强度",
  "Following the org default — it changes when the org's does.": "跟随组织默认值，组织设置变化时会同步更新。",
  "Pinned for this project. Anyone in a chat can still pick a different model for that conversation.":
    "已固定用于此项目。会话中的任何人仍可为该会话选择其他模型。",
  "The pinned Slack header (when enabled below) names this model.": "下方启用的 Slack 置顶标题会显示此模型。",
  "Couldn't change the model — try again.": "无法更改模型，请重试。",
  "Couldn't load this project's model.": "无法加载此项目的模型。",
  "All contexts": "全部上下文",
  "Active only": "仅启用项",
  "Filter by context": "按上下文筛选",
  "Filter by:": "筛选条件：",
  Everything: "全部",
  Personal: "个人",
  Channel: "频道",
  "Group DM": "群聊私信",
  "Shared personal space": "共享个人空间",
  "Just you — your web chats and DMs with the agent live here.": "仅你可见，你的网页会话和与助手的私信位于此处。",
  "Shared with everyone in this channel.": "与此频道中的所有人共享。",
  "Shared with everyone in this group conversation.": "与此群聊中的所有人共享。",
  "Read-only — replies happen on the original surface": "只读，回复需在原始平台进行",
  "Loading projects…": "正在加载项目…",
  "Loading this context's files, webhooks, crons, apps and skills…":
    "正在加载此上下文的文件、Webhook、定时任务、应用和技能…",
  "Failed to load contexts.": "上下文加载失败。",
  "Failed to load this context's resources.": "此上下文的资源加载失败。",
  "No projects match your search.": "没有匹配搜索条件的项目。",
  "Start a conversation with New chat. Files, automations, and other work created there will stay scoped to this project.":
    "点击“新建聊天”开始会话。在其中创建的文件、自动化及其他工作都会保留在此项目范围内。",
  "This project is ready for work": "此项目已可开始工作",
  "Create project": "创建项目",
  "Creating…": "正在创建…",
  "Enter a project name.": "请输入项目名称。",
  "Core returned an invalid project": "Core 返回了无效项目",
  "Couldn't create that project.": "无法创建该项目。",
  People: "成员",
  Owner: "所有者",
  "Add people": "添加成员",
  "Enter at least two characters.": "请至少输入两个字符。",
  "Everyone matching is already in this project.": "所有匹配成员均已加入此项目。",
  "Couldn't search for people.": "无法搜索成员。",
  "Couldn't add that person.": "无法添加该成员。",
  "Couldn't remove that person.": "无法移除该成员。",
  "Joined via the linked Slack channel": "通过关联的 Slack 频道加入",
  "Link a channel": "关联频道",
  "Give this project a home channel on Slack — the agent will post updates there, and everyone in the channel joins the project.":
    "为此项目关联一个 Slack 主频道。助手会在那里发布更新，频道中的所有人都会加入项目。",
  "Private channel": "私有频道",
  "Slack channel": "Slack 频道",
  "Slack channel to link": "要关联的 Slack 频道",
  "channel name": "频道名称",
  Link: "关联",
  "Couldn't link that channel — you must be a member of it.": "无法关联该频道，你必须是频道成员。",
  "Couldn't unlink the channel.": "无法取消关联该频道。",
  "No conversations yet.": "尚无会话。",
  "1 conversation": "1 个会话",
  "Approval needed": "需要审批",
  "Needs your approval": "需要你的审批",
  "Authorize access in a new tab": "在新标签页中授权访问",
  "Authorized — its tools work here now": "已授权，现在可在此使用其工具",
  "Background activity": "后台活动",
  "Nothing running here anymore.": "此处已没有正在运行的任务。",
  "Failed to load background activity.": "后台活动加载失败。",
  "Hide background activity": "隐藏后台活动",
  "Work continuing on the agent's computer — click to inspect": "工作正在助手计算机上继续，点击查看",
  "Drop files or folders to attach": "拖放文件或文件夹以添加附件",
  "No readable messages in this conversation.": "此会话中没有可读取的消息。",
  "This conversation is read-only here.": "此会话在此处为只读。",
  "This conversation lives in Slack. Replies happen there.": "此会话位于 Slack，请在那里回复。",
  "Refresh conversations": "刷新会话",
  "Show earlier messages": "显示更早的消息",
  "Loading earlier messages…": "正在加载更早的消息…",
  "Copy message": "复制消息",
  "Fork conversation from here": "从此处派生会话",
  "Expand this pane": "展开此窗格",
  "Show full command": "显示完整命令",
  "Show full output": "显示完整输出",
  "Show live output": "显示实时输出",
  "Hide output": "隐藏输出",
  "Loading output…": "正在加载输出…",
  "Couldn't load the full output.": "无法加载完整输出。",
  "Loading source…": "正在加载源码…",
  "Couldn't load the source.": "无法加载源码。",
  "Open in a new tab": "在新标签页中打开",
  "Open in Slack": "在 Slack 中打开",
  "Playground views": "Playground 视图",
  "Playground hit an error.": "Playground 发生错误。",
  "Starting…": "正在启动…",
  "Triggered by": "触发规则",
  Why: "原因",
  "Denied.": "已拒绝。",
  "Interrupted — resuming…": "已中断，正在恢复…",
  Thinking: "思考中",
  "Thinking…": "思考中…",
  Working: "工作中",
  Worked: "已完成工作",
  "Finished step": "步骤已完成",
  "Running command": "正在运行命令",
  "Ran command": "已运行命令",
  "Tried command": "命令执行未成功",
  "Reading file": "正在读取文件",
  "Read file": "已读取文件",
  "Tried reading file": "文件读取未成功",
  "Writing file": "正在写入文件",
  "Wrote file": "已写入文件",
  "Tried writing file": "文件写入未成功",
  "Searching history": "正在搜索历史",
  "Searched history": "已搜索历史",
  "Tried searching history": "历史搜索未成功",
  "Searching memory": "正在搜索记忆",
  "Searched memory": "已搜索记忆",
  "Tried searching memory": "记忆搜索未成功",
  "Using memory": "正在使用记忆",
  "Used memory": "已使用记忆",
  "Tried using memory": "记忆使用未成功",
  "Managing process": "正在管理进程",
  "Managed process": "已管理进程",
  "Tried managing process": "进程管理未成功",
  Publishing: "正在发布",
  Published: "已发布",
  "Tried publishing": "发布未成功",
  "Could not start the conversation.": "无法开始会话。",
  "Could not follow the queued message.": "无法继续处理排队消息。",
  "Could not fork the conversation.": "无法派生会话。",
  "Could not reconnect to the running task.": "无法重新连接正在运行的任务。",
  "Could not retry the message.": "无法重试该消息。",
  "Could not send the approval.": "无法发送审批结果。",
  "Hi — I'm your AI teammate 👋": "你好，我是你的 AI 队友 👋",
  "I run tasks on a computer of my own and work across your connected tools — Slack, Google Workspace, GitHub, Linear, and the open web — and I remember what we work on together.":
    "我会在自己的计算机上执行任务，并使用你连接的 Slack、Google Workspace、GitHub、Linear 和开放网络等工具；我也会记住我们共同处理的工作。",
  "Want to get set up? Tell me your name and what you're working on, and I'll take it from there — or just ask me anything to dive straight in.":
    "准备开始时，请告诉我你的名字和正在做的事情，我会接着处理；也可以直接提出任何问题。",
  "Ask anything": "输入任何问题",
  "Approve or deny to continue": "批准或拒绝后继续",
  "Queue a message for after this turn…": "排队到本轮结束后发送…",
  "Loading runtime…": "正在加载运行设置…",
  "Fast mode": "快速模式",
  "Fast mode active": "快速模式已启用",
  "Fast mode is only available on Opus models": "快速模式仅适用于 Opus 模型",
  "Use this harness, model, effort, and fast setting as the default for this scope":
    "将此运行框架、模型、推理强度和快速模式设为当前范围的默认值",
  "Inherit future defaults": "继承后续默认设置",
  "The org now recommends": "组织现在推荐",
  Upgrade: "升级",
  "Allow once": "允许一次",
  "Allow for session": "本会话允许",
  "Allow always": "始终允许",
  "Could not load runtime settings.": "无法加载运行设置。",
  "Could not update the scope default.": "无法更新当前范围的默认设置。",
  "Could not queue the message.": "无法将消息加入队列。",
  "Could not remove the queued message.": "无法移除排队消息。",
  "Could not steer with that message.": "无法使用该消息调整任务方向。",
  "Could not steer the running task.": "无法调整正在运行任务的方向。",
  "Could not send message.": "无法发送消息。",
  "Could not attach that file.": "无法添加该文件。",
  "Still preparing the previous drop — try again in a moment.": "仍在处理上一次拖放，请稍后重试。",
  "That drop included a folder this browser can't read — zip it and drop the archive instead.":
    "拖放内容包含浏览器无法读取的文件夹，请压缩为 ZIP 后再拖放。",
  "That turn already finished — this message will run as its own turn.": "该轮已结束，此消息将作为新一轮运行。",
  "That message already started — it's the running turn now.": "该消息已开始处理，现在就是正在运行的一轮。",
  "That message was already removed in another tab.": "该消息已在另一个标签页中移除。",
  "Nothing running can take this — it will go out as its own turn":
    "当前没有运行中的任务可接收此消息，它将作为新一轮发送",
  "Could not deliver the message — the running task ended mid-send. It is back in the composer.":
    "消息发送过程中任务已结束，无法投递；消息已返回编辑框。",
});

Object.assign(ZH_CN, {
  "Search every chat you can see — messages, not just titles.": "搜索你可见的全部聊天，包括消息内容而不只是标题。",
  "Ask QM to find it:": "让 QM 查找：",
  "ask QM in a new chat": "在新聊天中让 QM 查找",
  "open chat": "打开聊天",
  "Search failed — check the connection and try again.": "搜索失败，请检查连接后重试。",
  "Untitled chat": "未命名聊天",
  "No conversations match.": "没有匹配的会话。",
  "No conversations yet — start a new chat.": "尚无会话，请新建聊天。",
  "Slack conversations hidden.": "已隐藏 Slack 会话。",
  "Search chats…": "搜索聊天…",
  "Web chat": "网页聊天",
  "Direct message": "私信",
  Project: "项目",
  "Press Space to select": "按空格键选择",
  "Refresh title": "刷新标题",
  "Refreshing title": "正在刷新标题",
  "Rename conversation": "重命名会话",
  "Rename project": "重命名项目",
  "Pin selected": "置顶所选会话",
  "Unpin selected": "取消置顶所选会话",
  "Archive selected": "归档所选会话",
  "Unarchive selected": "取消归档所选会话",
  "Pin selected conversations": "置顶所选会话",
  "Unpin selected conversations": "取消置顶所选会话",
  "Archive selected conversations": "归档所选会话",
  "Unarchive selected conversations": "取消归档所选会话",
  "Clear color on selected conversations": "清除所选会话的颜色",
  "Color selected conversations": "设置所选会话颜色",
  "Clear selection (Esc)": "清除选择（Esc）",
  "Couldn't load this conversation. Check your connection and click it again.":
    "无法加载此会话，请检查连接后再次点击。",
  "Failed to load conversations.": "会话加载失败。",
  "Already open in a pane": "已在窗格中打开",
  "Open as tab": "作为标签页打开",
  "Open full screen": "全屏打开",
  "Open here": "在此打开",
  "Show here": "在此显示",
  "Restore to grid (Esc)": "恢复网格（Esc）",
  "Split this pane with a new session": "拆分此窗格并新建会话",
  "Split left": "向左拆分",
  "Split right": "向右拆分",
  "Split up": "向上拆分",
  "Split down": "向下拆分",
  "Focus over the grid": "聚焦网格",
  "New session": "新建会话",
  "Archive session": "归档会话",
  "Close pane": "关闭窗格",
  Tools: "工具",
  Conversation: "会话",
  "Your keychain": "你的密钥链",
  "All files": "全部文件",
  "All types": "全部类型",
  Documents: "文档",
  Images: "图片",
  Other: "其他",
  Ownership: "归属",
  Yours: "你的",
  Shared: "共享",
  Newest: "最新",
  Oldest: "最早",
  "Search files": "搜索文件",
  "Search file names and types…": "搜索文件名和类型…",
  "Files created, uploaded, or shared with you": "你创建、上传或与你共享的文件",
  "Drop files": "拖放文件",
  "Drop files here or choose files": "将文件拖放到此处或选择文件",
  "Loading files…": "正在加载文件…",
  "Load more": "加载更多",
  "No files match these filters.": "没有符合筛选条件的文件。",
  "No files yet. Upload one here or ask the agent to create one.": "尚无文件。可在此上传或让助手创建。",
  "Failed to load files.": "文件加载失败。",
  "Failed to load more files.": "更多文件加载失败。",
  "Failed to load all matching files.": "所有匹配文件加载失败。",
  Uploaded: "已上传",
  "Uploading…": "正在上传…",
  Captured: "记录时间",
  "Facts view": "事实视图",
  "Edit notebook": "编辑记忆本",
  "Facts the agent carries into your conversations.": "助手会带入会话的事实记忆。",
  "Edit the notebook directly. Switch to Facts view to search or remove individual facts. Saves are protected if the agent remembers something new while this page is open.":
    "直接编辑记忆本。切换到事实视图可搜索或删除单条事实；页面打开期间若助手新增记忆，保存时会进行冲突保护。",
  "Search remembered facts": "搜索已记住的事实",
  "The agent hasn’t noted any facts yet.": "助手尚未记录任何事实。",
  "No remembered facts match this search.": "没有匹配搜索条件的记忆事实。",
  "Forget this fact": "忘记此事实",
  "Revision history": "修订历史",
  "Revision history is unavailable for this memory store.": "此记忆存储不提供修订历史。",
  "Failed to load memory.": "记忆加载失败。",
  "Failed to load memory history.": "记忆历史加载失败。",
  "Failed to save memory.": "记忆保存失败。",
  "Could not restore that revision.": "无法恢复该修订版本。",
  "Saved ✓": "已保存 ✓",
  "Saved ✓ History could not refresh.": "已保存 ✓，但历史记录刷新失败。",
  "Revision restored ✓": "修订版本已恢复 ✓",
  "Revision restored ✓ History could not refresh.": "修订版本已恢复 ✓，但历史记录刷新失败。",
  "Restore revision": "恢复修订版本",
  "The selected notebook will become current. The version you have now remains available in history.":
    "所选记忆本将成为当前版本，现有版本仍会保留在历史中。",
  "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version.":
    "记忆已在其他会话中发生变化。你的草稿仍在此处；请按需保留后刷新，以合并最新版本。",
  "Discard unsaved memory changes?": "放弃未保存的记忆更改？",
  "Refreshing will replace this draft with the latest memory. Copy anything you want to keep before continuing.":
    "刷新会用最新记忆替换当前草稿，继续前请保留需要的内容。",
  "Discard and refresh": "放弃并刷新",
  "automatic capture": "自动记录",
  "Accounts and credentials your agent may use on your behalf.": "助手可代表你使用的账户和凭据。",
  "Keychain summary": "密钥链摘要",
  "Linked accounts": "已关联账户",
  "Connected accounts": "已连接账户",
  "Stored credentials": "已存凭据",
  "Active grants": "有效授权",
  "Pending requests": "待处理请求",
  "Loading your keychain…": "正在加载密钥链…",
  "Refresh keychain": "刷新密钥链",
  "Refresh failed:": "刷新失败：",
  "No accounts available": "没有可用账户",
  "Your workspace has not configured any account providers yet.": "你的工作区尚未配置账户服务商。",
  "No stored credentials": "没有已存凭据",
  "Add one without pasting a secret into chat.": "无需在聊天中粘贴密钥即可添加。",
  Reconnect: "重新连接",
  "Reconnect needed": "需要重新连接",
  "Not connected": "未连接",
  "Connect account": "连接账户",
  "Disconnect account": "断开账户",
  "Could not start the connector.": "无法启动连接器。",
  "Could not disconnect.": "无法断开连接。",
  "No authorization URL was returned.": "未返回授权 URL。",
  "Provider APIs the agent can use as you.": "助手可代表你使用的服务商 API。",
  "Channels & messages": "频道和消息",
  "Files & folders": "文件和文件夹",
  "Gmail, Calendar, Drive, Sheets": "Gmail、日历、云端硬盘和表格",
  "Issues & projects": "议题和项目",
  "Repos, issues & PRs": "仓库、议题和 PR",
  "Pages & databases": "页面和数据库",
  "Posts & profile": "帖子和个人资料",
  "Add a credential": "添加凭据",
  "New credential": "新建凭据",
  "Add credential": "添加凭据",
  Service: "服务",
  Purpose: "用途",
  "What may the agent use this credential for?": "助手可将此凭据用于什么？",
  "Environment variable": "环境变量",
  "Service and purpose are required.": "服务和用途为必填项。",
  "Describe the credential here, then paste the secret itself on a private one-time page. It goes straight to your encrypted keychain — it is never shown in chat or stored on this page.":
    "先在此说明凭据，再到私密的一次性页面粘贴密钥。密钥会直接进入加密密钥链，不会显示在聊天中，也不会存储在此页面。",
  "Preparing…": "正在准备…",
  "Your one-time page is ready": "一次性页面已就绪",
  "Your one-time page is ready.": "一次性页面已就绪。",
  "Open it in a new tab and paste the secret there.": "请在新标签页中打开并粘贴密钥。",
  "Open the one-time page": "打开一次性页面",
  "No one-time page URL was returned.": "未返回一次性页面 URL。",
  "Could not create the one-time page.": "无法创建一次性页面。",
  "Another keychain change is still in progress.": "另一项密钥链更改仍在进行。",
  "Encrypted at rest": "静态加密",
  "Secrets stay encrypted and every use or shared grant is audited.":
    "密钥始终加密保存，每次使用和共享授权都会被审计。",
  "No audited use yet": "尚无审计使用记录",
  "Active access": "有效访问权限",
  "Need attention": "需要处理",
  Expired: "已过期",
  "Check impact": "检查影响",
  Revoke: "撤销",
  "Revoke access": "撤销访问权限",
  "Access revoked ✓": "访问权限已撤销 ✓",
  "Could not revoke access.": "无法撤销访问权限。",
  "Delete credential": "删除凭据",
  "Could not delete the key.": "无法删除密钥。",
  "Failed to load connectors.": "连接器加载失败。",
  "Failed to load stored keys.": "已存密钥加载失败。",
  "Create a reusable procedure for yourself or a shared context.": "为自己或共享上下文创建可复用流程。",
  "Available to": "适用范围",
  "Personal — only you": "个人，仅你可用",
  "Everyone in a shared context can invoke and edit this skill.": "共享上下文中的所有人都可调用和编辑此技能。",
  "All sources": "全部来源",
  Source: "来源",
  "Created here": "在此创建",
  Overrides: "覆盖项",
  "Skill packs": "技能包",
  Team: "团队",
  "Project / group": "项目 / 群组",
  "Filter by skill status": "按技能状态筛选",
  "Filter skills by scope": "按技能范围筛选",
  "Filter skills by source": "按技能来源筛选",
  "No skills match these filters.": "没有符合筛选条件的技能。",
  "Clear filters": "清除筛选",
  "No skills available yet.": "尚无可用技能。",
  "No skills in this context.": "此上下文中没有技能。",
  "New skill": "新建技能",
  "Create skill": "创建技能",
  "Back to skills": "返回技能列表",
  "One line: what it does / when to use it": "一句话说明功能和适用场景",
  "The SKILL.md contents — the steps to follow when this skill is used.": "SKILL.md 内容，即使用此技能时遵循的步骤。",
  "Name, description, and instructions are all required.": "名称、描述和指令均为必填项。",
  "Scope variant": "范围版本",
  "Narrower scope takes precedence where both apply": "同时适用时，范围更窄的版本优先",
  "None required": "无需额外能力",
  "Instructions unavailable.": "指令不可用。",
  "Loading skill instructions…": "正在加载技能指令…",
  "Loading instructions…": "正在加载指令…",
  "Publish skill": "发布技能",
  "Publish change": "发布更改",
  "Review again": "再次检查",
  "Archive skill": "归档技能",
  "Archiving…": "正在归档…",
  "Failed to load skills.": "技能加载失败。",
  "Failed to load skill details.": "技能详情加载失败。",
  "Failed to create skill.": "技能创建失败。",
  "Failed to save skill.": "技能保存失败。",
  "Failed to archive skill.": "技能归档失败。",
  "Failed to restore skill.": "技能恢复失败。",
});

Object.assign(ZH_CN, {
  "Cron view": "定时任务视图",
  "Cron actions": "定时任务操作",
  "Search crons": "搜索定时任务",
  "Hide disabled": "隐藏已停用项",
  "Show disabled": "显示已停用项",
  "No active crons.": "没有启用的定时任务。",
  "No crons in this context.": "此上下文中没有定时任务。",
  "No crons shared with you.": "没有与你共享的定时任务。",
  "No crons yet.": "尚无定时任务。",
  "None of your own crons yet.": "你尚未创建定时任务。",
  "Nothing archived.": "没有已归档项目。",
  "Loading crons…": "正在加载定时任务…",
  "Failed to load crons.": "定时任务加载失败。",
  "New cron": "新建定时任务",
  "Ask the agent to set it up": "让助手完成设置",
  "Describe the cron you want.": "请描述你需要的定时任务。",
  "Every weekday at 9am, summarize my unread email and DM me the highlights.":
    "每个工作日上午 9 点汇总未读邮件，并通过私信发送重点。",
  "Edit cron": "编辑定时任务",
  "Edit behavior with agent": "使用助手编辑行为",
  "Enable cron": "启用定时任务",
  "Disable cron": "停用定时任务",
  "Unarchive cron": "取消归档定时任务",
  "Archive cron": "归档定时任务",
  "Delete permanently": "永久删除",
  "This permanently removes the schedule and its retained run history. Archive it instead if you may need it later.":
    "此操作会永久删除计划及保留的运行历史。如果以后可能需要，请改为归档。",
  "Recent runs": "最近运行",
  "No runs yet.": "尚无运行记录。",
  "Run started. Refresh recent runs after it completes.": "运行已开始，完成后请刷新最近运行记录。",
  "Couldn't load run history.": "无法加载运行历史。",
  "Cron updated.": "定时任务已更新。",
  "That cron wasn't found, or you don't have access to it.": "未找到该定时任务，或你没有访问权限。",
  "Title and task are required.": "标题和任务为必填项。",
  "Title is required.": "标题为必填项。",
  "Shared from": "共享来源",
  "To change": "如需更改",
  "the message, schedule, timezone, destination, or run mode": "消息、计划、时区、目标或运行模式",
  "the schedule, timezone, destination, or run mode": "计划、时区、目标或运行模式",
  "use the agent so it can validate the resulting behavior and permissions.": "请使用助手，以便验证最终行为和权限。",
  "you can view it, but not change it.": "你可以查看，但不能更改。",
  "App view": "应用视图",
  "App actions": "应用操作",
  "Search apps": "搜索应用",
  "Sort apps": "应用排序",
  "No apps in this context.": "此上下文中没有应用。",
  "No apps match your search.": "没有匹配搜索条件的应用。",
  "Loading apps…": "正在加载应用…",
  "Failed to load apps.": "应用加载失败。",
  "Deploy with Agent": "使用助手部署",
  "Deploy an app for me.": "为我部署一个应用。",
  "Loading authoritative app details…": "正在加载应用的权威详情…",
  "Could not load app details.": "无法加载应用详情。",
  "Open app": "打开应用",
  "Copy app URL": "复制应用 URL",
  "More actions": "更多操作",
  Overview: "概览",
  "Ownership and access": "归属和访问权限",
  "Can manage": "可管理",
  "Can view": "可查看",
  "You own this app or have permission to manage it.": "你拥有此应用或具备管理权限。",
  "This app is shared with a context you can access. You can open and clone it, but not change it.":
    "此应用共享自你可访问的上下文。你可以打开和克隆，但不能更改。",
  "Your personal context": "你的个人上下文",
  "Shared context": "共享上下文",
  "Created by": "创建者",
  "Created in": "创建于",
  "Last deployed": "最近部署",
  "Last opened": "最近打开",
  "No recorded access": "没有访问记录",
  "Latest version": "最新版本",
  "Live version": "线上版本",
  "Version history": "版本历史",
  "No version history available.": "没有可用版本历史。",
  "Deployment time unavailable": "部署时间不可用",
  "Version unknown": "版本未知",
  "Edit display name": "编辑显示名称",
  "The human-friendly name shown here. This does not change the app URL.": "此处显示的易读名称，不会更改应用 URL。",
  "Change URL slug": "更改 URL 标识符",
  "Changes the app URL. Existing links do not redirect.": "这会更改应用 URL，现有链接不会自动重定向。",
  "A URL slug is required.": "URL 标识符为必填项。",
  "Copy Git remote": "复制 Git 远程地址",
  "Clone or push a new version with this short-lived authenticated URL.": "使用此短期认证 URL 克隆或推送新版本。",
  "Clone source with this short-lived read-only authenticated URL.": "使用此短期只读认证 URL 克隆源码。",
  "Edit live": "在线编辑",
  "Could not open live editing.": "无法打开在线编辑。",
  "Could not save app settings.": "无法保存应用设置。",
  "Archive and take offline": "归档并下线",
  "Archive deployment": "归档部署",
  "Restore deployment": "恢复部署",
  "Archiving deployment…": "正在归档部署…",
  "Restoring deployment…": "正在恢复部署…",
  "This takes the app offline immediately, so its current URL will stop working. Its source and version history are kept, and you can restore it later.":
    "此操作会立即下线应用，当前 URL 将停止工作。源码和版本历史会保留，之后可恢复。",
  "Could not archive deployment.": "无法归档部署。",
  "Could not restore deployment.": "无法恢复部署。",
  "Dismiss notification": "关闭通知",
  Dismiss: "关闭",
  Undo: "撤销",
  "no live URL for this app": "此应用没有线上 URL",
  "New webhook": "新建 Webhook",
  "Create webhook": "创建 Webhook",
  "Search webhooks": "搜索 Webhook",
  "Loading webhooks…": "正在加载 Webhook…",
  "Failed to load webhooks.": "Webhook 加载失败。",
  "No webhooks in this context.": "此上下文中没有 Webhook。",
  "No webhooks yet.": "尚无 Webhook。",
  "That webhook wasn't found, or you don't have access to it.": "未找到该 Webhook，或你没有访问权限。",
  Webhook: "Webhook",
  "Inbound URL": "接收 URL",
  Action: "操作",
  Filters: "筛选条件",
  Verification: "验证方式",
  "Verification scheme": "验证方案",
  "Signing secret": "签名密钥",
  "Last delivery ID": "最近投递 ID",
  "Last error": "最近错误",
  "Generic HMAC-SHA256": "通用 HMAC-SHA256",
  "Point your sender at this URL.": "请将发送方指向此 URL。",
  "Configure your sender (GitHub / Stripe / Slack / …) to POST events here.":
    "配置发送方（GitHub、Stripe、Slack 等）向此处 POST 事件。",
  "Configure your sender to sign requests with this secret (scheme:": "请配置发送方使用此密钥签名请求（方案：",
  "No signing secret for scheme": "此方案无需签名密钥",
  "Use this URL as the payload URL and the signing secret as GitHub's webhook secret.":
    "将此 URL 用作 Payload URL，并将签名密钥用作 GitHub Webhook 密钥。",
  "Use the endpoint signing secret shown by Stripe for this destination.": "使用 Stripe 为此目标显示的端点签名密钥。",
  "Use the Slack app signing secret. Requests older than five minutes are rejected.":
    "使用 Slack 应用签名密钥；超过五分钟的请求会被拒绝。",
  "Send the digest in X-Signature as hex or sha256=<hex>.": "在 X-Signature 中以十六进制或 sha256=<hex> 发送摘要。",
  "The event runs in your personal context. After creation, ask the agent to route notable results to a teammate or channel by name.":
    "事件在你的个人上下文中运行。创建后可让助手按名称将重要结果发送给成员或频道。",
  "what the agent should do for each event": "助手应对每个事件执行的操作",
  "optional; one per line as": "可选；每行一项，格式为",
  "leave blank to auto-generate": "留空则自动生成",
  "auto-generated if blank": "留空则自动生成",
  "An action is required.": "操作为必填项。",
  "Invalid filters.": "筛选条件无效。",
  "Webhook created ✓": "Webhook 已创建 ✓",
  "Copy the secret now — it won't be shown again.": "请立即复制密钥，之后将不再显示。",
  "Webhook disabled.": "Webhook 已停用。",
  "Webhook re-enabled.": "Webhook 已重新启用。",
  "Couldn't disable webhook.": "无法停用 Webhook。",
  "Couldn't re-enable webhook.": "无法重新启用 Webhook。",
  "That conversation wasn't found, or you don't have access to it.": "未找到该会话，或你没有访问权限。",
  "This edit link is missing a valid app name.": "此编辑链接缺少有效的应用名称。",
  Off: "关闭",
  "Default (": "默认（",
  "Org default (": "组织默认值（",
  "— no longer offered": "— 已不再提供",
  Conversations: "会话",
  Enable: "启用",
  Disable: "停用",
  "Refresh projects": "刷新项目",
  "Search projects": "搜索项目",
  "Search projects…": "搜索项目…",
  "No projects yet.": "尚无项目。",
  "Searching…": "正在搜索…",
  Show: "显示",
  You: "你",
  "The agent posts this project's updates to #": "助手会将此项目的更新发布到 #",
  ", and everyone in the channel is in the project.": "，频道中的所有人都会加入此项目。",
  "Delete this cron? This can't be undone.": "删除此定时任务？此操作无法撤销。",
  "Delete this skill? This can't be undone.": "删除此技能？此操作无法撤销。",
  "Couldn't update that cron.": "无法更新该定时任务。",
  "Couldn't delete that skill.": "无法删除该技能。",
  Code: "代码",
  Connect: "连接",
  Retry: "重试",
  Stopped: "已停止",
  "Tried step": "步骤执行未成功",
  "Steer the running task with this instead of waiting": "用此消息调整正在运行的任务，无需等待",
  "untitled cron": "未命名定时任务",
  Context: "上下文",
  Destination: "目标",
  Schedule: "计划",
  Task: "任务",
  Title: "标题",
  Message: "消息",
  "Last fired": "最近触发",
  Never: "从未",
  Worklog: "工作日志",
  "a Slack channel": "一个 Slack 频道",
  "GitLab CI watch": "GitLab CI 监控",
  "Gmail unread digest": "Gmail 未读摘要",
  "Archive failed": "归档失败",
  "Delete failed": "删除失败",
  "Disable failed": "停用失败",
  "Enable failed": "启用失败",
  "Run failed": "运行失败",
  "Edit failed": "编辑失败",
  Access: "访问权限",
  "Copy URL": "复制 URL",
  "Display name": "显示名称",
  "Git remote": "Git 远程地址",
  Latest: "最新",
  Live: "线上",
  Organization: "组织",
  "URL slug": "URL 标识符",
  "Using URL slug": "当前 URL 标识符",
  "When a GitHub issue is opened, triage it and post a one-paragraph summary.":
    "当 GitHub 议题创建时进行分类，并发布一段摘要。",
  "action: opened, reopened": "action: opened, reopened",
  "path: value1, value2": "path: value1, value2",
  "— leave blank to auto-generate": "— 留空则自动生成",
  "— optional; one per line as": "— 可选；每行一项，格式为",
  "— what the agent should do for each event": "— 助手应对每个事件执行的操作",
  Generate: "生成",
  Disconnect: "断开连接",
  "API keys, tokens, and files you added through the one-time page.": "通过一次性页面添加的 API 密钥、Token 和文件。",
  "Lets the agent act in Slack as you — read your channels and post messages on your behalf. (To chat with the agent in Slack, just DM it — you don't need this.)":
    "允许助手以你的身份操作 Slack，包括读取频道和代表你发布消息。（若只需在 Slack 中与助手聊天，直接私信即可，无需连接此账户。）",
  "Lets the agent browse, download, and upload files in your Dropbox on your behalf, and manage shared links.":
    "允许助手代表你浏览、下载和上传 Dropbox 文件，并管理共享链接。",
  "Lets the agent read X and post, like, and follow as you — used when an action should come from your account rather than the org's.":
    "允许助手读取 X，并以你的身份发帖、点赞和关注，适用于需要由个人账户而非组织账户执行的操作。",
  "Lets the agent read and act in your Gmail, Calendar, and Sheets on your behalf, and read your Drive (it can save new files there, but not edit your existing ones).":
    "允许助手代表你读取和操作 Gmail、日历和表格，并读取云端硬盘（可保存新文件，但不能编辑现有文件）。",
  "Lets the agent read and update your GitHub repos, issues, and PRs on your behalf.":
    "允许助手代表你读取和更新 GitHub 仓库、议题和 PR。",
  "Lets the agent read and update your Linear issues on your behalf.": "允许助手代表你读取和更新 Linear 议题。",
  "Lets the agent read the Notion pages and databases you share with it (and edit them if you grant that access).":
    "允许助手读取你共享的 Notion 页面和数据库；授予编辑权限后也可进行编辑。",
  "the whole org": "整个组织",
  "a group DM": "一个群聊私信",
  "a personal DM": "一条个人私信",
  "a team": "一个团队",
  Created: "创建时间",
  Sort: "排序",
  Type: "类型",
  "Upload failed.": "上传失败。",
  Current: "当前",
  History: "历史",
  "Refresh memory": "刷新记忆",
  "Search memory": "搜索记忆",
  "Unsaved changes": "未保存的更改",
  "Clear row color": "清除行颜色",
  Waiting: "等待中",
  "Loading conversations…": "正在加载会话…",
  "All scopes": "全部范围",
  Capabilities: "能力",
  Details: "详情",
  Editing: "正在编辑",
  Instructions: "指令",
  "Everyone in this context can invoke and edit these instructions.": "此上下文中的所有人都可以调用和编辑这些指令。",
  "Everyone in this context can invoke the updated instructions. Description":
    "此上下文中的所有人都可以调用更新后的指令。描述",
  "Publish this change to": "将此更改发布到",
  "This version will stop being available to": "此版本将不再提供给",
  "that version becomes effective. Its history and assets are kept, and you can restore it later.":
    "该版本将生效。其历史和资源会被保留，之后仍可恢复。",
  "only you": "仅你",
  "this context": "此上下文",
  "(untitled cron)": "（未命名定时任务）",
  "archive failed": "归档失败",
  "delete failed": "删除失败",
  "disable failed": "停用失败",
  "enable failed": "启用失败",
  "run failed": "运行失败",
  "edit failed": "编辑失败",
  "unarchive failed": "取消归档失败",
  "No messages match “": "没有消息匹配“",
  "starts a new chat where QM hunts down the matching session and links it":
    "会新建聊天，让 QM 查找匹配的会话并提供链接",
  "Working…": "处理中…",
});

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
  const count = text.match(/^(\d+) (conversation|project|skill|app|file|webhook|cron|session|message)s?$/);
  if (count) {
    const nouns: Record<string, string> = {
      conversation: "个会话",
      project: "个项目",
      skill: "个技能",
      app: "个应用",
      file: "个文件",
      webhook: "个 Webhook",
      cron: "个定时任务",
      session: "个会话",
      message: "条消息",
    };
    return `${leading}${count[1]} ${nouns[count[2]!]}${trailing}`;
  }
  const selected = text.match(/^(\d+) conversations selected$/);
  if (selected) return `${leading}已选择 ${selected[1]} 个会话${trailing}`;
  const noMessages = text.match(/^No messages match “(.+)”\.?$/);
  if (noMessages) return `${leading}没有消息匹配“${noMessages[1]}”${trailing}`;
  const searchChats = text.match(/^Search your chats · (.+)$/);
  if (searchChats) return `${leading}搜索聊天 · ${searchChats[1]}${trailing}`;
  const projectLabel = text.match(/^(.+) project$/);
  if (projectLabel) return `${leading}${projectLabel[1]} 项目${trailing}`;
  const optionsFor = text.match(/^Options for (.+)$/);
  if (optionsFor) return `${leading}${optionsFor[1]} 的选项${trailing}`;
  const newChatIn = text.match(/^New chat in (.+)$/);
  if (newChatIn) return `${leading}在 ${newChatIn[1]} 中新建聊天${trailing}`;
  const copyLink = text.match(/^Copy link to (.+)$/);
  if (copyLink) return `${leading}复制“${copyLink[1]}”的链接${trailing}`;
  const rowAction = text.match(/^(Pin|Unpin|Archive|Unarchive) (.+)$/);
  if (rowAction) {
    const actions: Record<string, string> = {
      Pin: "置顶",
      Unpin: "取消置顶",
      Archive: "归档",
      Unarchive: "取消归档",
    };
    return `${leading}${actions[rowAction[1]!]}${rowAction[2]}${trailing}`;
  }
  const colorRow = text.match(/^Color row (.+)$/);
  if (colorRow) return `${leading}将行颜色设为 ${colorRow[1]}${trailing}`;
  const colorSelected = text.match(/^Color selected conversations (.+)$/);
  if (colorSelected) return `${leading}将所选会话颜色设为 ${colorSelected[1]}${trailing}`;
  const settings = text.match(/^Session settings — (.+)$/);
  if (settings) return `${leading}会话设置 — ${settings[1]}${trailing}`;
  const batch = text.match(/^Batch interval for (.+) in hours$/);
  if (batch) return `${leading}${batch[1]} 的批处理间隔（小时）${trailing}`;
  const removeLedger = text.match(/^Remove (.+) from the ledger$/);
  if (removeLedger) return `${leading}从清单中移除 ${removeLedger[1]}${trailing}`;
  const defaultModel = text.match(/^Default \((.+)\)$/);
  if (defaultModel) return `${leading}默认（${defaultModel[1]}）${trailing}`;
  const orgDefault = text.match(/^Org default \((.+)\)$/);
  if (orgDefault) return `${leading}组织默认值（${orgDefault[1]}）${trailing}`;
  const moreActions = text.match(/^More actions for (.+)$/);
  if (moreActions) return `${leading}${moreActions[1]} 的更多操作${trailing}`;
  const unlink = text.match(/^Unlink #(.+)$/);
  if (unlink) return `${leading}取消关联 #${unlink[1]}${trailing}`;
  const removePerson = text.match(/^Remove (.+)$/);
  if (removePerson) return `${leading}移除 ${removePerson[1]}${trailing}`;
  const refreshFailed = text.match(/^Refresh failed:\s*(.+)$/);
  if (refreshFailed) return `${leading}刷新失败：${refreshFailed[1]}${trailing}`;
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
