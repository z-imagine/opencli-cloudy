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

先确保运行环境已经提供环境变量 `WEIXIN_MPSEARCH_DB_URL`。

如果是在 agent / 宿主系统里运行，例如 openclaw，这个变量应由宿主系统统一注入，命令执行时自动继承。

连接串示例：

```text
postgres://wxmp_user:wxmp_password@127.0.0.1:5432/wxmp_prod
```

如果当前环境缺少这个变量，应提示调用方去宿主系统中配置：

- 变量名：`WEIXIN_MPSEARCH_DB_URL`
- 变量值：数据库连接字符串
- 示例值：`postgres://wxmp_user:wxmp_password@127.0.0.1:5432/wxmp_prod`

然后执行：

```bash
npx weixin_mpsearch setup
```

这个命令会：

- 初始化本地运行目录
- 连接数据库
- 执行包内置 SQL：`sql/init.sql`

说明：

- 配置了 `WEIXIN_MPSEARCH_DB_URL` 后，`listaccount`、`listarticle`、`getarticle` 执行后会自动写入数据库
- 如果没有配置 `WEIXIN_MPSEARCH_DB_URL`，命令仍然可以正常执行，但只输出结果，不做存库
- `setup` 本身依赖 `WEIXIN_MPSEARCH_DB_URL`，没有这个变量就无法执行数据库初始化

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
