-- ════════════════════════════════════════════════════════════════════
--  산업안전기사 실기 학습 사이트 — Supabase 온라인 DB 설정 (한 번만 실행)
--  Supabase 대시보드 › SQL Editor › New query 에 이 파일 전체를 붙여 넣고 Run.
--  다시 실행해도 안전합니다(이미 있는 것은 바꿔 씁니다).
--
--  구조: docs 표 하나에 "경로 → JSON" 형태로 저장한다(사이트 코드가 쓰는 경로 그대로).
--    accounts/<아이디>                    계정 정보(이름·권한·상태). 비밀번호는 Supabase Auth가 관리
--    progress/<아이디>                    진행 상황
--    progress/<아이디>/logs/<날짜_기기>    학습 기록
--    mockbank/<아이디>                    내가 입력한 모의고사 문제
--    explain/<문제id>                     해설(모든 사용자 공유)
--    config/app                           회원가입 설정
--  로그인 아이디 son3 은 Supabase Auth 이메일 son3@<emailDomain>(사이트 config.js)으로 저장된다.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.docs (
  path       text primary key,
  parent     text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data       jsonb not null default '{}'::jsonb,
  owner      uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index if not exists docs_parent_idx on public.docs (parent, path);
alter table public.docs replica identity full;

-- ── 도우미 함수 ──
-- 로그인한 사람의 사이트 아이디(이메일 @ 앞부분)
create or replace function public.ise_me() returns text
language sql stable as $$
  select lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1))
$$;

-- 관리자인가(사용 중지·승인 대기가 아닌 role=admin)
create or replace function public.ise_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where path = 'accounts/' || public.ise_me()
      and data ->> 'role' = 'admin'
      and coalesce((data ->> 'disabled')::boolean, false) = false
      and coalesce((data ->> 'pending')::boolean, false) = false
  )
$$;

-- 사용 가능한 계정인가(계정 문서가 있고 사용 중지·승인 대기가 아님)
create or replace function public.ise_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where path = 'accounts/' || public.ise_me()
      and coalesce((data ->> 'disabled')::boolean, false) = false
      and coalesce((data ->> 'pending')::boolean, false) = false
  )
$$;

-- 이 경로를 읽을 수 있는가
create or replace function public.ise_can_read(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p = 'config/app' then true
    when auth.uid() is null then false
    when split_part(p, '/', 1) in ('accounts', 'explain') then true
    when public.ise_is_admin() then true
    when split_part(p, '/', 1) in ('progress', 'mockbank') then split_part(p, '/', 2) = public.ise_me()
    else false
  end
$$;

-- 이 경로에 쓸 수 있는가
create or replace function public.ise_can_write(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then false
    when public.ise_is_admin() then true
    when split_part(p, '/', 1) = 'accounts' then split_part(p, '/', 2) = public.ise_me() and p = 'accounts/' || public.ise_me()
    when split_part(p, '/', 1) in ('progress', 'mockbank') then split_part(p, '/', 2) = public.ise_me() and public.ise_active()
    when split_part(p, '/', 1) = 'explain' then public.ise_active()
    else false
  end
$$;

-- ── 보호 트리거: 관리자가 아니면 권한·상태(role/disabled/pending)를 스스로 바꿀 수 없다 ──
create or replace function public.ise_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb;
  has_admin boolean;
begin
  new.updated_at := now();
  if new.path like 'accounts/%' and not public.ise_is_admin() then
    if tg_op = 'INSERT' then
      select exists (select 1 from public.docs where path like 'accounts/%' and data ->> 'role' = 'admin') into has_admin;
      if new.path = 'accounts/admin' and not has_admin then
        -- 처음 설치: admin 계정이 첫 관리자가 된다
        new.data := new.data || jsonb_build_object('role', 'admin', 'disabled', false, 'pending', false);
      else
        -- 직접 가입(관리자가 만든 계정은 관리자 권한으로 들어오므로 여기 오지 않음)
        select data into cfg from public.docs where path = 'config/app';
        if coalesce((cfg ->> 'allowSignup')::boolean, true) = false then
          raise exception 'signup_closed' using errcode = '42501';
        end if;
        new.data := new.data || jsonb_build_object('role', 'user', 'disabled', false,
          'pending', coalesce((cfg ->> 'approval')::boolean, false));
      end if;
    else
      new.data := jsonb_set(new.data, '{role}', coalesce(old.data -> 'role', '"user"'::jsonb));
      new.data := jsonb_set(new.data, '{disabled}', coalesce(old.data -> 'disabled', 'false'::jsonb));
      new.data := jsonb_set(new.data, '{pending}', coalesce(old.data -> 'pending', 'false'::jsonb));
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists ise_guard on public.docs;
create trigger ise_guard before insert or update on public.docs
  for each row execute function public.ise_guard();

-- ── 행 보안(RLS) ──
alter table public.docs enable row level security;
drop policy if exists ise_select on public.docs;
drop policy if exists ise_insert on public.docs;
drop policy if exists ise_update on public.docs;
drop policy if exists ise_delete on public.docs;
create policy ise_select on public.docs for select using (public.ise_can_read(path));
create policy ise_insert on public.docs for insert with check (public.ise_can_write(path));
create policy ise_update on public.docs for update using (public.ise_can_write(path)) with check (public.ise_can_write(path));
create policy ise_delete on public.docs for delete using (public.ise_can_write(path) and path not like 'accounts/%' or public.ise_is_admin());

grant select, insert, update, delete on public.docs to authenticated;
grant select on public.docs to anon;

-- ── 사이트가 부르는 함수(RPC) ──
-- 문서 일부만 고치기(기존 JSON에 덮어 합침). 행 보안이 그대로 적용된다
create or replace function public.ise_doc_update(p_path text, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  update public.docs set data = data || p_patch where path = p_path returning data into r;
  if r is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return r;
end
$$;

-- 처음 설치 상태인가(관리자 계정 문서가 아직 없음) — 로그인 전에도 부를 수 있다
create or replace function public.ise_needs_bootstrap() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.docs where path like 'accounts/%' and data ->> 'role' = 'admin')
$$;

-- 관리자: 다른 사용자 비밀번호 초기화 (사이트는 실제 비밀번호 앞에 'ise:'를 붙여 저장한다)
create or replace function public.ise_admin_set_password(p_user text, p_pw text) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.ise_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(coalesce(p_pw, '')) < 4 then raise exception 'too_short'; end if;
  update auth.users
     set encrypted_password = extensions.crypt('ise:' || p_pw, extensions.gen_salt('bf')), updated_at = now()
   where lower(split_part(email, '@', 1)) = lower(p_user);
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end
$$;

-- 관리자: 사용자 삭제(진도·기록·입력 문제·계정·로그인 정보 모두)
create or replace function public.ise_admin_delete_user(p_user text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.ise_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if lower(p_user) = public.ise_me() then raise exception 'cannot_delete_self'; end if;
  delete from public.docs
   where path = 'accounts/' || lower(p_user) or path = 'mockbank/' || lower(p_user)
      or path = 'progress/' || lower(p_user) or path like 'progress/' || lower(p_user) || '/%';
  delete from auth.users where lower(split_part(email, '@', 1)) = lower(p_user);
end
$$;

revoke all on function public.ise_admin_set_password(text, text) from public, anon;
revoke all on function public.ise_admin_delete_user(text) from public, anon;
grant execute on function public.ise_admin_set_password(text, text) to authenticated;
grant execute on function public.ise_admin_delete_user(text) to authenticated;
grant execute on function public.ise_doc_update(text, jsonb) to authenticated;
grant execute on function public.ise_needs_bootstrap() to anon, authenticated;

-- ── 실시간(다른 기기 변경 즉시 반영) ──
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    execute 'alter publication supabase_realtime add table public.docs';
  end if;
exception when undefined_object then
  raise notice 'supabase_realtime publication이 없어 실시간 반영은 건너뜁니다(사이트는 30초마다 새로고침으로 대신함).';
end
$$;

-- 기본 회원가입 설정(가입 허용, 승인 불필요) — 관리자 화면에서 바꿀 수 있음
insert into public.docs (path, data) values ('config/app', '{"allowSignup": true, "approval": false}')
on conflict (path) do nothing;
