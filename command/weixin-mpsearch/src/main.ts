#!/usr/bin/env node

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from 'pg';

interface SearchBizItem {
  alias?: string;
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
  service_type?: number;
  signature?: string;
  username?: string;
  verify_status?: number;
}

interface AppMsgItem {
  aid?: string;
  appmsgid?: number;
  cover?: string;
  digest?: string;
  itemidx?: number;
  link?: string;
  title?: string;
  update_time?: number;
}

interface SearchBizResponse {
  list?: SearchBizItem[];
  total?: number;
  base_resp?: { ret?: number; err_msg?: string };
}

interface AppMsgResponse {
  app_msg_cnt?: number;
  app_msg_list?: AppMsgItem[];
  base_resp?: { ret?: number; err_msg?: string };
}

interface BaseResponse {
  ret?: number;
  err_msg?: string;
}

interface LoginResponse {
  redirect_url?: string;
  base_resp?: BaseResponse;
}

interface ScanAskResponse {
  status?: number;
  acct_size?: number;
  binduin?: string;
  base_resp?: BaseResponse;
}

interface SessionFile {
  cookie: string;
  token?: string;
  createdAt: string;
  updatedAt: string;
  source: 'login';
}

interface SessionValidationResult {
  ok: boolean;
  token?: string;
  reason?: string;
}

interface ParsedArticleResult {
  ok: true;
  title: string;
  accountName: string;
  author: string;
  publishTime: string;
  url: string;
  digest: string;
  contentHtml: string;
  contentText: string;
  imageUrls: string[];
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SQL_FILE = path.resolve(ROOT_DIR, 'sql/init.sql');
const DEFAULT_SESSION_FILE = path.resolve(process.cwd(), 'tmp/weixin-mp-session.json');
const DEFAULT_QR_FILE = path.resolve(process.cwd(), 'tmp/weixin-mp-login-qrcode.jpg');
const require = createRequire(import.meta.url);
const jsQR = require('jsqr') as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data?: string } | null;
const jpeg = require('jpeg-js') as {
  decode: (buffer: Buffer, options?: { useTArray?: boolean }) => {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
  };
};
const qrcodeTerminal = require('qrcode-terminal') as {
  generate: (text: string, options?: { small?: boolean }, callback?: (qrcode: string) => void) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureRuntimeDirs(): void {
  ensureParentDir(DEFAULT_SESSION_FILE);
  ensureParentDir(DEFAULT_QR_FILE);
}

function randomSessionId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 100)}`;
}

function randomFingerprint(): string {
  return crypto.randomBytes(16).toString('hex');
}

function extractToken(raw: string): string | null {
  const patterns = [
    /[?&]token=(\d+)/,
    /["']token["']\s*[:=]\s*["']?(\d+)/,
    /token=(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseSetCookieToMap(setCookies: string[]): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const entry of setCookies) {
    const firstPart = entry.split(';', 1)[0];
    const eqIndex = firstPart.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (!name) continue;
    if (value === 'EXPIRED') {
      cookies.delete(name);
      continue;
    }
    cookies.set(name, value);
  }
  return cookies;
}

function mergeCookieString(baseCookie: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const chunk of baseCookie.split(';')) {
    const pair = chunk.trim();
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    jar.set(pair.slice(0, eqIndex).trim(), pair.slice(eqIndex + 1).trim());
  }
  for (const [name, value] of parseSetCookieToMap(setCookies).entries()) {
    jar.set(name, value);
  }
  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

function getSetCookies(headers: Headers): string[] {
  const candidate = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof candidate.getSetCookie === 'function') {
    return candidate.getSetCookie();
  }
  const joined = headers.get('set-cookie');
  if (!joined) return [];
  return joined.split(/,(?=[^;]+=)/g);
}

async function fetchWithCookieUpdates(
  input: string | URL,
  init: RequestInit,
  cookie: string,
): Promise<{ response: Response; cookie: string }> {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('Cookie', cookie);
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
  const response = await fetch(input, { ...init, headers });
  const nextCookie = mergeCookieString(cookie, getSetCookies(response.headers));
  return { response, cookie: nextCookie };
}

function buildCommonParams(token: string | null, fingerprint: string): Record<string, string> {
  return {
    fingerprint,
    token: token ?? '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  };
}

async function inferToken(cookie: string): Promise<string> {
  const response = await fetch('https://mp.weixin.qq.com/', {
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
    },
    redirect: 'follow',
  });

  const tokenFromUrl = extractToken(response.url);
  if (tokenFromUrl) return tokenFromUrl;

  const body = await response.text();
  const tokenFromBody = extractToken(body);
  if (tokenFromBody) return tokenFromBody;

  throw new Error('无法从 mp.weixin.qq.com 推断 token，请显式传入 --token，或先执行 login。');
}

async function getJson<T>(url: string, params: Record<string, string>, cookie: string): Promise<T> {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    requestUrl.searchParams.set(key, value);
  }

  const response = await fetch(requestUrl, {
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
      Referer: 'https://mp.weixin.qq.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when requesting ${requestUrl.pathname}`);
  }

  return response.json() as Promise<T>;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHtmlTags(html: string): string {
  return normalizeWhitespace(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function formatUnixTimestamp(seconds: number): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(seconds * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function extractWechatPublishTime(renderedText: string, html: string): string {
  const normalizedRenderedText = normalizeWhitespace(renderedText);
  if (normalizedRenderedText) return normalizedRenderedText;

  const textDatePatterns = [
    /create_time:\s*JsDecode\('([^']+)'\)/,
    /create_time:\s*"([^"]+)"/,
    /create_time:\s*'([^']+)'(?!\s*\*\s*1)/,
  ];
  for (const pattern of textDatePatterns) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(match[1]);
  }

  const timestampPatterns = [
    /create_timestamp:\s*['"]?(\d{10})['"]?\s*\*\s*1/,
    /create_time:\s*['"]?(\d{10})['"]?\s*\*\s*1/,
    /ct\s*=\s*['"]?(\d{10})/,
  ];
  for (const pattern of timestampPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > 0) return formatUnixTimestamp(value);
    }
  }

  return '';
}

function firstText($: cheerio.CheerioAPI, selectors: string[]): string {
  for (const selector of selectors) {
    const text = normalizeWhitespace($(selector).first().text());
    if (text && text !== 'Name cleared') return text;
  }
  return '';
}

function resolveOptionalCookie(opts: { cookie?: string }): string | undefined {
  if (typeof opts.cookie === 'string' && opts.cookie.trim()) {
    return opts.cookie.trim();
  }
  return undefined;
}

async function fetchArticleHtml(url: string, cookie?: string): Promise<{ html: string; finalUrl: string }> {
  const headers = new Headers({
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    Referer: 'https://mp.weixin.qq.com/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  });
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`抓取文章页面失败：HTTP ${response.status}`);
  }
  const html = await response.text();
  return {
    html,
    finalUrl: response.url,
  };
}

function parseWechatArticle(html: string, finalUrl: string): ParsedArticleResult {
  if (/wappoc_appmsgcaptcha/.test(finalUrl) || /环境异常|验证后可继续访问|完成验证后可继续访问/.test(html)) {
    throw new Error('当前文章页面触发了微信访问验证，暂时无法直接解析。');
  }

  const $ = cheerio.load(html);
  const content = $('#js_content').first();
  if (!content.length) {
    throw new Error('未找到文章正文节点 #js_content。');
  }

  content.find('img').each((_: number, element: AnyNode) => {
    const el = $(element);
    const dataSrc = el.attr('data-src');
    if (dataSrc) el.attr('src', dataSrc);
  });

  content.find('script, style, .qr_code_pc, .reward_area').remove();

  const imageUrls: string[] = [];
  const seen = new Set<string>();
  content.find('img').each((_: number, element: AnyNode) => {
    const src = $(element).attr('src');
    if (src && !seen.has(src)) {
      seen.add(src);
      imageUrls.push(src);
    }
  });

  const title = firstText($, ['#activity-name', '#js_msg_title', '#js_text_title', '.rich_media_title']);
  const accountName = firstText($, [
    '#js_name',
    '.wx_follow_nickname',
    '#profileBt .profile_nickname',
    '.rich_media_meta.rich_media_meta_nickname',
    '.rich_media_meta_nickname',
  ]);
  const publishTime = extractWechatPublishTime(firstText($, ['#publish_time']), html);
  const author = firstText($, [
    '#meta_content',
    '.rich_media_meta.rich_media_meta_text',
    '.wx_follow_meta_nickname',
  ]);
  const contentHtml = content.html()?.trim() ?? '';
  const contentText = normalizeWhitespace(content.text());
  const digest = contentText.slice(0, 140);

  return {
    ok: true,
    title,
    accountName,
    author,
    publishTime,
    url: finalUrl,
    digest,
    contentHtml,
    contentText,
    imageUrls,
  };
}

async function searchOfficial(
  cookie: string,
  token: string,
  nickname: string,
  begin: number,
  count: number,
): Promise<SearchBizResponse> {
  const payload = await getJson<SearchBizResponse>(
    'https://mp.weixin.qq.com/cgi-bin/searchbiz',
    {
      action: 'search_biz',
      query: nickname,
      begin: String(begin),
      count: String(count),
      ajax: '1',
      f: 'json',
      lang: 'zh_CN',
      token,
    },
    cookie,
  );

  if (payload.base_resp?.ret && payload.base_resp.ret !== 0) {
    throw new Error(`searchbiz failed: ${payload.base_resp.err_msg ?? payload.base_resp.ret}`);
  }

  return payload;
}

async function listArticlesByFakeid(
  cookie: string,
  token: string,
  fakeid: string,
  begin: number,
  count: number,
): Promise<AppMsgResponse> {
  const payload = await getJson<AppMsgResponse>(
    'https://mp.weixin.qq.com/cgi-bin/appmsg',
    {
      action: 'list_ex',
      begin: String(begin),
      count: String(count),
      fakeid,
      type: '9',
      query: '',
      ajax: '1',
      f: 'json',
      lang: 'zh_CN',
      token,
    },
    cookie,
  );

  if (payload.base_resp?.ret && payload.base_resp.ret !== 0) {
    throw new Error(`appmsg list_ex failed: ${payload.base_resp.err_msg ?? payload.base_resp.ret}`);
  }

  return payload;
}

function normalizeItems(items: AppMsgItem[]): Array<Record<string, unknown>> {
  return items.map((item) => ({
    aid: item.aid ?? '',
    appmsgid: item.appmsgid ?? null,
    itemidx: item.itemidx ?? null,
    title: item.title ?? '',
    digest: item.digest ?? '',
    url: item.link ?? '',
    cover: item.cover ?? '',
    update_time: item.update_time ?? null,
    update_time_iso: typeof item.update_time === 'number' ? new Date(item.update_time * 1000).toISOString() : null,
  }));
}

function saveSessionFile(filePath: string, session: SessionFile): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function loadSessionFile(filePath: string): SessionFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`未找到会话文件：${filePath}。请先执行 "weixin_mpsearch login"，或显式传入 --cookie。`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as SessionFile;
  if (!parsed.cookie) {
    throw new Error(`会话文件无效：${filePath}`);
  }
  return parsed;
}

function resolveSession(
  opts: { cookie?: string; token?: string; sessionFile?: string },
): { cookie: string; token?: string; sessionFile: string } {
  const sessionFile = path.resolve(String(opts.sessionFile || DEFAULT_SESSION_FILE));
  if (typeof opts.cookie === 'string' && opts.cookie.trim()) {
    return {
      cookie: opts.cookie.trim(),
      token: typeof opts.token === 'string' && opts.token.trim() ? opts.token.trim() : undefined,
      sessionFile,
    };
  }
  const session = loadSessionFile(sessionFile);
  return {
    cookie: session.cookie,
    token: typeof opts.token === 'string' && opts.token.trim() ? opts.token.trim() : session.token,
    sessionFile,
  };
}

async function validateSession(cookie: string, token?: string): Promise<SessionValidationResult> {
  let resolvedToken = typeof token === 'string' && token.trim() ? token.trim() : '';
  if (!resolvedToken) {
    try {
      resolvedToken = await inferToken(cookie);
    } catch {
      return { ok: false, reason: '无法推断 token' };
    }
  }

  const payload = await getJson<SearchBizResponse>(
    'https://mp.weixin.qq.com/cgi-bin/searchbiz',
    {
      action: 'search_biz',
      query: '腾讯新闻',
      begin: '0',
      count: '1',
      ajax: '1',
      f: 'json',
      lang: 'zh_CN',
      token: resolvedToken,
    },
    cookie,
  );

  if (payload.base_resp?.ret === 0) {
    return { ok: true, token: resolvedToken };
  }

  if (payload.base_resp?.ret === 200003 || payload.base_resp?.err_msg === 'invalid session') {
    return { ok: false, reason: 'invalid session' };
  }

  return {
    ok: false,
    reason: payload.base_resp?.err_msg ?? String(payload.base_resp?.ret ?? 'unknown error'),
  };
}

function decodeQrContentFromPng(buffer: Buffer): string {
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  let width = 0;
  let height = 0;
  let imageData: Uint8ClampedArray;

  if (isPng) {
    const png = PNG.sync.read(buffer);
    width = png.width;
    height = png.height;
    imageData = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  } else if (isJpeg) {
    const decodedJpeg = jpeg.decode(buffer, { useTArray: true });
    width = decodedJpeg.width;
    height = decodedJpeg.height;
    imageData = decodedJpeg.data instanceof Uint8ClampedArray
      ? decodedJpeg.data
      : new Uint8ClampedArray(decodedJpeg.data.buffer, decodedJpeg.data.byteOffset, decodedJpeg.data.byteLength);
  } else {
    throw new Error('不支持的二维码图片格式，当前仅支持 PNG 或 JPEG。');
  }

  const decoded = jsQR(imageData, width, height);
  if (!decoded?.data) {
    throw new Error('无法从下载的二维码图片中解码出二维码内容。');
  }
  return decoded.data;
}

function printQrToConsole(qrContent: string): Promise<void> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(qrContent, { small: true }, (output: string) => {
      process.stdout.write(`${output}\n`);
      resolve();
    });
  });
}

async function requestLoginStart(sessionId: string, fingerprint: string): Promise<{ cookie: string }> {
  let cookie = '';
  const body = new URLSearchParams({
    userlang: 'zh_CN',
    redirect_url: '',
    login_type: '3',
    sessionid: sessionId,
    ...buildCommonParams('', fingerprint),
  });

  const result = await fetchWithCookieUpdates(
    'https://mp.weixin.qq.com/cgi-bin/bizlogin?action=startlogin',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://mp.weixin.qq.com',
        Referer: 'https://mp.weixin.qq.com/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    },
    cookie,
  );
  cookie = result.cookie;
  const payload = await result.response.json() as { base_resp?: BaseResponse };
  if (payload.base_resp?.ret !== 0) {
    throw new Error(`启动扫码登录失败：${payload.base_resp?.err_msg ?? payload.base_resp?.ret ?? '未知错误'}`);
  }

  return { cookie };
}

async function downloadQrcode(cookie: string, qrFile: string): Promise<Buffer> {
  const url = `https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?action=getqrcode&random=${Date.now()}&login_appid=`;
  const result = await fetchWithCookieUpdates(
    url,
    {
      method: 'GET',
      headers: {
        Referer: 'https://mp.weixin.qq.com/',
      },
    },
    cookie,
  );
  if (!result.response.ok) {
    throw new Error(`getqrcode failed: HTTP ${result.response.status}`);
  }
  const buffer = Buffer.from(await result.response.arrayBuffer());
  ensureParentDir(qrFile);
  fs.writeFileSync(qrFile, buffer);
  return buffer;
}

async function pollQrcodeStatus(cookie: string, fingerprint: string): Promise<{ cookie: string; scanned: true }> {
  let currentCookie = cookie;
  while (true) {
    const params = new URLSearchParams({
      action: 'ask',
      ...buildCommonParams('', fingerprint),
    });
    const result = await fetchWithCookieUpdates(
      `https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Referer: 'https://mp.weixin.qq.com/',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      currentCookie,
    );
    currentCookie = result.cookie;
    const payload = await result.response.json() as ScanAskResponse;
    if (payload.base_resp?.ret !== 0) {
      throw new Error(`轮询扫码状态失败：${payload.base_resp?.err_msg ?? payload.base_resp?.ret ?? '未知错误'}`);
    }
    switch (payload.status) {
      case 0:
      case 4:
      case 6:
        await sleep(1200);
        continue;
      case 1:
        return { cookie: currentCookie, scanned: true };
      case 2:
        throw new Error('二维码已过期，请重新执行 login 刷新二维码。');
      case 3:
        throw new Error('微信侧已取消扫码登录，请重新执行 login。');
      case 5:
        throw new Error('当前扫码账号不允许登录 mp.weixin.qq.com。');
      default:
        throw new Error(`未知的扫码登录状态：${payload.status ?? '未知'}`);
    }
  }
}

async function finalizeQrLogin(cookie: string, fingerprint: string): Promise<{ cookie: string; token: string; redirectUrl: string }> {
  const body = new URLSearchParams({
    userlang: 'zh_CN',
    redirect_url: '',
    cookie_forbidden: '0',
    cookie_cleaned: '1',
    plugin_used: '0',
    login_type: '3',
    ...buildCommonParams('', fingerprint),
  });

  const result = await fetchWithCookieUpdates(
    'https://mp.weixin.qq.com/cgi-bin/bizlogin?action=login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://mp.weixin.qq.com',
        Referer: 'https://mp.weixin.qq.com/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    },
    cookie,
  );
  const payload = await result.response.json() as LoginResponse;
  if (!payload.redirect_url) {
    throw new Error(`完成登录失败：${payload.base_resp?.err_msg ?? payload.base_resp?.ret ?? '缺少 redirect_url'}`);
  }
  const token = extractToken(payload.redirect_url);
  if (!token) {
    throw new Error(`无法从 redirect_url 中提取 token：${payload.redirect_url}`);
  }
  return {
    cookie: result.cookie,
    token,
    redirectUrl: payload.redirect_url,
  };
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('weixin_mpsearch')
    .description('MVP：查询微信公众号候选列表、文章列表与文章正文');

  program
    .command('setup')
    .description('初始化本地运行目录，并按环境变量连接数据库执行初始化 SQL')
    .action(async () => {
      ensureRuntimeDirs();

      const dbUrl = process.env.WEIXIN_MP_DB_URL?.trim() || process.env.DATABASE_URL?.trim();
      if (!dbUrl) {
        throw new Error('缺少数据库连接配置。请先设置 WEIXIN_MP_DB_URL。');
      }
      if (!fs.existsSync(DEFAULT_SQL_FILE)) {
        throw new Error(`未找到初始化 SQL 文件：${DEFAULT_SQL_FILE}`);
      }

      const sslMode = process.env.WEIXIN_MP_DB_SSL?.trim().toLowerCase();
      const client = new Client({
        connectionString: dbUrl,
        ssl: sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
      });

      const sql = fs.readFileSync(DEFAULT_SQL_FILE, 'utf8');
      try {
        await client.connect();
        await client.query(sql);
      } finally {
        await client.end().catch(() => undefined);
      }

      console.log(`本地运行目录已初始化：${path.dirname(DEFAULT_SESSION_FILE)}`);
      console.log(`数据库初始化 SQL 已执行完成：${DEFAULT_SQL_FILE}`);
    });

  program
    .command('login')
    .description('扫码登录 mp.weixin.qq.com，并将 cookie/token 保存到本地 JSON 文件')
    .action(async () => {
      const sessionFile = DEFAULT_SESSION_FILE;
      const qrFile = DEFAULT_QR_FILE;
      const sessionId = randomSessionId();
      const fingerprint = randomFingerprint();
      const now = new Date().toISOString();

      if (fs.existsSync(sessionFile)) {
        const existingSession = loadSessionFile(sessionFile);
        const validation = await validateSession(existingSession.cookie, existingSession.token);
        if (validation.ok) {
          saveSessionFile(sessionFile, {
            ...existingSession,
            token: validation.token,
            updatedAt: now,
          });
          console.log(`已经登录，现有会话仍然有效：${sessionFile}`);
          console.log(`Token：${validation.token}`);
          return;
        }
        console.log(`现有会话已失效（${validation.reason ?? '未知错误'}），开始扫码登录。`);
      }

      console.log('开始执行 mp.weixin.qq.com 扫码登录...');
      const started = await requestLoginStart(sessionId, fingerprint);
      const qrBuffer = await downloadQrcode(started.cookie, qrFile);
      const qrContent = decodeQrContentFromPng(qrBuffer);
      console.log(`二维码图片已保存到：${qrFile}`);
      await printQrToConsole(qrContent);
      console.log('请使用微信扫描上方二维码，如手机上出现确认提示，请完成确认。');

      const polled = await pollQrcodeStatus(started.cookie, fingerprint);
      console.log('已检测到扫码，正在完成登录...');

      const finalized = await finalizeQrLogin(polled.cookie, fingerprint);
      saveSessionFile(sessionFile, {
        cookie: finalized.cookie,
        token: finalized.token,
        createdAt: now,
        updatedAt: now,
        source: 'login',
      });

      console.log(`登录成功，会话已保存到：${sessionFile}`);
      console.log(`Token：${finalized.token}`);
      console.log(`Redirect URL：${finalized.redirectUrl}`);
    });

  program
    .command('listaccount')
    .description('根据公众号名称搜索公众号候选列表')
    .requiredOption('--nickname <name>', '公众号名称')
    .option('--page <n>', '第几页，从 1 开始', '1')
    .option('--pagesize <n>', '每页拉取的候选公众号数量', '5')
    .option('--output <path>', '将 JSON 结果写入文件')
    .action(async (opts) => {
    const { cookie, token: sessionToken } = resolveSession(opts);
    const nickname = String(opts.nickname).trim();
    const page = Number.parseInt(String(opts.page), 10);
    const pageSize = Number.parseInt(String(opts.pagesize), 10);

    if (!nickname) throw new Error('必须提供 --nickname。');
    if (!Number.isFinite(page) || page <= 0) throw new Error('--page 必须是大于等于 1 的整数。');
    if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('--pagesize 必须是正整数。');
    const begin = (page - 1) * pageSize;

    const token = sessionToken && sessionToken.trim() ? sessionToken.trim() : await inferToken(cookie);
    const payload = await searchOfficial(cookie, token, nickname, begin, pageSize);
    const items = Array.isArray(payload.list) ? payload.list : [];

    const result = {
      ok: true,
      token,
      query: nickname,
      page,
      begin,
      pageSize,
      total: payload.total ?? null,
      itemCount: items.length,
      items,
    };

    const output = JSON.stringify(result, null, 2);
    if (opts.output) {
      fs.writeFileSync(String(opts.output), output + '\n', 'utf8');
      console.log(`已将 ${items.length} 条公众号候选结果写入：${opts.output}`);
      return;
    }
    console.log(output);
  });

  program
    .command('listarticle')
    .description('根据精确 fakeid 拉取公众号文章列表')
    .requiredOption('--fakeid <fakeid>', '公众号 fakeid')
    .option('--page <n>', '第几页，从 1 开始', '1')
    .option('--pagesize <n>', '每页拉取的文章数量，通常 1-5', '5')
    .option('--output <path>', '将 JSON 结果写入文件')
    .action(async (opts) => {
    const { cookie, token: sessionToken } = resolveSession(opts);
    const fakeid = String(opts.fakeid).trim();
    const page = Number.parseInt(String(opts.page), 10);
    const pageSize = Number.parseInt(String(opts.pagesize), 10);
    const delayMs = 800;

    if (!fakeid) throw new Error('必须提供 --fakeid。');
    if (!Number.isFinite(page) || page <= 0) throw new Error('--page 必须是大于等于 1 的整数。');
    if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('--pagesize 必须是正整数。');
    const begin = (page - 1) * pageSize;

    const token = sessionToken && sessionToken.trim() ? sessionToken.trim() : await inferToken(cookie);
    const allItems: AppMsgItem[] = [];
    let totalCount: number | null = null;

    const payload = await listArticlesByFakeid(cookie, token, fakeid, begin, pageSize);
    if (typeof payload.app_msg_cnt === 'number') totalCount = payload.app_msg_cnt;
    const items = Array.isArray(payload.app_msg_list) ? payload.app_msg_list : [];
    allItems.push(...items);

    const result = {
      ok: true,
      token,
      fakeid,
      page,
      begin,
      pageSize,
      totalCount,
      itemCount: allItems.length,
      items: normalizeItems(allItems),
    };

    const output = JSON.stringify(result, null, 2);
    if (opts.output) {
      fs.writeFileSync(String(opts.output), output + '\n', 'utf8');
      console.log(`已将 ${allItems.length} 条文章结果写入：${opts.output}`);
      return;
    }
    console.log(output);
  });

  program
    .command('getarticle')
    .description('根据文章 URL 解析公众号文章正文内容')
    .requiredOption('--url <url>', '公众号文章 URL')
    .option('--cookie <cookie>', '可选：访问文章页时携带的 cookie')
    .option('--output <path>', '将 JSON 结果写入文件')
    .action(async (opts) => {
      const rawUrl = String(opts.url).trim();
      if (!rawUrl) throw new Error('必须提供 --url。');
      if (!/^https?:\/\/mp\.weixin\.qq\.com\//.test(rawUrl)) {
        throw new Error('只支持 mp.weixin.qq.com 的文章 URL。');
      }

      const cookie = resolveOptionalCookie(opts);
      const { html, finalUrl } = await fetchArticleHtml(rawUrl, cookie);
      const result = parseWechatArticle(html, finalUrl);

      const output = JSON.stringify(result, null, 2);
      if (opts.output) {
        fs.writeFileSync(String(opts.output), output + '\n', 'utf8');
        console.log(`已将文章解析结果写入：${opts.output}`);
        return;
      }
      console.log(output);
    });

  program.showHelpAfterError();
  await program.parseAsync(process.argv);
}

await main();
