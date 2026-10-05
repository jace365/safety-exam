-- admin 비밀번호를 admin으로 초기화 (Supabase › SQL Editor › New query 에 붙여 넣고 Run)
-- 다음 로그인 때 비밀번호 변경을 요구하고, 로그인 중인 다른 기기는 자동 로그아웃됩니다.
-- 결과의 첫 줄이 UPDATE 0 이면 admin 계정이 아직 없는 것 → 사이트에서 admin / admin 으로 로그인하면 자동 생성됩니다.
update auth.users
   set encrypted_password = extensions.crypt('ise:admin', extensions.gen_salt('bf')),
       updated_at = now()
 where email like 'admin@%';

update public.docs
   set data = data || jsonb_build_object('mustChange', true,
                 'sv', coalesce((data->>'sv')::int, 1) + 1)
 where path = 'accounts/admin';
