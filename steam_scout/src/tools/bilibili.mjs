// B 站数据工具：wbi 签名 + 视频列表/详情/字幕/评论/搜索
import crypto from 'node:crypto';
import { CONFIG } from '../config.mjs';
import { fetchJson, fetchText, truncate, decodeEntities, htmlToText, sleep } from '../util.mjs';

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class Bili {
  constructor() {
    this.cookie = '';
    this.imgKey = '';
    this.subKey = '';
    this.keysAt = 0;
    this.lastCall = 0;
    this.cooldownUntil = 0;
  }

  /** 限流门：单次调用间隔 + 风控冷却 */
  async gate() {
    const wait = Math.max(this.lastCall + 500 - Date.now(), this.cooldownUntil - Date.now());
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }

  /** 命中风控：进入 45 秒冷却，避免连续触发 */
  risk() {
    this.cooldownUntil = Date.now() + 45000;
  }

  baseHeaders() {
    return {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...(this.cookie ? { cookie: this.cookie } : {}),
    };
  }

  async ensureKeys() {
    if (this.imgKey && Date.now() - this.keysAt < 3600000) return;
    if (!this.cookie) {
      try {
        const spi = await fetchJson('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA } });
        if (spi?.data?.b_3) {
          this.cookie = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4}; b_nut=${Math.round(Date.now() / 1000)};`;
        }
      } catch { /* cookie 可选 */ }
    }
    const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav', { headers: this.baseHeaders() });
    const w = nav?.data?.wbi_img;
    if (w?.img_url && w?.sub_url) {
      this.imgKey = w.img_url.split('/').pop().split('.')[0];
      this.subKey = w.sub_url.split('/').pop().split('.')[0];
      this.keysAt = Date.now();
    } else {
      throw new Error('B站 wbi 密钥获取失败（可能被风控，稍后重试）');
    }
  }

  mixinKey() {
    const k = this.imgKey + this.subKey;
    return MIXIN.map((i) => k[i]).join('').slice(0, 32);
  }

  async wbi(path, params, tries = 3) {
    await this.ensureKeys();
    for (let i = 0; i < tries; i++) {
      await this.gate();
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).replace(/[!'()*]/g, '')]));
      p.wts = Math.round(Date.now() / 1000);
      const query = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&');
      p.w_rid = crypto.createHash('md5').update(query + this.mixinKey()).digest('hex');
      try {
        const j = await fetchJson(`https://api.bilibili.com${path}?${query}&w_rid=${p.w_rid}`, { headers: this.baseHeaders() });
        if ((j.code === -352 || j.code === -412 || j.code === -799) && i < tries - 1) { this.risk(); await sleep(j.code === -799 ? 12000 : 3000); continue; }
        if (j.code !== 0) throw new Error(`B站接口错误 code=${j.code} ${j.message || ''}`);
        return j.data;
      } catch (e) {
        if (i < tries - 1 && /412|352|799|风控|频率|不是合法 JSON/.test(String(e.message || e))) { this.risk(); await sleep(6000); continue; }
        throw e;
      }
    }
    throw new Error('B站接口多次重试后仍被风控拦截');
  }

  async get(path, params = {}, tries = 3) {
    for (let i = 0; i < tries; i++) {
      await this.gate();
      const qs = new URLSearchParams(params).toString();
      try {
        const j = await fetchJson(`https://api.bilibili.com${path}${qs ? '?' + qs : ''}`, { headers: this.baseHeaders() });
        if ((j.code === -352 || j.code === -412 || j.code === -799) && i < tries - 1) { this.risk(); await sleep(j.code === -799 ? 12000 : 3000); continue; }
        if (j.code !== 0) throw new Error(`B站接口错误 code=${j.code} ${j.message || ''}`);
        return j.data;
      } catch (e) {
        if (i < tries - 1 && /412|352|799|风控|频率|不是合法 JSON/.test(String(e.message || e))) { this.risk(); await sleep(6000); continue; }
        throw e;
      }
    }
    throw new Error('B站接口多次重试后仍被风控拦截');
  }
}

export const bili = new Bili();

// ---------- 数据能力 ----------

export async function upInfo(mid) {
  const d = await bili.get('/x/web-interface/card', { mid });
  const c = d.card ?? {};
  return { mid: c.mid, name: c.name, sign: c.sign ?? '', fans: c.fans ?? 0, face: c.face ?? '', official: c.official?.title ?? '' };
}

export async function upVideos(mid, { limit = 200, ps = 50 } = {}) {
  const videos = [];
  let pn = 1;
  while (videos.length < limit) {
    let d = null;
    try {
      d = await bili.wbi('/x/space/wbi/arc/search', { mid, ps, pn, order: 'pubdate' });
    } catch (e) {
      // 回退：非 wbi 版本（风控策略不同，偶尔可用）
      d = await bili.get('/x/space/arc/search', { mid, ps, pn, order: 'pubdate' });
    }
    const list = d?.list?.vlist ?? [];
    if (!list.length) break;
    for (const v of list) {
      videos.push({
        bvid: v.bvid,
        title: v.title,
        desc: truncate(v.description ?? '', 300),
        created: v.created,
        play: v.play ?? 0,
        danmaku: v.video_review ?? 0,
        comment: v.comment ?? 0,
        length: v.length ?? '',
      });
    }
    if (videos.length >= limit || list.length < ps) break;
    pn++;
    await sleep(500);
  }
  return videos;
}

/** 分 P 列表（非 wbi，风控更宽松）：拿 cid */
export async function videoCid(bvid) {
  const d = await bili.get('/x/player/pagelist', { bvid });
  const pages = Array.isArray(d) ? d : [];
  return pages.length ? pages[0].cid : null;
}

export async function videoInfo(bvid) {
  try {
    const d = await bili.wbi('/x/web-interface/wbi/view', { bvid });
    return {
      bvid: d.bvid,
      aid: d.aid,
      cid: d.cid,
      title: d.title,
      desc: truncate(d.desc ?? '', 600),
      pubdate: d.pubdate,
      duration: d.duration,
      stat: d.stat ?? {},
      owner: d.owner ? { mid: d.owner.mid, name: d.owner.name } : null,
      tname: d.tname ?? '',
    };
  } catch {
    // 回退：pagelist(cid) + archive/stat(数据)
    const [cid, stat] = await Promise.all([
      videoCid(bvid).catch(() => null),
      bili.get('/x/web-interface/archive/stat', { bvid }).catch(() => null),
    ]);
    return {
      bvid,
      aid: null,
      cid,
      title: '',
      desc: '',
      pubdate: null,
      duration: null,
      stat: stat ?? {},
      owner: null,
      tname: '',
      degraded: true,
    };
  }
}

export async function videoTags(bvid) {
  try {
    const d = await bili.get('/x/tag/archive/tags', { bvid });
    return (d ?? []).map((t) => t.tag_name);
  } catch { return []; }
}

export async function videoSubtitle(bvid, maxLines = 800) {
  const info = await videoInfo(bvid);
  if (!info.cid) return { bvid, subtitle: null, note: '无法获取 cid（风控或视频异常）' };
  let list = [];
  try {
    const p = await bili.wbi('/x/player/wbi/v2', { bvid, cid: info.cid });
    list = p?.subtitle?.subtitles ?? [];
  } catch { return { bvid, subtitle: null, note: '字幕接口被风控拦截' }; }
  if (!list.length) return { bvid, subtitle: null, note: '该视频无字幕' };
  const zh = list.find((s) => s.lan === 'zh-CN') || list.find((s) => String(s.lan).startsWith('zh')) || list[0];
  let url = zh.subtitle_url;
  if (url.startsWith('//')) url = 'https:' + url;
  const j = await fetchJson(url, { headers: bili.baseHeaders() });
  const lines = (j.body ?? []).slice(0, maxLines).map((l) => l.content ?? '').join('\n');
  return { bvid, subtitle: truncate(lines, 6000), lang: zh.lan };
}

export async function videoComments(bvid, limit = 20) {
  const info = await videoInfo(bvid);
  if (!info.aid) return { bvid, note: '评论获取需要 aid（被风控时自动跳过）', replies: [] };
  const d = await bili.get('/x/v2/reply', { type: 1, oid: info.aid, sort: 2, ps: Math.min(limit, 50) });
  const replies = (d?.replies ?? []).slice(0, limit).map((r) => ({
    user: r.member?.uname ?? '',
    like: r.like ?? 0,
    message: truncate(decodeEntities(htmlToText(r.content?.message ?? '', 300)), 300),
  }));
  return { bvid, count: d?.cursor?.all_count ?? replies.length, replies };
}

export async function searchVideos(keyword, limit = 10) {
  const d = await bili.get('/x/web-interface/search/type', { search_type: 'video', keyword, page_size: Math.min(limit, 50) });
  const videos = (d?.result ?? []).slice(0, limit).map((v) => ({
    bvid: v.bvid,
    title: decodeEntities(htmlToText(v.title ?? '', 150)),
    author: v.author ?? '',
    play: v.play ?? 0,
    danmaku: v.video_review ?? 0,
    pubdate: v.pubdate,
    duration: v.duration ?? '',
    desc: truncate(v.description ?? '', 200),
  }));
  return { keyword, count: videos.length, videos };
}

// ---------- 工具注册 ----------

export const biliTools = [
  {
    name: 'bili_up_videos',
    description: `获取 B 站 UP 主「Gaby学姐说」等作者的视频列表（标题/简介/播放量/日期）。默认 mid=${CONFIG.upMid}（Steam 独立游戏市场分析 UP 主）。`,
    parameters: { type: 'object', properties: { mid: { type: 'string', description: 'UP 主 mid' }, limit: { type: 'integer', description: '最多返回条数，默认30' } }, required: [] },
    handler: async (a) => {
      const mid = a.mid ?? CONFIG.upMid;
      const [up, videos] = await Promise.all([upInfo(mid).catch(() => null), upVideos(mid, { limit: a.limit ?? 30 })]);
      return { up, videos };
    },
  },
  {
    name: 'bili_video_info',
    description: '获取单个 B 站视频的详情（完整简介、播放/点赞/投币数据、UP 主、分区）。',
    parameters: { type: 'object', properties: { bvid: { type: 'string', description: '视频 BV 号' } }, required: ['bvid'] },
    handler: async (a) => videoInfo(a.bvid),
  },
  {
    name: 'bili_video_subtitle',
    description: '获取 B 站视频的 AI 字幕全文（用于深入理解视频内容，如案例拆解、方法论讲解）。',
    parameters: { type: 'object', properties: { bvid: { type: 'string' }, max_lines: { type: 'integer' } }, required: ['bvid'] },
    handler: async (a) => videoSubtitle(a.bvid, a.max_lines ?? 800),
  },
  {
    name: 'bili_video_comments',
    description: '获取 B 站视频热门评论（了解观众反馈与讨论焦点）。',
    parameters: { type: 'object', properties: { bvid: { type: 'string' }, limit: { type: 'integer' } }, required: ['bvid'] },
    handler: async (a) => videoComments(a.bvid, a.limit ?? 20),
  },
  {
    name: 'bili_search',
    description: '搜索 B 站视频（中文游戏圈内容的最佳来源：评测、案例、趋势讨论）。返回标题/UP主/播放量/简介。',
    parameters: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'integer', description: '默认10' } }, required: ['keyword'] },
    handler: async (a) => searchVideos(a.keyword, a.limit ?? 10),
  },
];
