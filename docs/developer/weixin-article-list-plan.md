# 微信公众号文章列表抓取方案

## 1. 目标

当前 `opencli weixin download` 已支持“已知文章 URL -> 正文导出”。  
本方案补的是另一层能力：

- 输入公众号标识
  - `nickname`
  - 或 `fakeid`
- 输出该公众号的文章列表
  - `title`
  - `url`
  - `digest`
  - `update_time`

第一阶段不直接做成 opencli 正式命令，先分两步推进：

1. 独立 MVP 脚本，支持传 `cookie`，必要时传 `token`
2. opencli 侧先沉淀方案，不急着接入主命令体系

## 2. 技术路线选择

本次选择的主路线是：

- 微信公众号后台登录态
- 后台 Web 接口
- 半自动参数化

不选择的路线：

- 搜狗搜索作为主链路
  - 可作为后备发现渠道
  - 但不适合做主能力
- 全自动 RPA
  - 成本高
  - 容易被风控和页面变更拖垮

## 3. 已验证接口链路

参考资料：

- 方案博客  
  `https://wnma3mz.github.io/hexo_blog/2017/11/18/...`
- 对应文档  
  `https://wnma3mz.github.io/wechat_articles_spider/build/html/wechatarticles.html`
- 源代码页  
  `https://wnma3mz.github.io/wechat_articles_spider/build/html/_modules/wechatarticles/ArticlesUrls.html`

已确认的关键接口：

### 3.1 搜公众号

- 路径：`https://mp.weixin.qq.com/cgi-bin/searchbiz`
- 关键参数：
  - `action=search_biz`
  - `query=<nickname>`
  - `begin`
  - `count`
  - `token`
  - `lang=zh_CN`
  - `f=json`
  - `ajax=1`

作用：

- 根据公众号名称返回候选公众号
- 结果里可拿到：
  - `fakeid`
  - `nickname`
  - `alias`

### 3.2 拉文章列表

- 路径：`https://mp.weixin.qq.com/cgi-bin/appmsg`
- 关键参数：
  - `action=list_ex`
  - `fakeid`
  - `begin`
  - `count`
  - `type=9`
  - `query=`
  - `token`
  - `lang=zh_CN`
  - `f=json`
  - `ajax=1`

作用：

- 按公众号 `fakeid` 分页返回文章列表
- 结果里可拿到：
  - `title`
  - `link`
  - `digest`
  - `cover`
  - `update_time`
  - `aid`
  - `appmsgid`
  - `itemidx`

## 4. MVP 脚本方案

### 4.1 输入

最小输入：

- `cookie`
- `nickname` 或 `fakeid`

可选输入：

- `token`
- `begin`
- `count`
- `pages`
- `delayMs`
- `selectIndex`

### 4.2 输出

JSON：

- `query`
- `fakeid`
- `selectedOfficial`
- `searchResults`
- `totalCount`
- `items[]`

### 4.3 工具位置

- [command/weixin-mpsearch](/Users/samuel/Projects/SkillProjects/opencli/command/weixin-mpsearch)

建议运行方式：

```bash
cd command/weixin-mpsearch
npm install
npx weixin_mpsearch listaccount --nickname '机器之心' --page 1 --pagesize 5
```

如果已经知道精确 `fakeid`：

```bash
cd command/weixin-mpsearch
npx weixin_mpsearch listarticle --fakeid '2394588245' --page 1 --pagesize 5
```

### 4.4 token 策略

MVP 支持两种方式：

1. 显式传 `--token`
2. 不传时，脚本尝试用 `cookie` 请求 `https://mp.weixin.qq.com/` 并从最终 URL / 页面内容中提取 `token`

如果自动提取失败，再手工传 `--token`。

## 5. opencli 接入方案

正式接入 opencli 时，建议不要直接复用“传 cookie 的脚本交互”，而是走 Browser Bridge。

推荐结构：

### 5.1 新命令

- `opencli weixin articles <nickname>`
- 可选：
  - `--fakeid`
  - `--begin`
  - `--count`
  - `--pages`

### 5.2 执行方式

1. Browser Bridge 打开已登录的 `mp.weixin.qq.com`
2. 在同源页面上下文里获取：
   - `token`
   - 当前登录态 cookie 对应请求环境
3. 直接在页面上下文或 bridge 请求层发 `searchbiz`
4. 再发 `appmsg?action=list_ex`
5. 返回结构化列表

### 5.3 为什么不先接主命令

- 当前接口稳定性还没经过 opencli 环境验证
- 公众号重名时需要明确交互策略
- token 获取方式还需要在 Browser Bridge 场景下再验证一次

因此先用独立脚本验证链路是合理的。

## 6. 风险与边界

- 公众号名称可能重名
- `fakeid` 才是稳定标识
- 后台接口可能随时间变化
- 分页大小存在限制，当前经验值为 `1-5`
- 需要节流，避免频繁请求
- 登录态失效后会返回空列表或错误响应

## 7. 下一步建议

1. 先用脚本验证 3-5 个真实公众号
2. 确认：
   - token 自动提取成功率
   - `searchbiz` 结果质量
   - `list_ex` 分页边界
3. 再决定是否接到 `opencli weixin articles`
