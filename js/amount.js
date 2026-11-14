// 分量の読み取りと換算
// 「200g」「大さじ1と1/2」「1/2個」「少々」などを読み取り、人数に合わせて換算する。

const NON_SCALABLE = ['少々', '適量', '適宜', 'ひとつまみ', '少量', 'お好みで', 'お好み', '各少々', 'たっぷり', '適当'];
const SPOON_UNITS = ['大さじ', '小さじ', 'カップ'];
const SPOON_ALIASES = { '大匙': '大さじ', '小匙': '小さじ', 'おおさじ': '大さじ', 'こさじ': '小さじ', 'cup': 'カップ' };
const WEIGHT_UNITS = /^(g|kg|ml|cc|l|グラム|ミリリットル)$/i;

const NUM = '(\\d+(?:\\.\\d+)?と\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';

// 全角→半角、½などをそろえる
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/⁄/g, '/')          // ½ → 1⁄2 の分数スラッシュ
    .replace(/[〜～]/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNum(s) {
  s = String(s);
  let m = s.match(/^(\d+(?:\.\d+)?)と(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  return Number(s);
}

function canonicalUnit(u) {
  return SPOON_ALIASES[u] ?? u;
}

/**
 * 分量の文字列を読み取る
 * @returns {{quantity:number|null, unit:string|null, scalable:boolean, text:string}}
 */
export function parseAmount(input) {
  const text = normalizeText(input);
  const none = { quantity: null, unit: null, scalable: false, text };
  if (!text) return none;
  if (NON_SCALABLE.some(w => text === w || text.startsWith(w))) return none;
  if (/\d\s*[~-]\s*\d/.test(text)) return none;   // 「2~3個」のような幅は換算しない

  // 大さじ1/2、小さじ1と1/2、カップ1
  let m = text.match(new RegExp(`^(大さじ|小さじ|大匙|小匙|カップ|cup)\\s*${NUM}\\s*(杯)?(.*)$`, 'i'));
  if (m) {
    return { quantity: parseNum(m[2]), unit: canonicalUnit(m[1]), scalable: true, text };
  }

  // 200g、2個、1/2本、1片(10g)
  m = text.match(new RegExp(`^${NUM}\\s*(.*)$`));
  if (m) {
    const rest = m[2].trim();
    // 単位はかっこの前まで（「1片(10g)」→「片」）
    const unit = rest.split(/[(（]/)[0].trim() || null;
    return { quantity: parseNum(m[1]), unit, scalable: true, text };
  }

  return none;
}

function roundTo(x, step) {
  return Math.round(x / step) * step;
}

// 0.5 → 1/2、1.75 → 1と3/4
export function fractionLabel(x) {
  const whole = Math.floor(x + 1e-9);
  const rem = Math.round((x - whole) * 100) / 100;
  const fracs = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' };
  const f = fracs[rem];
  if (!f) return String(Math.round(x * 100) / 100);
  if (whole === 0) return f;
  return `${whole}と${f}`;
}

/**
 * 換算した分量を表示用の文字列にする
 * @param {{quantity:number|null, unit:string|null, scalable:boolean, quantity_text:string|null}} ing
 * @param {number} factor 表示人数 ÷ 基準人数
 */
export function formatAmount(ing, factor) {
  const original = ing.quantity_text ?? '';
  if (!ing.scalable || ing.quantity == null || Math.abs(factor - 1) < 1e-9) return original;

  const q = Number(ing.quantity) * factor;
  const u = ing.unit ?? '';

  if (SPOON_UNITS.includes(u)) {
    const r = Math.max(roundTo(q, 0.25), 0.25);
    return u + fractionLabel(r);
  }
  if (WEIGHT_UNITS.test(u)) {
    let r;
    if (q < 1) r = Math.round(q * 10) / 10;
    else if (q < 10) r = Math.round(q);
    else r = roundTo(q, 5);
    return `${r}${u}`;
  }
  // 個・本・枚・片など、単位なしも含めて 1/2 単位
  const r = Math.max(roundTo(q, 0.5), 0.5);
  return fractionLabel(r) + u;
}

/**
 * 「豚こま切れ肉 200g」のような1行を、グループ・材料名・分量に分ける
 * （URL取り込みや、まとめて貼り付けで使う）
 */
export function splitIngredientLine(line) {
  let s = normalizeText(line).replace(/^[・\-*●○◯■□◆◇]\s*/, '');
  let group_label = '';

  // 先頭の (A) 【A】 A: ★ などをグループとして扱う
  const g = s.match(/^(?:[(【\[〈<]\s*([A-Za-z★☆◎]|[0-9])\s*[)】\]〉>]|([A-Za-z★☆◎])\s*[:：.、]|([★☆◎]))\s*/);
  if (g) {
    group_label = g[1] || g[2] || g[3] || '';
    s = s.slice(g[0].length);
  }

  // 末尾の分量を探す
  const amountRe = new RegExp(
    `^(.*?)\\s*((?:大さじ|小さじ|大匙|小匙|カップ)\\s*${NUM}.*|${NUM}\\s*[^\\d\\s]*.*|(?:${NON_SCALABLE.join('|')}).*)$`
  );
  const lastSpace = s.lastIndexOf(' ');
  if (lastSpace > 0) {
    const name = s.slice(0, lastSpace).trim();
    const amount = s.slice(lastSpace + 1).trim();
    if (parseAmount(amount).quantity != null || NON_SCALABLE.some(w => amount.startsWith(w))) {
      return { group_label, name, amount, note: '' };
    }
  }
  const m = s.match(amountRe);
  if (m && m[1]) return { group_label, name: m[1].trim(), amount: m[2].trim(), note: '' };
  return { group_label, name: s, amount: '', note: '' };
}
