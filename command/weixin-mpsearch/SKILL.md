---
name: weixin-mpsearch
description: 当需要先按微信公众号名称检索匹配账号、再查看目标公众号的文章列表，或直接根据微信公众号文章链接提取正文内容时，使用这个工具。
---

# Weixin MP Search

默认操作对象是本地 Node.js 项目里的 `weixin_mpsearch` 命令入口，通过 `npx` 或 `npm run` 调用，不依赖全局安装。

## 适用业务场景

当用户要做这些事时，使用本 skill：

- 已知公众号名称，想查询该名称对应的公众号候选列表
- 已知公众号名称，但可能有多个同名账号，想先确认目标账号，再查询该账号文章列表
- 已知精确 `fakeid`，想直接查询该公众号文章列表
- 已知公众号文章 URL，想直接解析正文内容

这个 skill 的核心不是“先看有哪些命令”，而是按业务流程完成：

1. 公众号名称 -> 候选账号 -> 确认 fakeid -> 文章列表
2. 文章 URL -> 正文解析

## 安装

先进入项目目录并安装本地依赖：

```bash
cd command/weixin-mpsearch
npm install
```

推荐调用方式：

```bash
npx weixin_mpsearch --help
```

也可以使用：

```bash
npm run start -- --help
```

## 初始化

第一次使用前，先做 setup。

先配置环境变量：

```bash
export WEIXIN_MP_DB_URL='postgres://user:password@host:5432/dbname'
```

然后执行：

```bash
npx weixin_mpsearch setup
```

这个命令会：

- 初始化本地运行目录
- 连接数据库
- 执行包内置 SQL：`sql/init.sql`

## 业务流程

### 流程 A：公众号名称 -> 候选账号 -> 目标 fakeid -> 文章列表

这是最常见的主流程。

步骤：

1. 先确保本地已有可用登录态  
   `listaccount` 和 `listarticle` 都依赖登录后保存的本地会话。  
   如果本地没有可用会话，必须先执行：

   ```bash
   npx weixin_mpsearch login
   ```

2. 根据公众号名称查询候选账号列表

   ```bash
   npx weixin_mpsearch listaccount --nickname '<公众号名称>' --page 1 --pagesize 5
   ```

3. 从候选结果中确认目标账号  
   这里最关键的是拿到精确 `fakeid`。

4. 使用确认后的 `fakeid` 查询该公众号文章列表

   ```bash
   npx weixin_mpsearch listarticle --fakeid '<fakeid>' --page 1 --pagesize 5
   ```

### 流程 B：文章 URL -> 正文解析

如果用户已经给了文章 URL，就不需要先查账号和文章列表，直接：

```bash
npx weixin_mpsearch getarticle --url '<文章URL>'
```

这个流程默认不依赖 `login`。  
只有当文章访问触发微信校验时，才考虑额外传入 `--cookie` 兜底。

## login 的定位

`login` 不是独立业务目标。

它只用于：

- 为 `listaccount` 准备可用登录态
- 为 `listarticle` 准备可用登录态

命令：

```bash
npx weixin_mpsearch login
```

行为：

- 扫码登录 `mp.weixin.qq.com`
- 保存本地会话
- 如果当前本地会话仍有效，会直接提示已经登录

## fakeid 的来源和规则

`fakeid` 不是随便填写的，也不是猜出来的。

它的正确来源只有两种：

1. 用户明确提供了精确 `fakeid`
2. 先执行 `listaccount`，再从候选结果中选定目标账号，取该结果中的 `fakeid`

必须遵守这些规则：

- 不要猜 `fakeid`
- 不要伪造 `fakeid`
- `listaccount` 是按名称做模糊检索，所以可能返回多个候选账号
- 如果 `listaccount` 返回多个候选账号，必须先把候选结果返回给调用方或用户确认具体目标
- 只有在目标账号确认后，才能把对应 `fakeid` 用于 `listarticle`

## 原子命令

当前只有这 4 个原子命令：

- `npx weixin_mpsearch login`
- `npx weixin_mpsearch listaccount --nickname <name>`
- `npx weixin_mpsearch listarticle --fakeid <fakeid>`
- `npx weixin_mpsearch getarticle --url <url>`

不要发明不存在的子命令。  
不要伪造 `fakeid`、cookie、token、文章 URL。

## 参数说明

### 1. login

用途：

- 扫码登录并保存本地会话

命令：

```bash
npx weixin_mpsearch login
```

当前没有业务参数。

### 2. listaccount

用途：

- 根据公众号名称查询候选公众号列表

命令：

```bash
npx weixin_mpsearch listaccount --nickname '<公众号名称>' --page 1 --pagesize 5
```

参数：

- `--nickname <name>`
  - 必填，公众号名称
- `--page <n>`
  - 可选，第几页，从 1 开始
- `--pagesize <n>`
  - 可选，每页返回多少个候选公众号
- `--output <path>`
  - 可选，把 JSON 结果写入文件

常见返回字段：

- `nickname`
- `alias`
- `fakeid`
- `signature`
- `verify_status`

### 3. listarticle

用途：

- 根据已经确认的精确 `fakeid` 查询公众号文章列表

命令：

```bash
npx weixin_mpsearch listarticle --fakeid '<fakeid>' --page 1 --pagesize 5
```

参数：

- `--fakeid <fakeid>`
  - 必填，公众号 fakeid
- `--page <n>`
  - 可选，第几页，从 1 开始
- `--pagesize <n>`
  - 可选，每页返回多少篇文章
- `--output <path>`
  - 可选，把 JSON 结果写入文件

常见返回字段：

- `title`
- `url`
- `digest`
- `update_time`
- `update_time_iso`

### 4. getarticle

用途：

- 根据文章 URL 解析公众号正文内容

命令：

```bash
npx weixin_mpsearch getarticle --url '<文章URL>'
```

参数：

- `--url <url>`
  - 必填，公众号文章 URL
- `--cookie <cookie>`
  - 可选，仅在文章访问触发微信校验时作为兜底
- `--output <path>`
  - 可选，把 JSON 结果写入文件

常见返回字段：

- `title`
- `accountName`
- `author`
- `publishTime`
- `url`
- `digest`
- `contentText`
- `contentHtml`
- `imageUrls`

默认优先使用：

- `title`
- `accountName`
- `publishTime`
- `contentText`

只有明确需要富文本或图片资源时，再使用：

- `contentHtml`
- `imageUrls`

## 输出行为

### 不带 `--output`

- 结果直接打印到终端
- stdout 输出完整 JSON

### 带 `--output <path>`

- 结果写入指定文件
- 相对路径相对于当前执行目录
- 终端只打印简短提示，不再打印完整 JSON

## 必须遵守的执行原则

- `listaccount` 和 `listarticle` 都依赖 `login` 获得的可用本地会话
- 没有可用登录态时，先执行 `npx weixin_mpsearch login`
- `fakeid` 必须来自用户明确提供，或者来自 `listaccount` 的候选结果
- `listaccount` 返回多个候选时，必须先让调用方确认目标账号，不能擅自选一个
- 不要使用假值如 `fakeid_test`、`cookie_test`
- 不要自己拼公众号文章 URL
- `getarticle` 如果触发访问校验，应明确说明需要 `--cookie` 兜底，不要伪造正文结果

## 最小业务示例

### 示例 1：按公众号名称查文章列表

```bash
npx weixin_mpsearch login
npx weixin_mpsearch listaccount --nickname '腾讯新闻' --page 1 --pagesize 5
npx weixin_mpsearch listarticle --fakeid '<确认后的fakeid>' --page 1 --pagesize 5
```

### 示例 2：按文章 URL 直接取正文

```bash
npx weixin_mpsearch getarticle --url '<文章URL>'
```
