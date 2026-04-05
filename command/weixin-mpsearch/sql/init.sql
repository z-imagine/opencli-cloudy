-- 统一会话时区，便于时间字段展示
SET timezone = 'Asia/Shanghai';

-- ============================================================
-- 通用 updated_at 自动更新时间触发器函数
-- ============================================================
CREATE OR REPLACE FUNCTION wxmp_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 1. 公众号账号表
-- 一行表示一个公众号账号
-- ============================================================
CREATE TABLE IF NOT EXISTS wxmp_accounts (
  id                BIGSERIAL PRIMARY KEY,                             -- 账号主键
  fakeid            TEXT NOT NULL UNIQUE,                              -- 公众号 fakeid，业务唯一键
  nickname          TEXT NOT NULL,                                     -- 公众号名称
  alias             TEXT,                                              -- 公众号别名/微信号
  signature         TEXT,                                              -- 公众号简介
  verify_status     INTEGER,                                           -- 认证状态
  service_type      INTEGER,                                           -- 账号类型
  round_head_img    TEXT,                                              -- 头像 URL
  raw_json          JSONB NOT NULL DEFAULT '{}'::jsonb,                -- 原始账号响应
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),                -- 首次入库时间
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()                 -- 最近更新时间
);

COMMENT ON TABLE wxmp_accounts IS '微信公众号账号表';
COMMENT ON COLUMN wxmp_accounts.id IS '账号主键';
COMMENT ON COLUMN wxmp_accounts.fakeid IS '公众号 fakeid，业务唯一键';
COMMENT ON COLUMN wxmp_accounts.nickname IS '公众号名称';
COMMENT ON COLUMN wxmp_accounts.alias IS '公众号别名或微信号';
COMMENT ON COLUMN wxmp_accounts.signature IS '公众号简介';
COMMENT ON COLUMN wxmp_accounts.verify_status IS '认证状态';
COMMENT ON COLUMN wxmp_accounts.service_type IS '账号类型';
COMMENT ON COLUMN wxmp_accounts.round_head_img IS '公众号头像 URL';
COMMENT ON COLUMN wxmp_accounts.raw_json IS '原始账号响应 JSON';
COMMENT ON COLUMN wxmp_accounts.created_at IS '首次入库时间';
COMMENT ON COLUMN wxmp_accounts.updated_at IS '最近更新时间';

CREATE INDEX IF NOT EXISTS idx_wxmp_accounts_nickname
  ON wxmp_accounts (nickname);

CREATE INDEX IF NOT EXISTS idx_wxmp_accounts_alias
  ON wxmp_accounts (alias);

DROP TRIGGER IF EXISTS trg_wxmp_accounts_set_updated_at ON wxmp_accounts;
CREATE TRIGGER trg_wxmp_accounts_set_updated_at
BEFORE UPDATE ON wxmp_accounts
FOR EACH ROW
EXECUTE FUNCTION wxmp_set_updated_at();


-- ============================================================
-- 2. 文章索引表
-- 一行表示一篇文章的索引信息
-- 不记录 page/pagesize 等运行态字段
-- ============================================================
CREATE TABLE IF NOT EXISTS wxmp_article_index (
  id                BIGSERIAL PRIMARY KEY,                             -- 文章索引主键
  account_id        BIGINT,                                            -- 所属公众号主键值，可为空
  url               TEXT NOT NULL UNIQUE,                              -- 文章 URL，业务唯一键
  title             TEXT NOT NULL,                                     -- 文章标题
  digest            TEXT,                                              -- 文章摘要
  cover             TEXT,                                              -- 封面图 URL
  aid               TEXT,                                              -- 微信返回的 aid
  appmsgid          BIGINT,                                            -- 微信返回的 appmsgid
  itemidx           INTEGER,                                           -- 微信返回的 itemidx
  update_time       BIGINT,                                            -- 微信返回的更新时间戳
  update_time_iso   TIMESTAMPTZ,                                       -- 归一化后的更新时间
  raw_json          JSONB NOT NULL DEFAULT '{}'::jsonb,                -- 原始文章索引响应
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),                -- 首次入库时间
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()                 -- 最近更新时间
);

COMMENT ON TABLE wxmp_article_index IS '微信公众号文章索引表';
COMMENT ON COLUMN wxmp_article_index.id IS '文章索引主键';
COMMENT ON COLUMN wxmp_article_index.account_id IS '所属公众号主键值，可为空';
COMMENT ON COLUMN wxmp_article_index.url IS '文章 URL，业务唯一键';
COMMENT ON COLUMN wxmp_article_index.title IS '文章标题';
COMMENT ON COLUMN wxmp_article_index.digest IS '文章摘要';
COMMENT ON COLUMN wxmp_article_index.cover IS '封面图 URL';
COMMENT ON COLUMN wxmp_article_index.aid IS '微信返回的 aid';
COMMENT ON COLUMN wxmp_article_index.appmsgid IS '微信返回的 appmsgid';
COMMENT ON COLUMN wxmp_article_index.itemidx IS '微信返回的 itemidx';
COMMENT ON COLUMN wxmp_article_index.update_time IS '微信返回的更新时间戳';
COMMENT ON COLUMN wxmp_article_index.update_time_iso IS '归一化后的更新时间';
COMMENT ON COLUMN wxmp_article_index.raw_json IS '原始文章索引响应 JSON';
COMMENT ON COLUMN wxmp_article_index.created_at IS '首次入库时间';
COMMENT ON COLUMN wxmp_article_index.updated_at IS '最近更新时间';

CREATE INDEX IF NOT EXISTS idx_wxmp_article_index_account_id
  ON wxmp_article_index (account_id);

CREATE INDEX IF NOT EXISTS idx_wxmp_article_index_appmsg
  ON wxmp_article_index (appmsgid, itemidx);

CREATE INDEX IF NOT EXISTS idx_wxmp_article_index_update_time
  ON wxmp_article_index (update_time);

CREATE INDEX IF NOT EXISTS idx_wxmp_article_index_title
  ON wxmp_article_index (title);

DROP TRIGGER IF EXISTS trg_wxmp_article_index_set_updated_at ON wxmp_article_index;
CREATE TRIGGER trg_wxmp_article_index_set_updated_at
BEFORE UPDATE ON wxmp_article_index
FOR EACH ROW
EXECUTE FUNCTION wxmp_set_updated_at();


-- ============================================================
-- 3. 文章正文表
-- 一行表示一篇文章正文内容
-- 使用 article_id 保存对应文章索引主键值
-- ============================================================
CREATE TABLE IF NOT EXISTS wxmp_article_content (
  id                BIGSERIAL PRIMARY KEY,                             -- 正文主键
  article_id        BIGINT NOT NULL UNIQUE,                            -- 对应文章索引主键值
  title             TEXT NOT NULL,                                     -- 正文抓取时解析出的标题
  account_name      TEXT,                                              -- 正文页解析出的公众号名称
  author            TEXT,                                              -- 正文页解析出的作者
  publish_time      TEXT,                                              -- 正文页解析出的发布时间
  digest            TEXT,                                              -- 正文文本摘要
  content_text      TEXT,                                              -- 正文纯文本
  content_html      TEXT,                                              -- 正文 HTML
  image_urls        JSONB NOT NULL DEFAULT '[]'::jsonb,                -- 正文图片 URL 列表
  raw_json          JSONB NOT NULL DEFAULT '{}'::jsonb,                -- 原始正文解析结果
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),                -- 首次入库时间
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()                 -- 最近更新时间
);

COMMENT ON TABLE wxmp_article_content IS '微信公众号文章正文表';
COMMENT ON COLUMN wxmp_article_content.id IS '正文主键';
COMMENT ON COLUMN wxmp_article_content.article_id IS '对应文章索引主键值';
COMMENT ON COLUMN wxmp_article_content.title IS '正文抓取时解析出的标题';
COMMENT ON COLUMN wxmp_article_content.account_name IS '正文页解析出的公众号名称';
COMMENT ON COLUMN wxmp_article_content.author IS '正文页解析出的作者';
COMMENT ON COLUMN wxmp_article_content.publish_time IS '正文页解析出的发布时间';
COMMENT ON COLUMN wxmp_article_content.digest IS '正文文本摘要';
COMMENT ON COLUMN wxmp_article_content.content_text IS '正文纯文本';
COMMENT ON COLUMN wxmp_article_content.content_html IS '正文 HTML';
COMMENT ON COLUMN wxmp_article_content.image_urls IS '正文图片 URL 列表';
COMMENT ON COLUMN wxmp_article_content.raw_json IS '原始正文解析结果 JSON';
COMMENT ON COLUMN wxmp_article_content.created_at IS '首次入库时间';
COMMENT ON COLUMN wxmp_article_content.updated_at IS '最近更新时间';

CREATE INDEX IF NOT EXISTS idx_wxmp_article_content_article_id
  ON wxmp_article_content (article_id);

DROP TRIGGER IF EXISTS trg_wxmp_article_content_set_updated_at ON wxmp_article_content;
CREATE TRIGGER trg_wxmp_article_content_set_updated_at
BEFORE UPDATE ON wxmp_article_content
FOR EACH ROW
EXECUTE FUNCTION wxmp_set_updated_at();
