# weixin_mpsearch

独立的微信公众号后台列表抓取小工具。

## 安装

```bash
cd command/weixin-mpsearch
npm install
npm run build
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

## 用法

扫码登录并保存本地会话：

```bash
npx weixin_mpsearch login
```

根据公众号名称搜索候选列表：

```bash
npx weixin_mpsearch listaccount --nickname '腾讯新闻' --page 1 --pagesize 5
```

根据精确 fakeid 拉取文章列表：

```bash
npx weixin_mpsearch listarticle --fakeid 'MjM5NzM2NjUzNg==' --page 1 --pagesize 5
```

根据文章 URL 解析正文内容：

```bash
npx weixin_mpsearch getarticle --url 'https://mp.weixin.qq.com/s?...'
```

如果文章访问时触发校验，也可以显式带 cookie：

```bash
npx weixin_mpsearch getarticle --url 'https://mp.weixin.qq.com/s?...' --cookie '<cookie>'
```
