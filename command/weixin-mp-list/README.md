# weixin-mp-list

独立的微信公众号后台列表抓取小工具。

## 安装

```bash
cd command/weixin-mp-list
npm install
```

## 用法

扫码登录并保存本地会话：

```bash
npm run start -- login
```

根据公众号名称搜索候选列表：

```bash
npm run start -- search-biz --nickname '腾讯新闻' --count 5
```

根据精确 fakeid 拉取文章列表：

```bash
npm run start -- list-articles --fakeid 'MjM5NzM2NjUzNg==' --count 5 --pages 1
```
