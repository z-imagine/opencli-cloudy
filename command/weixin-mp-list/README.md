# weixin_mpsearch

独立的微信公众号后台列表抓取小工具。

## 安装

```bash
npm install -g weixin_mpsearch
```

本地开发：

```bash
cd command/weixin-mp-list
npm install
npm run build
```

## 用法

扫码登录并保存本地会话：

```bash
weixin_mpsearch login
```

根据公众号名称搜索候选列表：

```bash
weixin_mpsearch listaccount --nickname '腾讯新闻' --page 1 --pagesize 5
```

根据精确 fakeid 拉取文章列表：

```bash
weixin_mpsearch listarticle --fakeid 'MjM5NzM2NjUzNg==' --page 1 --pagesize 5
```

根据文章 URL 解析正文内容：

```bash
weixin_mpsearch getarticle --url 'https://mp.weixin.qq.com/s?...'
```

如果文章访问时触发校验，也可以显式带 cookie：

```bash
weixin_mpsearch getarticle --url 'https://mp.weixin.qq.com/s?...' --cookie '<cookie>'
```
