// 中文品类词 → Steam 标签 ID 的静态兜底表
//
// 为什么需要它：Steam 的标签字典接口（store.steampowered.com/tagdata/populartags/<lang>）
// 会限流（HTTP 429）。一旦拿不到字典，原来的流程会退回「全站热销榜」，
// 于是评估「模拟经营」却抓到《极限竞速》《PUBG》，评分被彻底带偏。
//
// 这里的每一项 tagid 都是直接从 Steam 官方标签字典（schinese）里核对出来的，不是猜的。
// 匹配顺序：靠前的更具体（例如「牌组构建」优先于「卡牌游戏」），命中即返回。
export const GENRE_TAG_RULES = [
  // —— 经营 / 建造 / 模拟（更具体的「农场/城市/基地」放在「模拟经营」之前，避免一律落到宽泛的「管理」）——
  { keys: ['农场', '牧场', '种田', '种植'], tagid: 87918, name: '农场模拟' },
  { keys: ['城市营造', '城市建造', '城市规划'], tagid: 4328, name: '城市营造' },
  { keys: ['基地建设', '基地建造', '殖民地'], tagid: 7332, name: '基地建设' },
  { keys: ['模拟经营', '经营模拟', '商业模拟', '商店经营', '店铺经营', '经营类', '经营'], tagid: 12472, name: '管理' },
  { keys: ['工厂', '自动化', '流水线'], tagid: 255534, name: '自动化' },
  { keys: ['建造', '建筑', '盖房子'], tagid: 1643, name: '建造' },
  { keys: ['生活模拟', '人生模拟', '日常模拟'], tagid: 10235, name: '生活模拟' },
  { keys: ['钓鱼'], tagid: 15564, name: '钓鱼' },
  { keys: ['烹饪', '做饭', '餐厅'], tagid: 3920, name: '烹饪' },
  { keys: ['驾驶', '开车', '卡车'], tagid: 1644, name: '驾驶' },
  { keys: ['飞行', '航空'], tagid: 15045, name: '飞行' },
  { keys: ['太空模拟', '星际模拟'], tagid: 16598, name: '太空模拟' },
  { keys: ['沙盒'], tagid: 3810, name: '沙盒' },
  { keys: ['开放世界'], tagid: 1695, name: '开放世界' },

  // —— 肉鸽 / 卡牌 ——
  { keys: ['幸存者like', '幸存者类', '幸存者', '割草', '吸血鬼like', '弹幕生存'], tagid: 3959, name: '轻度 Rogue' },
  { keys: ['塔防'], tagid: 1645, name: '塔防' },
  { keys: ['自走棋', '自动战斗'], tagid: 1084988, name: '自走棋' },
  { keys: ['肉鸽卡牌', '卡牌肉鸽', 'roguelike卡牌', '卡牌roguelike', '牌组构建', 'deckbuilder', '卡组构建', '构筑'], tagid: 32322, name: '牌组构建' },
  { keys: ['卡牌', '卡牌游戏', 'TCG', 'ccg'], tagid: 1666, name: '卡牌游戏' },
  { keys: ['肉鸽', 'roguelike', 'roguelite', '类rogue', '地牢爬行'], tagid: 1716, name: '类 Rogue' },

  // —— 策略 ——
  { keys: ['大战略'], tagid: 4364, name: '大战略' },
  { keys: ['4X', '4x'], tagid: 1670, name: '4X' },
  { keys: ['即时战略', 'RTS', 'rts'], tagid: 1676, name: '即时战略' },
  { keys: ['即时含暂停', '可暂停'], tagid: 7107, name: '即时含暂停' },
  { keys: ['回合制战术'], tagid: 14139, name: '回合制战术' },
  { keys: ['战术角色扮演', '战棋', 'SRPG', 'srpg'], tagid: 21725, name: '战术角色扮演' },
  { keys: ['回合制', '回合'], tagid: 1677, name: '回合制' },
  { keys: ['策略', '战略'], tagid: 9, name: '策略' },

  // —— RPG ——
  { keys: ['日系角色扮演', 'JRPG', 'jrpg'], tagid: 4434, name: '日系角色扮演' },
  { keys: ['动作角色扮演', 'ARPG', 'arpg'], tagid: 4231, name: '动作角色扮演' },
  { keys: ['角色扮演', 'RPG', 'rpg'], tagid: 122, name: '角色扮演' },

  // —— 射击 / 动作 ——
  { keys: ['撤离射击', '塔科夫like', '搜打撤'], tagid: 1199779, name: '撤离射击' },
  { keys: ['第一人称射击', 'FPS', 'fps'], tagid: 1663, name: '第一人称射击' },
  { keys: ['第三人称射击', 'TPS', 'tps'], tagid: 3814, name: '第三人称射击' },
  { keys: ['双摇杆射击'], tagid: 4758, name: '双摇杆射击' },
  { keys: ['弹幕射击', 'STG', 'stg'], tagid: 4885, name: '弹幕射击' },
  { keys: ['射击'], tagid: 1774, name: '射击' },
  { keys: ['清版动作', 'ACT'], tagid: 4158, name: '清版动作' },
  { keys: ['砍杀', '割草动作'], tagid: 1646, name: '砍杀' },
  { keys: ['平台游戏', 'platformer', '平台跳跃'], tagid: 1625, name: '平台游戏' },
  { keys: ['横向滚屏', '横版'], tagid: 3798, name: '横向滚屏' },

  // —— 恐怖 / 解谜 ——
  { keys: ['生存恐怖'], tagid: 3978, name: '生存恐怖' },
  { keys: ['恐怖', '惊悚'], tagid: 1667, name: '恐怖' },
  { keys: ['密室逃脱'], tagid: 769306, name: '密室逃脱' },
  { keys: ['悬疑'], tagid: 5716, name: '悬疑' },
  { keys: ['推理'], tagid: 5613, name: '推理' },
  { keys: ['解谜', '推箱子', '谜题'], tagid: 1664, name: '解谜' },
  { keys: ['三消', '消除'], tagid: 1665, name: '三消' },

  // —— 生存 / 放置 ——
  { keys: ['开放世界生存制作', '生存制作'], tagid: 1100689, name: '开放世界生存制作' },
  { keys: ['生存'], tagid: 1662, name: '生存' },
  { keys: ['放置', '挂机', 'idle', 'incremental'], tagid: 615955, name: '挂机游戏' },
  { keys: ['增量', '点击器', 'clicker'], tagid: 560542, name: '增量' },

  // —— 叙事 ——
  { keys: ['视觉小说', 'galgame', 'AVG'], tagid: 3799, name: '视觉小说' },
  { keys: ['恋爱模拟', '恋爱'], tagid: 9551, name: '恋爱模拟' },
  { keys: ['互动小说', '互动剧'], tagid: 11014, name: '互动小说' },
  { keys: ['多结局'], tagid: 6971, name: '多结局' },
  { keys: ['选择取向', '选择导向'], tagid: 6426, name: '选择取向' },
  { keys: ['剧情丰富'], tagid: 1742, name: '剧情丰富' },

  // —— 其他常见 ——
  { keys: ['音乐游戏', '音游', '节奏'], tagid: 1752, name: '节奏' },
  { keys: ['竞速', '赛车'], tagid: 699, name: '竞速' },
  { keys: ['体育', '足球', '篮球'], tagid: 701, name: '体育' },
  { keys: ['桌游', '棋盘', '麻将', '棋类'], tagid: 1770, name: '棋盘游戏' },
  { keys: ['武侠'], tagid: 25959, name: '武侠' },
  { keys: ['仙侠', '修仙'], tagid: 760247, name: '仙侠' },
  { keys: ['像素'], tagid: 3964, name: '像素图形' },
  { keys: ['休闲'], tagid: 597, name: '休闲' },
  { keys: ['独立'], tagid: 492, name: '独立' },
];

/** 从品类描述里匹配静态标签兜底（返回 null 表示未命中） */
export function matchGenreTag(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return null;
  for (const rule of GENRE_TAG_RULES) {
    for (const k of rule.keys) {
      if (hay.includes(String(k).toLowerCase())) return { tagid: String(rule.tagid), name: rule.name, matchedKey: k };
    }
  }
  return null;
}
