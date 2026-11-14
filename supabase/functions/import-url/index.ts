// =============================================================
// import-url：レシピページのURLから、レシピ名・人数・材料・手順を読み取る
// ページ内の構造化データ（schema.org の Recipe 形式）を探して返します。
// 家族（members）としてログインしている人だけが使えます。
// =============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- 構造化データの中から Recipe を探す ----
function isRecipe(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  const t = o["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}

function findRecipe(node: any): any | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (isRecipe(node)) return node;
  if (node["@graph"]) return findRecipe(node["@graph"]);
  if (node.mainEntity) return findRecipe(node.mainEntity);
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function toText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return decodeEntities(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return toText(v[0]);
  if (typeof v === "object") return toText(v.text ?? v.name ?? "");
  return "";
}

// 手順は文字列・HowToStep・HowToSection が混ざることがあるので平らにする
function flattenSteps(v: any): string[] {
  if (v == null) return [];
  if (typeof v === "string") {
    return decodeEntities(v.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"))
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) return v.flatMap(flattenSteps);
  if (typeof v === "object") {
    if (v.itemListElement) return flattenSteps(v.itemListElement);
    const t = toText(v.text ?? v.name);
    return t ? [t] : [];
  }
  return [];
}

function imageUrl(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return imageUrl(v[0]);
  if (typeof v === "object") return v.url ?? null;
  return null;
}

function servingsFrom(v: any): number | null {
  const s = toText(Array.isArray(v) ? v.join(" ") : v).normalize("NFKC");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function siteNameOf(html: string, url: URL): string {
  const m = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
  );
  return m ? decodeEntities(m[1]) : url.hostname;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // 家族かどうかを確認（ログイン中の人の権限で is_member を呼ぶ）
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: ok, error: authErr } = await sb.rpc("is_member");
    if (authErr || !ok) return json({ error: "not_member" }, 403);

    const body = await req.json().catch(() => ({}));
    let url: URL;
    try {
      url = new URL(String(body.url ?? ""));
    } catch {
      return json({ error: "bad_url" }, 400);
    }
    if (!/^https?:$/.test(url.protocol)) return json({ error: "bad_url" }, 400);

    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept-Language": "ja,en;q=0.8",
      },
    });
    if (!res.ok) return json({ error: "fetch_failed", status: res.status }, 422);
    const html = await res.text();

    // <script type="application/ld+json"> を全部見て Recipe を探す
    let recipe: any = null;
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const m of html.matchAll(re)) {
      try {
        recipe = findRecipe(JSON.parse(m[1].trim()));
      } catch {
        // 壊れたJSONは飛ばす
      }
      if (recipe) break;
    }
    if (!recipe) return json({ error: "no_recipe" }, 422);

    const ingredients = (Array.isArray(recipe.recipeIngredient)
      ? recipe.recipeIngredient
      : recipe.recipeIngredient ? [recipe.recipeIngredient] : [])
      .map((s: any) => toText(s))
      .filter(Boolean);

    return json({
      title: toText(recipe.name),
      servings: servingsFrom(recipe.recipeYield),
      ingredients,
      steps: flattenSteps(recipe.recipeInstructions),
      image: imageUrl(recipe.image),
      siteName: siteNameOf(html, url),
    });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
