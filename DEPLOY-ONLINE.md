# claude.ai 밖으로 옮기기 — GitHub Pages + Supabase

이 폴더를 인터넷 주소(GitHub Pages)에 올리고 무료 온라인 DB(Supabase)를 연결하면,
**Claude 계정 없이 링크만으로** 열리고 사이트 아이디로 로그인해 PC·휴대폰에서 같은 진도를 봅니다.
처음 한 번만 아래 순서대로 하면 됩니다(약 20분).

## 1단계. Supabase(온라인 DB) 만들기

| 순서 | 할 일 |
|---|---|
| 1 | https://supabase.com 에서 가입(GitHub 계정으로 가입 가능) |
| 2 | `New project` → 이름(예: safety-exam), Database Password(아무거나 길게, 따로 적어 두기), Region은 **Northeast Asia (Seoul)** → `Create new project` (1~2분 기다림) |
| 3 | 왼쪽 메뉴 `SQL Editor` → `New query` → 이 폴더의 `supabase/setup.sql` 파일 내용을 **전부** 붙여 넣고 `Run` → "Success" 확인 |
| 4 | 왼쪽 메뉴 `Authentication` → `Sign In / Providers`(또는 `Providers`) → `Email` → **Confirm email 끄기** → 저장. (`Allow new users to sign up`은 켜 둔 채로) |
| 5 | 왼쪽 아래 `Project Settings` → `API`(또는 `Data API` / `API Keys`) → **Project URL**과 **anon public** 키를 복사 |

## 2단계. 연결 설정 넣기

`assets/config.js`를 메모장으로 열어 따옴표 안에 붙여 넣고 저장합니다.

```js
window.ISE_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...(긴 키)',
  emailDomain: 'ise.local'
};
```

> anon 키는 웹페이지에 공개해도 되는 키입니다. 데이터는 setup.sql의 행 보안 규칙으로 보호됩니다.
> 파일 편집이 어렵다면 사이트를 먼저 올린 뒤 위쪽 막대의 `🔌 온라인 DB 설정`에 붙여 넣고 `config.js 내려받기`로 파일을 받아 3단계처럼 다시 올려도 됩니다.

## 3단계. GitHub Pages에 올리기

| 순서 | 할 일 |
|---|---|
| 1 | https://github.com 가입 → 오른쪽 위 `+` → `New repository` → 이름(예: safety-exam), **Public** → `Create repository` |
| 2 | 만들어진 화면의 `uploading an existing file` 클릭 → 이 폴더 **안의 파일·폴더 전부**(index.html, assets, data, supabase …)를 끌어다 놓기 → `Commit changes` |
| 3 | 저장소 `Settings` → 왼쪽 `Pages` → Source: `Deploy from a branch`, Branch: `main` / `/(root)` → `Save` |
| 4 | 1~2분 뒤 같은 화면 위쪽에 주소가 나옵니다: `https://<GitHub아이디>.github.io/safety-exam/` |

## 4단계. 첫 접속

1. 위 주소를 열면 로그인 화면이 나옵니다.
2. **admin / admin** 으로 로그인 → 비밀번호 변경 창에서 새 비밀번호로 바꿉니다(처음 한 번 관리자 계정이 자동으로 만들어짐).
3. `09 사용자`에서 가족 계정을 만들거나, 로그인 화면의 `회원가입`으로 각자 가입합니다.
4. 휴대폰은 주소를 열고 `홈 화면에 추가`(아이폰 Safari: 공유 → 홈 화면에 추가)하면 앱처럼 쓸 수 있습니다. 한 번 로그인하면 다음부터 자동으로 로그인됩니다.

## 알아 두기

- **Supabase 무료 플랜은 7일 동안 아무도 접속하지 않으면 프로젝트가 일시 정지**됩니다. 그러면 사이트에 "연결 실패"가 뜨니 Supabase 대시보드에서 `Restore project`를 누르세요(데이터는 남아 있음). 꾸준히 공부하면 정지되지 않습니다.
- 해설 자동 생성과 문제생성은 Claude API 키가 필요합니다. 관리자가 `04 문제생성` 설정에 API 키를 넣고 `09 사용자 › 💡 해설 관리 › 없는 해설 일괄 생성`을 한 번 돌리면, 만들어진 해설은 모든 사용자에게 보입니다. API 키는 그 브라우저에만 저장되고 DB에는 올라가지 않습니다.
- 사이트 파일을 고쳐 다시 올릴 때는 `sw.js` 맨 위 `CACHE = 'ise-pwa-vN'`의 숫자를 올려야 휴대폰에 새 버전이 반영됩니다.
- 가입하면 Supabase `Authentication › Users`에 `아이디@ise.local` 형태로 보입니다(실제 메일은 보내지 않음). 가입 때 "invalid email" 오류가 나면 config.js의 `emailDomain`을 `example-ise.com`처럼 바꿔 보세요(바꾸기 전에 만든 계정은 다시 만들어야 함).
- 아무나 가입하지 못하게 하려면 관리자 화면 `⚙ 회원가입 설정`에서 승인제를 켜거나 가입을 닫으세요(DB에서도 강제됨).
- DB 백업: Supabase `Table Editor › docs` → `Export to CSV`, 또는 사이트 각 화면의 내려받기 기능.
