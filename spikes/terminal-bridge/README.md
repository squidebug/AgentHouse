# terminal-bridge (Phase 0 spike)

실제 CLI를 PTY로 띄우고, 서버의 headless 터미널이 화면을 그대로 따라 그리며, 브라우저(xterm.js)에서 보고 입력하는 최소 구현입니다. 제품 코드가 아니라 위험 요소를 확인하는 실험용입니다.

## 실행

```powershell
pnpm install                 # 저장소 루트에서 한 번
pnpm spike:terminal          # 출력된 http://127.0.0.1:<port>/?token=... 주소를 브라우저로 엽니다
```

- `--open`: 브라우저 자동 열기 (`node src/server.mjs --open`)
- 서버는 `127.0.0.1`에만 열리고, 실행할 때마다 새 토큰이 만들어집니다. 다른 Origin의 요청과 WebSocket은 거부합니다.

## 자동 검사

```powershell
pnpm spike:terminal:smoke                      # fake-agent로 보안·스냅샷·입력·종료 검사 (로그인 불필요)
node test/smoke.mjs --conpty-dll               # node-pty에 포함된 conpty.dll로 같은 검사
node test/real-cli.mjs claude                  # 실제 Claude를 프롬프트 없이 띄워 첫 화면과 종료 확인
node test/real-cli.mjs claude --compose-test   # 두 줄 붙여넣기 (존재하지 않는 모델로 실행해 계정 사용 없음)
node test/real-cli.mjs claude --submit-test 0  # 붙여넣기 직후 Enter, 테스트가 만든 트랜스크립트는 삭제
node test/probe-dsr.mjs [--conpty-dll] [--silent]  # ConPTY가 주고받는 터미널 질의 타임라인
```

`real-cli.mjs`는 실제 CLI를 실행하므로 CI에서는 쓰지 않습니다.

## 브라우저에서 직접 확인할 것 (Phase 0 체크리스트)

1. **렌더링**: Claude Code를 띄우고 창 크기를 10번 바꿔도 화면이 깨지지 않는지, 마우스 휠·클릭이 동작하는지
2. **재접속**: 응답이 출력되는 도중 새로고침 → 같은 화면, 이어서 입력 가능
3. **입력창**: 한글 여러 줄, 이모지, 아주 긴 텍스트를 보내 보고 Enter 지연별로 한 메시지로 가는지
4. **라이트 모드**: 오른쪽 위 버튼으로 전환 → 'Claude 테마'를 `light-ansi`로 두고 새 세션을 띄워 글자가 잘 보이는지
5. **단축키**: Claude의 Ctrl+T, Ctrl+R, Ctrl+O 등이 브라우저 단축키와 부딪히는지 (일반 탭 / PWA 창 각각)
6. **종료**: '세션 종료' 후 작업 관리자에 claude.exe가 남지 않는지
