# 远程浏览器桥接改造方案

## 1. 改造目标

把当前本地单机模式：

```text
CLI -> localhost daemon -> 本地浏览器扩展
```

改造成远程桥接模式：

```text
CLI -> 远程 bridge 服务 -> 指定浏览器扩展客户端
```

第一版严格收敛范围，只做：

- 单用户
- 多终端 / 多浏览器客户端
- 固定共享 `token` 鉴权
- 浏览器扩展连接成功后由服务端分配 `clientId`
- 扩展端可展示当前 `clientId`
- CLI 可以查看在线客户端并指定某个 `clientId`
- 远程文件注入只支持 `memory` 模式
- 协议中预留 `disk` 模式和阈值字段，后续再扩展

## 2. 范围定义

### 2.1 本次包含

- 远程 bridge 服务，负责 HTTP + WebSocket 通信
- 浏览器扩展新增配置项：
  - `backendUrl`
  - `token`
- 扩展注册、心跳、断线重连
- 服务端分配并返回 `clientId`
- CLI 增加远程 transport
- CLI 支持按 `clientId` 定向下发命令
- CLI 支持查看在线客户端列表
- 远程文件注入采用：
  - `signed URL -> fetch -> Blob -> File -> DataTransfer -> input.files`
- 协议中提前放入未来 `disk` 模式需要的阈值字段

## 3. 当前实现约束

当前代码默认假设 CLI 和浏览器扩展在同一台机器：

- CLI 通过本地 HTTP 调 daemon，见 `src/browser/daemon-client.ts`
- 扩展通过本地 WebSocket 连 daemon，见 `extension/src/protocol.ts`
- daemon 当前只维护一个扩展连接，用单个 `extensionWs` 表示，见 `src/daemon.ts`
- 当前文件注入只支持“本地文件路径 -> CDP DOM.setFileInputFiles”，见 `src/browser/page.ts` 与 `extension/src/cdp.ts`
- `src/clis/xiaohongshu/publish.ts` 已经有一条浏览器内存注入 fallback，可直接作为远程文件注入的实现参考

## 4. 目标架构

### 4.1 拓扑结构

```text
CLI
  -> 远程 Bridge HTTP API
  -> 连接注册表
  -> 指定 clientId 的 WebSocket
  -> 浏览器扩展
  -> chrome.debugger / tabs / cookies / DOM
  -> 执行结果回传 Bridge
  -> Bridge 回 HTTP 响应给 CLI
```

### 4.2 核心标识

- `token`
  - CLI 和扩展共用的固定共享密钥
- `clientId`
  - bridge 为每个在线扩展实例分配的唯一客户端标识
- `commandId`
  - 每次命令调用的唯一请求 ID
- `workspace`
  - 沿用 opencli 现有窗口 / tab 复用语义

## 5. 协议设计

### 5.1 扩展注册

WebSocket 地址：

- `wss://<bridge>/agent`

扩展首次发送：

```json
{
  "type": "register",
  "token": "<shared-token>",
  "extensionVersion": "1.5.5",
  "browserInfo": "Chrome 136 macOS",
  "capabilities": {
    "fileInputMemory": true,
    "fileInputDisk": false,
    "warnMemoryBytes": 10485760,
    "hardMemoryBytes": 26214400
  }
}
```

bridge 返回：

```json
{
  "type": "registered",
  "clientId": "cli_abcd1234",
  "serverTime": 1770000000000
}
```

### 5.2 心跳

扩展周期性发送：

```json
{
  "type": "heartbeat",
  "clientId": "cli_abcd1234",
  "ts": 1770000000000
}
```

### 5.3 CLI 下发命令

HTTP 接口：

- `POST /api/command`

请求头：

- `Authorization: Bearer <token>`

请求体：

```json
{
  "clientId": "cli_abcd1234",
  "commandId": "cmd_1770000000000_1",
  "workspace": "site:xiaohongshu",
  "action": "exec",
  "payload": {
    "code": "(() => document.title)()"
  },
  "timeoutMs": 30000
}
```

### 5.4 扩展回传结果

```json
{
  "type": "result",
  "clientId": "cli_abcd1234",
  "commandId": "cmd_1770000000000_1",
  "ok": true,
  "data": "OpenCLI"
}
```

### 5.5 在线客户端列表

HTTP 接口：

- `GET /api/clients`

请求头：

- `Authorization: Bearer <token>`

返回示例：

```json
[
  {
    "clientId": "cli_abcd1234",
    "connectedAt": 1770000000000,
    "lastSeenAt": 1770000005000,
    "extensionVersion": "1.5.5",
    "browserInfo": "Chrome 136 macOS",
    "capabilities": {
      "fileInputMemory": true,
      "fileInputDisk": false,
      "warnMemoryBytes": 10485760,
      "hardMemoryBytes": 26214400
    }
  }
]
```

## 6. 远程文件注入方案

### 6.1 第一版策略

第一版只支持 `memory` 模式。

输入 payload：

```json
{
  "selector": "input[type=file]",
  "mode": "memory",
  "files": [
    {
      "url": "https://example-oss/file.png?signature=...",
      "name": "file.png",
      "mimeType": "image/png",
      "sizeBytes": 123456
    }
  ],
  "warnMemoryBytes": 10485760,
  "hardMemoryBytes": 26214400
}
```

执行链路：

1. 校验 `mode === "memory"`
2. 校验文件大小不超过 `hardMemoryBytes`
3. `fetch(url)` 拉取远程文件字节
4. 构造 `Blob`
5. 构造 `File`
6. 放入 `DataTransfer`
7. 赋值给目标 `input.files`
8. 触发 `input` 与 `change`
9. 返回注入数量、总字节数、耗时

### 6.2 为什么先做这个

- 改动成本最低
- 不需要给扩展增加 `downloads` 权限
- 不需要管理本地临时文件生命周期
- 仓库里已有同类内存注入实现可参考

### 6.3 阈值策略

第一版行为定义：

- `sizeBytes <= warnMemoryBytes`
  - 正常执行
- `warnMemoryBytes < sizeBytes <= hardMemoryBytes`
  - 继续执行，但记录 warning 日志
- `sizeBytes > hardMemoryBytes`
  - 直接失败，并明确提示：
    - `memory mode limit exceeded`
    - `disk mode reserved for future implementation`

### 6.4 内存释放要求

实现上必须满足：

- 不把文件字节缓存到全局状态
- `Blob`、`File`、`DataTransfer` 只存在于单次命令作用域
- 不把文件内容持久化到扩展状态里
- 注入完成后不额外保留引用

第一版不实现 `disk` 模式，只做好字段预留。

## 7. CLI 改造

### 7.1 新增配置来源

支持这些环境变量：

- `OPENCLI_REMOTE_URL`
- `OPENCLI_REMOTE_TOKEN`
- `OPENCLI_REMOTE_CLIENT`

支持对应命令行参数：

- `--remote-url`
- `--token`
- `--client`

### 7.2 新增命令

新增：

- `opencli clients`
  - 查看当前在线客户端

可选后续项：

- `opencli client use <clientId>`
  - 本地持久化默认客户端

第一版不强制实现默认绑定，先依赖 `--client` 或 `OPENCLI_REMOTE_CLIENT`。

### 7.3 transport 抽象

当前 `Page` 实现直接依赖本地 daemon。

改造目标：

- 引入 transport 抽象
- 保持 `Page` 行为尽量不变
- 允许本地模式和远程模式并存

建议接口：

```ts
interface BrowserTransport {
  send(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  status?(): Promise<unknown>;
}
```

建议实现：

- `LocalDaemonTransport`
- `RemoteBridgeTransport`

### 7.4 CLI 侧需要改动的文件

- `src/browser/daemon-client.ts`
- `src/browser/page.ts`
- `src/types.ts`
- `src/runtime.ts`
- `src/cli.ts`

## 8. 扩展改造

### 8.1 配置界面

扩展 popup 增加：

- `backendUrl`
- `token`

同时展示：

- 当前连接状态
- 当前 `clientId`

配置存储位置：

- `chrome.storage.local`

### 8.2 扩展运行时行为

启动后：

1. 读取 `backendUrl` 和 `token`
2. 建立到 bridge 的 WebSocket 连接
3. 发起注册
4. 接收 `clientId`
5. 在 popup 中展示 `clientId`
6. 启动心跳

### 8.3 新增动作

扩展继续支持现有动作：

- `exec`
- `navigate`
- `tabs`
- `cookies`
- `screenshot`
- `close-window`
- `sessions`
- `bind-current`

新增远程文件注入动作：

- `set-file-input-remote`

### 8.4 扩展侧需要改动的文件

- `extension/src/protocol.ts`
- `extension/src/background.ts`
- `extension/src/cdp.ts`
- `extension/popup.html`
- `extension/popup.js`

第一版尽量不修改权限模型，不增加 `downloads` 权限。

## 9. Bridge 服务设计

### 9.1 第一版形态

单进程、纯内存版即可。

职责：

- 校验固定 token
- 接收扩展 WebSocket 注册
- 分配 `clientId`
- 维护在线客户端列表
- 按 `clientId` 路由 HTTP 命令
- 维护 `commandId -> promise` 的 pending 表
- 处理命令超时

### 9.2 建议接口

- `GET /health`
- `GET /api/clients`
- `POST /api/command`
- `WS /agent`

### 9.3 内部状态

建议客户端连接结构：

```ts
type ClientConnection = {
  clientId: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  extensionVersion?: string;
  browserInfo?: string;
  capabilities: {
    fileInputMemory: boolean;
    fileInputDisk: boolean;
    warnMemoryBytes?: number;
    hardMemoryBytes?: number;
  };
};
```

建议 pending 表结构：

```ts
Map<string, {
  clientId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>
```

### 9.4 鉴权方式

第一版只做固定 token：

- HTTP 接口校验 bearer token
- WebSocket 注册消息校验 token

不做用户体系，不做 refresh token。

## 10. Adapter 影响面

绝大多数 adapter 不需要改。

原因：

- 浏览器指令模型仍然是 `IPage`
- 路由逻辑下沉到 transport / bridge 层
- 只有真正依赖 `input[type=file]` 的命令才需要显式接入远程文件注入能力

### 10.1 第一批验证对象

- `src/clis/xiaohongshu/publish.ts`

原因：

- 已经有文件注入逻辑
- 已经有内存注入 fallback
- 能验证真实上传 UI 行为

### 10.2 大概率不需要改的 adapter

- 纯公共 API 命令
- 普通浏览器读取类命令
- 只走 cookie/header API 的命令
- 通过页面内 API/FormData 上传、不依赖 `<input type="file">` 的命令

## 11. 分阶段开发计划

### 阶段 0：方案冻结

产出：

- 协议定义
- transport 抽象方案
- 远程文件 `memory` 模式方案
- 阈值策略

### 阶段 1：Bridge MVP

实现：

- 固定 token 鉴权
- 客户端注册
- `clientId` 分配
- 客户端列表
- 命令路由
- pending 结果回收

验收：

- 一个扩展可以成功接入
- 一条 CLI 命令可以被正确路由并返回结果

### 阶段 2：CLI transport 重构

实现：

- 本地模式
- 远程模式

验收：

- 本地模式不受影响
- 远程模式可执行 `exec`、`navigate`、`cookies`

### 阶段 3：扩展远程接入

实现：

- 配置 UI
- 注册
- `clientId` 展示
- 心跳

验收：

- 扩展可展示连接状态
- 扩展可展示分配到的 `clientId`

### 阶段 4：远程文件注入 MVP

实现：

- `set-file-input-remote`
- 仅支持 `memory`
- 阈值 warning / error

验收：

- 标准 file input 可成功完成远程文件注入
- 超过 `hardMemoryBytes` 的文件会明确失败

### 阶段 5：真实 adapter 验证

接入：

- `src/clis/xiaohongshu/publish.ts`

验收：

- 真实端到端流程可成功到达图片注入环节

### 阶段 6：加固

补充：

- 更明确的错误文案
- 重连策略
- stale client 清理
- timeout 调整
- 远程文件注入 warning 日志

## 12. 验收标准

### 12.1 功能验收

- 扩展可以配置后端地址和 token
- 扩展连接后能拿到 `clientId`
- popup 能展示当前 `clientId`
- CLI 能列出在线客户端
- CLI 能指定某个 `clientId` 执行命令
- 基础浏览器命令可通过远程 bridge 正常执行
- 远程文件注入的 `memory` 模式可正常工作
- 超阈值文件会明确失败

### 12.2 非功能验收

- 本地模式仍可继续使用
- 远程模式不要求大规模重写 adapter
- 第一版不实现 disk 下载落盘
- 扩展内不长期缓存文件字节内容

## 13. 风险点

- MV3 service worker 长连接稳定性需要重点观察
- 某些站点可能需要 `input` / `change` 之外的额外上传事件
- `memory` 模式在大文件上可能出现明显峰值内存
- `clientId` 断线重连是否复用，后续可能会成为需求

## 14. 建议默认值

建议第一版阈值：

- `warnMemoryBytes = 10 * 1024 * 1024`
- `hardMemoryBytes = 25 * 1024 * 1024`

建议重连策略：

- 扩展指数退避重连
- bridge 在 socket close 时立即移除失活客户端

建议 `clientId` 策略：

- 第一版每次新连接分配新的 `clientId`
- 暂不做断线身份恢复

## 15. 后续可扩展项

本次不做，但设计时已预留：

- `disk` 文件模式
- CLI 默认客户端绑定
- 客户端昵称 / 标签
- 断线重连身份恢复
- 更丰富的上传生命周期钩子
