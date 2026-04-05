# weixin_mpsearch 存储 DDL

这份文档定义 `weixin_mpsearch` 第一版中心数据库存储结构。

## 命名约定

统一使用表前缀：

- `wxmp_`

原因：

- `wx` 对应微信
- `mp` 对应公众号
- 前缀足够短
- 后续如果同库再接别的抓取工具，不容易冲突

## 设计原则

- 使用 PostgreSQL
- `wxmp_article_index` 只记录文章本身的索引信息
- 不在文章表中记录分页状态、翻页进度、抓取页码等运行态字段
- `wxmp_article_content` 使用 `article_id` 存储对应文章索引主键值
- `wxmp_article_index.account_id` 允许为空，兼容直接按文章 URL 抓正文的场景
- `url` 用于唯一约束和去重，不作为主关联键
- 原始响应保留在 `raw_json jsonb`
- 第一版不使用数据库外键约束，只使用普通字段和普通索引
- `updated_at` 通过数据库触发器自动维护

## SQL 文件

DDL 已单独存放到这个文件：

- [weixin-mpsearch-storage.sql](/Users/samuel/Projects/SkillProjects/opencli/docs/developer/weixin-mpsearch-storage.sql)

执行时直接使用该 SQL 文件，不要从这份说明文档里复制 SQL。

## 说明

- `wxmp_accounts.fakeid` 是账号业务唯一键
- `wxmp_article_index.url` 是文章业务唯一键
- `wxmp_article_content.article_id` 保存 `wxmp_article_index.id` 的值，用于业务层自行关联
- 第一版不引入分页状态表、抓取任务表、运行日志表
- 第一版不引入文件存储或对象存储，完整 JSON/HTML 直接放数据库字段
