-- =============================================================
-- 家族の定番レシピアプリ  テーブル定義（Supabase / Postgres）
-- 使い方：Supabaseダッシュボード → SQL Editor → このファイルを貼り付けて Run
-- 実行前に、一番下の「家族3人のメールアドレス」を書き換えてください。
-- =============================================================

-- -------------------------------------------------------------
-- members：使うことを許可した家族（メールアドレスで判定）
-- -------------------------------------------------------------
create table public.members (
  email        text primary key,          -- Googleアカウントのメールアドレス
  display_name text not null,             -- 画面に出す名前
  user_id      uuid unique,               -- 初回ログイン時に画面側で自分のIDを登録
  created_at   timestamptz not null default now()
);

-- ログイン中の人が家族（members）に含まれるかを判定する関数
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- -------------------------------------------------------------
-- 更新日・更新者を自動で入れるトリガー
-- -------------------------------------------------------------
create or replace function public.set_updated()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- recipes：レシピ
-- -------------------------------------------------------------
create table public.recipes (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  servings_base  numeric not null default 2 check (servings_base > 0),
  category       text not null default 'その他'
                 check (category in ('主菜','副菜','汁物','ご飯・麺・パン','おやつ','その他')),
  cook_time_min  integer check (cook_time_min is null or cook_time_min >= 0),
  source_type    text not null default 'original'
                 check (source_type in ('url','photo','book','original')),
  source_url     text,
  source_name    text,                    -- 書名とページ、サイト名など
  family_note    text,                    -- 我が家メモ・アレンジ
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid(),
  deleted_at     timestamptz              -- 空なら有効、日時が入っていればゴミ箱
);

create trigger recipes_set_updated
  before update on public.recipes
  for each row execute function public.set_updated();

-- -------------------------------------------------------------
-- ingredients：材料（1材料1行）
-- -------------------------------------------------------------
create table public.ingredients (
  id             uuid primary key default gen_random_uuid(),
  recipe_id      uuid not null references public.recipes(id) on delete cascade,
  sort_order     integer not null default 0,
  group_label    text,                    -- A、Bなど（任意）
  name           text not null,           -- 表示用の材料名
  name_kana      text,                    -- 検索用の読み（ひらがな）
  quantity       numeric,                 -- 少々・適量などは空
  quantity_text  text,                    -- 元の表記（「1/2」「少々」など）
  unit           text,                    -- g、ml、大さじ、小さじ、個、本、枚、カップなど
  scalable       boolean not null default true,  -- 分量換算するか
  note           text
);
create index ingredients_recipe_id_idx on public.ingredients (recipe_id);

-- -------------------------------------------------------------
-- steps：作り方（1手順1行）
-- -------------------------------------------------------------
create table public.steps (
  id         uuid primary key default gen_random_uuid(),
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  step_no    integer not null,
  text       text not null
);
create index steps_recipe_id_idx on public.steps (recipe_id);

-- -------------------------------------------------------------
-- recipe_images：写真（元のレシピの写真・スクショ／完成写真）
-- -------------------------------------------------------------
create table public.recipe_images (
  id            uuid primary key default gen_random_uuid(),
  recipe_id     uuid not null references public.recipes(id) on delete cascade,
  kind          text not null check (kind in ('source','finished')),
  storage_path  text not null,            -- Storage（recipe-images）上の場所
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index recipe_images_recipe_id_idx on public.recipe_images (recipe_id);

-- -------------------------------------------------------------
-- tags / recipe_tags：自由なタグ（作り置き、お弁当など）
-- -------------------------------------------------------------
create table public.tags (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique
);

create table public.recipe_tags (
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  tag_id     uuid not null references public.tags(id) on delete cascade,
  primary key (recipe_id, tag_id)
);

-- -------------------------------------------------------------
-- cook_logs：作った記録（「作った！」ボタン1回 = 1行）
-- -------------------------------------------------------------
create table public.cook_logs (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes(id) on delete cascade,
  cooked_on   date not null default current_date,
  cooked_by   uuid not null default auth.uid(),
  servings    numeric check (servings is null or servings > 0),
  memo        text,
  created_at  timestamptz not null default now()
);
create index cook_logs_recipe_id_idx on public.cook_logs (recipe_id);

-- 作った回数・最後に作った日（cook_logs から集計）
create view public.recipe_stats
with (security_invoker = true)
as
select
  r.id               as recipe_id,
  count(c.id)        as cook_count,
  max(c.cooked_on)   as last_cooked_on
from public.recipes r
left join public.cook_logs c on c.recipe_id = r.id
group by r.id;

-- -------------------------------------------------------------
-- synonyms：検索用の同じ意味の言葉
--   group_key で検索したとき、同じ group_key の word を含む材料も見つける
--   （例：「豚肉」で検索 → 豚こま、豚バラ… も当たる）
-- -------------------------------------------------------------
create table public.synonyms (
  id         uuid primary key default gen_random_uuid(),
  group_key  text not null,
  word       text not null,
  unique (group_key, word)
);

-- =============================================================
-- アクセス制限（RLS）：members にいる家族だけが読み書きできる
-- =============================================================
alter table public.members       enable row level security;
alter table public.recipes       enable row level security;
alter table public.ingredients   enable row level security;
alter table public.steps         enable row level security;
alter table public.recipe_images enable row level security;
alter table public.tags          enable row level security;
alter table public.recipe_tags   enable row level security;
alter table public.cook_logs     enable row level security;
alter table public.synonyms      enable row level security;

-- members：家族は全員の名前を見られる。自分の行だけ更新できる（表示名・user_id）
create policy members_select on public.members
  for select to authenticated
  using (public.is_member());

create policy members_update_self on public.members
  for update to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'))
  with check (lower(email) = lower(auth.jwt() ->> 'email') and user_id = auth.uid());

-- その他の表：家族なら読み書き・削除すべて可（削除は家族全員）
create policy recipes_all on public.recipes
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy ingredients_all on public.ingredients
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy steps_all on public.steps
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy recipe_images_all on public.recipe_images
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy tags_all on public.tags
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy recipe_tags_all on public.recipe_tags
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy cook_logs_all on public.cook_logs
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy synonyms_all on public.synonyms
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- =============================================================
-- 写真の保存場所（Storage）：非公開バケット、家族だけ読み書き
-- =============================================================
insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', false)
on conflict (id) do nothing;

create policy recipe_images_storage_select on storage.objects
  for select to authenticated
  using (bucket_id = 'recipe-images' and public.is_member());

create policy recipe_images_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recipe-images' and public.is_member());

create policy recipe_images_storage_update on storage.objects
  for update to authenticated
  using (bucket_id = 'recipe-images' and public.is_member())
  with check (bucket_id = 'recipe-images' and public.is_member());

create policy recipe_images_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'recipe-images' and public.is_member());

-- =============================================================
-- 家族3人のメールアドレス（★実行前に書き換えてください）
-- =============================================================
insert into public.members (email, display_name) values
  ('papa@example.com',  'パパ'),
  ('mama@example.com',  'ママ'),
  ('child@example.com', '息子');
