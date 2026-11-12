# Superagent

把 Paseo 变成一个常驻的"超级助理":你直接和 Superagent 对话,它负责管理消息源、研判事件、派发子 agent,并把需要你拍板的问题推到面板或企业微信。

## 工作方式

- **左右分屏**:默认左右各半。左侧只读展示消息源的事件消息和 AI 对它的回复(按「触发消息 → AI 回复」分组),顶部有「全部 / 待处理 / 已派发 / 忽略」分类 tab,默认全部;没有输入框。每条消息都有「引用」按钮,点击后引用到右侧输入框。右侧始终是主 Superagent 聊天,不会覆盖左侧消息。左侧可拖拽调宽/收起;分诊规则等内部提示不会展示给用户。
- **聊天消息**:右侧消息按“触发消息 → AI 回复”分组,回复缩进挂在父消息下面。父消息默认展示原文前 20 行,超过 20 行时右下角出现「展开」,展开后可「收起」。消息气泡右下角有「引用」和「Agent 页面」按钮,分别用于引用回复和打开对应 Agent(Paseo 监听到的消息优先打开来源 Agent,否则打开主 Agent)。
- **配置靠对话**:新增消息源、调整设置、停用消息源,都直接对 Superagent 说。它通过 `superagent_*` 工具完成:保存脚本 → 测试 → 你确认后批准启用。
- **消息源是脚本**:任何能输出 NDJSON 的 Python / Node / Shell 脚本都可以接入,每行 `{"id","content","meta"}`;`id` 是一次事件的稳定键,`meta.conversationKey` 是会话归并键(Paseo 默认 agent id,Autowonder 默认工单 id,其他来源由用户和 Superagent 约定),同一 conversation 同时只保留一个活跃工单。插件按 `intervalSec`(最小 10 秒)one-shot 运行脚本。
- **接入前确认清单**:创建新消息源时,主 agent 必须先发确认清单,逐项确认对接方式、监听范围、事件 id、conversationKey、执行归属与复用策略、人工决策、敏感信息、首次回填和测试样本,确认后才写脚本并测试/批准。
- **会话归属**:每个 conversation 有 `ownerAgentId` 和 `executorAgentId`。Paseo 来源把来源 agent 作为 owner,派发时直接把任务发回该 agent,保持原会话连续性;没有 owner agent 的来源才创建 worktree executor,并把执行 agent 记到 conversation 上。
- **用户自己在 Agent 里处理**:你直接在来源 Agent 里发消息时,该 Agent 关联会话的待处理会自动清掉;这一轮由你发起的会话完成/取消不会再生出新的待处理。只有无人值守的后台轮次(不是你刚发的消息触发)才会播报。
- **共享 judge**:所有 conversation 复用同一个 judge Agent(`sa-judge-shared`),不再为每个会话创建 judge。judge 的系统提示强制"不关联历史/其他工单,只研判当前消息中的 ticket";主 agent 只负责右侧聊天、配置和跨会话汇总。执行 Agent 仍然按任务创建/复用多个。
- **面板引用**:点左侧任意消息的「引用」,内容会进入右侧主 Superagent 的输入框;右侧发送带 `T-xxx` 的消息会记录为该工单的人工回复,但不会切换会话或覆盖左侧消息。右侧消息如果关联到已派发工单,也会显示「执行 Agent ↗」入口;引用上一条 Superagent 回复继续聊时会继承上一条线程的工单上下文。左侧只读,右侧始终是全局主 agent 对话。
- **执行复用**:同一 conversation 再次派发时,如果原来的 executor 未归档,直接把新任务 `send` 给原执行 agent(可复用原 worktree/上下文),不再每次新建;只有 executor 已归档或不可达时才创建新 executor。
- **执行结果回聊**:执行 Agent 完成/失败后,结果会自动投递给右侧主 Superagent,由它把结论、推荐方案、需要用户执行的动作和风险汇报到聊天里;内部的 `[执行结果]` 投递消息在界面中隐藏。
- **执行 Agent 权限**:所有由插件创建的 executor / Autowonder coordinator 默认使用 Paseo 的 `full-access` 模式,并预授权 Paseo MCP 工具(包括 browser 工具),避免执行过程中反复弹授权;来源 Agent 的权限仍由该 Agent 原配置决定。
- **Autowonder 异常协作**:Autowonder 来源使用 `mineScope=CREATED` 拉取当前 MCP 账号创建的工单(默认 workspace 10002),按 workitem 独立维护快照;已上线/已取消只记录终态,不做首次播报。默认目标为 `QA 通过·待发布`;judge 通过 `superagent_autowonder_history` 读取压缩后的工单状态、状态模板、最近评论和 `authorRef→数字员工` 映射,找出最新未解决的 AGENT 异常评论。首次异常只发一次企微请求你决策;批准后由协调执行 agent 用 `autowonder_add_workitem_comment` 的 `targetAgentIds` @ 报异常的数字员工恢复推进,并只在合法状态内流转,不自动合并/发布/生产写。后续能自行判断就继续,无法判断再问你。
- **仅通知模式(默认开启)**:Superagent 只播报 AI 判断需要人介入的事件,不自动派发、不自动忽略、不自动执行;只有用户明确回复某张 `T-` 工单要求处理,或在面板点批准后,才允许执行。可以在设置里关闭该模式。
- **派发由主 agent 完成**:脚本产生新事件后,插件把 `[新事件]` 消息发给主 agent;它读取工单后三选一:
  - `superagent_ticket_dispatch` → 新建 worktree 工作区并派发一个后台执行 agent(只开 PR,不 merge);
  - `superagent_ticket_wait_human` → 转成一个具体问题推给你;
  - `superagent_ticket_reject` → 无关/重复,忽略。
- **人对齐**:每张工单都有 `T-编号`。企业微信只在 AI 判断确实需要人介入时推送,通常包括待决策、等待权限、执行失败、需要验收等;新事件、普通工单更新和执行进度默认不直接播报。Paseo 的普通会话完成/取消默认静默归档,不会发企业微信。待决策消息会把原消息以 `>` 引用块放在正文,后面是决策问题和回复方式。企业微信里的回复统一进入右侧主 Superagent 聊天,并记录为该工单的人工回复;主 agent 对提问/查看/判断/处理会调用 `ticket_dispatch`,复用已有执行 Agent 或创建新的执行 Agent,不再把企微消息只留在 judge 内部时间线。在企微里直接聊天时,回复走被动流式回复并原生引用用户消息。
- **状态持久化**:消息源游标、去重、工单、副作用队列和待发送通知都在 `~/.paseo/superagent/superagent.sqlite`;主 agent 暂时不可用时通知会自动重投,daemon 或插件重启后不丢事件。

## 配置

1. 安装后在侧栏打开 Superagent(首次会自动创建主 agent)。
2. 直接对 Superagent 说,例如:
   - "仓库路径设为 /path/to/repo,基线分支 main"
   - "给我接一个 XX 消息源,每 5 分钟拉一次"
   - "把执行模型改成 xxx"
3. 企业微信使用新版 AI 机器人(Bot ID + Secret),出站 WebSocket,不需要公网回调;群聊不能主动推送,通知发到单聊。
4. 面板右侧可以快速暂停/继续、测试/批准/停用消息源、批准/否决待决策工单。

## 已知边界

- 只实现 one-shot 轮询,不支持常驻 watch 进程、cron 表达式和秒级轮询。
- 消息源脚本以 daemon 运行用户身份执行,不做沙箱隔离;只运行你信任的脚本。
- 同一 `meta.subject` 同时只保留一张活跃工单;新事件追加为工单输入。
- 企业微信推送只包含脱敏摘要,详细证据留在面板。
- 执行 agent 默认只开 PR,不自动合并;执行结果需要人工复核。
- 工程验证:`npm run typecheck` + `npm test`(self-test 覆盖会话生命周期、notifyOnly 闸门、T 回复、结果字段、Agent 侧回复清理和 NDJSON 解析)。
