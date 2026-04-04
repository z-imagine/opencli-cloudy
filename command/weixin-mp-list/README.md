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
weixin_mpsearch listaccount --nickname '腾讯新闻' --count 5
```

根据精确 fakeid 拉取文章列表：

```bash
weixin_mpsearch listarticle --fakeid 'MjM5NzM2NjUzNg==' --count 5 --pages 1
```
