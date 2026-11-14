-- =============================================================
-- レシピを材料・手順・タグごとまとめて保存する関数
-- 001・002 を実行した後に、SQL Editor で実行してください。
-- 画面からは supabase.rpc('save_recipe', { p: {...} }) で呼びます。
-- 途中で失敗したときは全部取り消されるので、材料だけ消える、などが起きません。
-- =============================================================
create or replace function public.save_recipe(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rid uuid := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
begin
  if not public.is_member() then
    raise exception 'not a family member';
  end if;

  if coalesce(trim(p->>'title'), '') = '' then
    raise exception 'title is required';
  end if;

  -- レシピ本体（新規なら追加、既存なら更新）
  insert into public.recipes as r
    (id, title, servings_base, category, cook_time_min,
     source_type, source_url, source_name, family_note)
  values (
    rid,
    trim(p->>'title'),
    coalesce(nullif(p->>'servings_base', '')::numeric, 2),
    coalesce(nullif(p->>'category', ''), 'その他'),
    nullif(p->>'cook_time_min', '')::integer,
    coalesce(nullif(p->>'source_type', ''), 'original'),
    nullif(trim(p->>'source_url'), ''),
    nullif(trim(p->>'source_name'), ''),
    nullif(p->>'family_note', '')
  )
  on conflict (id) do update set
    title         = excluded.title,
    servings_base = excluded.servings_base,
    category      = excluded.category,
    cook_time_min = excluded.cook_time_min,
    source_type   = excluded.source_type,
    source_url    = excluded.source_url,
    source_name   = excluded.source_name,
    family_note   = excluded.family_note;

  -- 材料：いったん消して入れ直す
  delete from public.ingredients where recipe_id = rid;
  insert into public.ingredients
    (recipe_id, sort_order, group_label, name, name_kana,
     quantity, quantity_text, unit, scalable, note)
  select
    rid,
    (x.ord - 1)::integer,
    nullif(trim(x.v->>'group_label'), ''),
    trim(x.v->>'name'),
    nullif(trim(x.v->>'name_kana'), ''),
    nullif(x.v->>'quantity', '')::numeric,
    nullif(trim(x.v->>'quantity_text'), ''),
    nullif(trim(x.v->>'unit'), ''),
    coalesce((x.v->>'scalable')::boolean, false),
    nullif(trim(x.v->>'note'), '')
  from jsonb_array_elements(coalesce(p->'ingredients', '[]'::jsonb)) with ordinality as x(v, ord)
  where coalesce(trim(x.v->>'name'), '') <> '';

  -- 手順：いったん消して入れ直す（文字列の配列）
  delete from public.steps where recipe_id = rid;
  insert into public.steps (recipe_id, step_no, text)
  select rid, row_number() over (order by s.ord)::integer, trim(s.t)
  from jsonb_array_elements_text(coalesce(p->'steps', '[]'::jsonb)) with ordinality as s(t, ord)
  where trim(s.t) <> '';

  -- タグ：なければ作り、紐づけを入れ直す（文字列の配列）
  insert into public.tags (name)
  select distinct trim(t)
  from jsonb_array_elements_text(coalesce(p->'tags', '[]'::jsonb)) as t
  where trim(t) <> ''
  on conflict (name) do nothing;

  delete from public.recipe_tags where recipe_id = rid;
  insert into public.recipe_tags (recipe_id, tag_id)
  select rid, tg.id
  from public.tags tg
  where tg.name in (
    select trim(t)
    from jsonb_array_elements_text(coalesce(p->'tags', '[]'::jsonb)) as t
    where trim(t) <> ''
  );

  return rid;
end;
$$;

revoke execute on function public.save_recipe(jsonb) from public, anon;
grant execute on function public.save_recipe(jsonb) to authenticated;
