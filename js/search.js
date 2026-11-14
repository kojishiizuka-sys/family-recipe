// 検索：表記ゆれをそろえ、同じ意味の言葉で広げる

// 全角→半角、カタカナ→ひらがな、英字は小文字に
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** synonyms の行 [{group_key, word}] から、検索語 → 探す言葉の一覧 を作る */
export function buildSynonymMap(rows) {
  const map = new Map();
  for (const { group_key, word } of rows ?? []) {
    const k = normalize(group_key);
    if (!map.has(k)) map.set(k, new Set([k]));
    map.get(k).add(normalize(word));
  }
  return map;
}

/**
 * レシピが検索語に当たるか
 * 空白で区切った言葉は「すべて含む」で絞り込む
 */
export function matchRecipe(recipe, query, synonymMap) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = normalize([
    recipe.title,
    ...(recipe.ingredients ?? []).map(i => i.name),
    ...(recipe.tags ?? []),
  ].join('\n'));
  return tokens.every(tok => {
    const terms = synonymMap?.get(tok) ?? new Set([tok]);
    for (const t of terms) if (hay.includes(t)) return true;
    return false;
  });
}
