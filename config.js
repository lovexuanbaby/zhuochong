import Schema from '@deepseek-ai/schemastery'

const integer = (fallback, minimum = 1) => Schema.number().step(1).min(minimum).max(2_147_483_647).default(fallback)

// This must be a real Schemastery value: Cordis calls it as a validator and
// the Host serializes its metadata for the settings editor.
export const Config = Schema.object({
  pythonPath: Schema.string().default('').description('Python 解释器路径；留空自动选择环境变量、安装脚本创建的环境或本机 Python。'),
  pingIntervalMs: integer(15_000, 1_000).description('心跳间隔（毫秒）'),
  pingTimeoutMs: integer(5_000, 100).description('心跳超时（毫秒）'),
  handshakeTimeoutMs: integer(5_000, 100).description('Python 启动握手超时（毫秒）'),
  shutdownTimeoutMs: integer(3_000, 100).description('退出等待时间（毫秒）'),
  chatProvider: Schema.string().description('可选：固定模型提供方，必须和模型名称一起设置；留空沿用 DSH。'),
  chatModel: Schema.string().description('可选：固定模型名称；凭据始终由 DSH 管理。'),
  chatSystemPrompt: Schema.string().description('可选：桌宠回复风格；留空使用内置提示。'),
  chatMaxTokens: integer(1_024, 16).description('单次回复 token 上限'),
  chatTimeoutMs: integer(180_000, 1_000).description('模型回复超时（毫秒）'),
  chatHistoryMessages: integer(40).description('发送给模型的最近聊天消息数'),
  chatHistoryMaxMessages: integer(200).description('本地保留的聊天消息数'),
  chatHistoryPath: Schema.string().description('可选：聊天历史文件路径；留空使用 DSH 数据目录。'),
  chatMemoryEnabled: Schema.boolean().default(true).description('启用长期记忆提炼和注入；关闭后仍可查看、删除已有记忆。'),
  chatMemoryUpdateEveryTurns: integer(4).description('每多少轮聊天整理一次记忆'),
  chatMemoryMaxFacts: integer(40).description('最多保留的长期记忆条数'),
  chatMemoryTranscriptMessages: integer(24, 2).description('整理记忆时使用的最近消息数'),
  chatMemoryPath: Schema.string().description('可选：长期记忆文件路径；留空使用 DSH 数据目录。'),
})
