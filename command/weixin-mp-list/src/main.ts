#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

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

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
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
    .description('MVP：查询微信公众号候选列表与文章列表');

  const applySessionOptions = (command: Command): Command =>
    command
      .option('--session-file <path>', '本地会话 JSON 文件路径', DEFAULT_SESSION_FILE)
      .option('--cookie <cookie>', '覆盖默认的 mp.weixin.qq.com 登录 cookie')
      .option('--token <token>', '覆盖默认的 mp.weixin.qq.com 后台 token');

  program
    .command('login')
    .description('扫码登录 mp.weixin.qq.com，并将 cookie/token 保存到本地 JSON 文件')
    .option('--session-file <path>', '本地会话 JSON 文件路径', DEFAULT_SESSION_FILE)
    .option('--qr-file <path>', '本地二维码图片路径', DEFAULT_QR_FILE)
    .option('--cookie <cookie>', '在开始扫码前先校验并保存已有 cookie')
    .option('--token <token>', '与已有 cookie 配套的 token')
    .action(async (opts) => {
      const sessionFile = path.resolve(String(opts.sessionFile || DEFAULT_SESSION_FILE));
      const qrFile = path.resolve(String(opts.qrFile || DEFAULT_QR_FILE));
      const sessionId = randomSessionId();
      const fingerprint = randomFingerprint();
      const now = new Date().toISOString();

      if (typeof opts.cookie === 'string' && opts.cookie.trim()) {
        const validation = await validateSession(opts.cookie.trim(), opts.token);
        if (validation.ok) {
          saveSessionFile(sessionFile, {
            cookie: opts.cookie.trim(),
            token: validation.token,
            createdAt: now,
            updatedAt: now,
            source: 'login',
          });
          console.log(`已经登录，当前 cookie 有效。会话已保存到：${sessionFile}`);
          console.log(`Token：${validation.token}`);
          return;
        }
        console.log(`已有 cookie 无效（${validation.reason ?? '未知错误'}），开始扫码登录。`);
      } else if (fs.existsSync(sessionFile)) {
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

  applySessionOptions(
    program
      .command('listaccount')
      .description('根据公众号名称搜索公众号候选列表')
      .requiredOption('--nickname <name>', 'public account nickname to search')
      .option('--begin <n>', '搜索结果偏移量', '0')
      .option('--count <n>', '拉取候选公众号数量', '5')
      .option('--output <path>', '将 JSON 结果写入文件'),
  ).action(async (opts) => {
    const { cookie, token: sessionToken } = resolveSession(opts);
    const nickname = String(opts.nickname).trim();
    const begin = Number.parseInt(String(opts.begin), 10);
    const count = Number.parseInt(String(opts.count), 10);

    if (!nickname) throw new Error('必须提供 --nickname。');
    if (!Number.isFinite(begin) || begin < 0) throw new Error('--begin 必须是大于等于 0 的整数。');
    if (!Number.isFinite(count) || count <= 0) throw new Error('--count 必须是正整数。');

    const token = sessionToken && sessionToken.trim() ? sessionToken.trim() : await inferToken(cookie);
    const payload = await searchOfficial(cookie, token, nickname, begin, count);
    const items = Array.isArray(payload.list) ? payload.list : [];

    const result = {
      ok: true,
      token,
      query: nickname,
      begin,
      total: payload.total ?? null,
      count: items.length,
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

  applySessionOptions(
    program
      .command('listarticle')
      .description('根据精确 fakeid 拉取公众号文章列表')
      .requiredOption('--fakeid <fakeid>', '公众号 fakeid')
      .option('--begin <n>', '起始偏移量', '0')
      .option('--count <n>', '每页拉取数量，通常 1-5', '5')
      .option('--pages <n>', '拉取页数', '1')
      .option('--delay-ms <n>', '分页之间的延迟毫秒数', '800')
      .option('--output <path>', '将 JSON 结果写入文件'),
  ).action(async (opts) => {
    const { cookie, token: sessionToken } = resolveSession(opts);
    const fakeid = String(opts.fakeid).trim();
    const begin = Number.parseInt(String(opts.begin), 10);
    const count = Number.parseInt(String(opts.count), 10);
    const pages = Number.parseInt(String(opts.pages), 10);
    const delayMs = Number.parseInt(String(opts['delayMs']), 10);

    if (!fakeid) throw new Error('必须提供 --fakeid。');
    if (!Number.isFinite(begin) || begin < 0) throw new Error('--begin 必须是大于等于 0 的整数。');
    if (!Number.isFinite(count) || count <= 0) throw new Error('--count 必须是正整数。');
    if (!Number.isFinite(pages) || pages <= 0) throw new Error('--pages 必须是正整数。');
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('--delay-ms 必须是大于等于 0 的整数。');

    const token = sessionToken && sessionToken.trim() ? sessionToken.trim() : await inferToken(cookie);
    const allItems: AppMsgItem[] = [];
    let totalCount: number | null = null;

    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      const offset = begin + pageIndex * count;
      const payload = await listArticlesByFakeid(cookie, token, fakeid, offset, count);
      if (typeof payload.app_msg_cnt === 'number') totalCount = payload.app_msg_cnt;
      const items = Array.isArray(payload.app_msg_list) ? payload.app_msg_list : [];
      allItems.push(...items);
      if (items.length < count) break;
      if (pageIndex < pages - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const result = {
      ok: true,
      token,
      fakeid,
      totalCount,
      count: allItems.length,
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

  program.showHelpAfterError();
  await program.parseAsync(process.argv);
}

await main();
