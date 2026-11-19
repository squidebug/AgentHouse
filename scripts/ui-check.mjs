#!/usr/bin/env node
// Drives the built app in the installed Chrome (headless, nothing downloaded)
// with the fake agent: the login, a session in a pane, a message through the
// composer and its turn in the pane's conversation view, an ended session that
// an earlier session host left in sessions.json (ui-sample.mjs), sub-agents,
// groups, the dashboard and the usage screen (and the panes' size after each),
// delegation, the graph of all sessions (who is under whom, and when each
// worked), a session ended and started again where it stopped, and sessions
// started outside AgentHouse, which the fake agent lists in Claude's place
// (ui-sample.mjs, which also writes the usage log the usage screen draws).
// Light and dark screenshots go to the output folder, and with --out one page
// of them all (index.html): light next to dark, and before next to after when
// --before names the folder an earlier run was given as --out.
// Uses throwaway state and Claude config folders, so it never touches real
// sessions or ~/.claude.
//   pnpm build && pnpm ui:check [-- --out <folder> [--before <folder>]] [-- --headed]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writePage } from './ui-page.mjs';
import { writeOutsideSessions, writeSampleSession, writeUsageLog } from './ui-sample.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'apps/server/dist/main.js');
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const started = Date.now();
const before = flag('--before') && path.resolve(flag('--before'));
if (before && (!flag('--out') || before === path.resolve(flag('--out')))) {
  console.error('--before compares with the screenshots of an earlier run: give --out as well, another folder');
  process.exit(2);
}
// What the page of screenshots calls each scene (the name of its files, without the mode).
const SCENES = {
  'startup-first': '시작 화면 · 첫 실행',
  login: '로그인',
  'startup-loading': '시작 화면 · 점검 중',
  'cli-choice': '실행 파일 지정',
  'startup-issues': '시작 화면 · 문제',
  conversation: '대화 보기',
  terminal: '터미널',
  ended: '끝난 세션',
  flow: '흐름 보기',
  agents: '서브에이전트',
  group: '묶음',
  notifications: '알림',
  background: '백그라운드 작업',
  skills: '스킬',
  'note-editor': '편집 창',
  memory: '메모리',
  dashboard: '대시보드',
  'dashboard-more': '대시보드 · 여러 세션',
  'tabs-drop': '탭 · 끌어 놓는 중',
  tabs: '탭',
  'split-drop': '자유 분할 · 끌어 놓는 중',
  split: '자유 분할',
  'split-narrow': '자유 분할 · 좁은 창',
  graph: '그래프 · 관계',
  'graph-point': '그래프 · 가리키면',
  'graph-lanes': '그래프 · 흐름',
  usage: '사용량',
  'usage-point': '사용량 · 가리키면',
  'usage-table': '사용량 · 표',
  delegate: '위임',
  'composer-delegate': '입력창 위임',
  resume: '이어서 열기',
  external: '외부 세션',
  'external-dashboard': '외부 세션 · 대시보드',
  'external-bell': '외부 세션 · 종',
  failed: '멈춘 곳',
};
const scratch = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-ui-'));
const out = path.resolve(flag('--out') ?? path.join(scratch, 'shots'));
mkdirSync(out, { recursive: true });
const home = path.join(scratch, 'home');
const config = path.join(scratch, 'claude');
const work = path.join(scratch, 'work');
mkdirSync(work, { recursive: true });
const env = { ...process.env, AGENTHOUSE_HOME: home, CLAUDE_CONFIG_DIR: config };
writeSampleSession({ home, config, cwd: work });
// Plan usage for the top bar's chip and the usage screen: what its two windows stand at.
const used = writeUsageLog({ home });
// The user's own notes for Claude in the session folder: a skill of the project, and its instructions.
const skillPath = path.join(work, '.claude', 'skills', 'ping-pong', 'SKILL.md');
mkdirSync(path.dirname(skillPath), { recursive: true });
writeFileSync(skillPath, '---\nname: ping-pong\ndescription: Replies with the word pong.\n---\n\nReply with exactly the word: pong\n');
writeFileSync(path.join(work, 'CLAUDE.md'), '# ui-check\n\nAnswer in one line.\n');

/** A stand-in Claude Code that answers --version like the real one, installed as npm would; the file to choose. */
function installFakeClaude(bin, version) {
  const source = `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('${version} (Claude Code)');\nelse console.log(JSON.stringify({ loggedIn: true }));\n`;
  mkdirSync(path.join(bin, 'node_modules', 'fake-claude'), { recursive: true });
  if (process.platform !== 'win32') {
    writeFileSync(path.join(bin, 'claude'), source);
    chmodSync(path.join(bin, 'claude'), 0o755);
    return path.join(bin, 'claude');
  }
  writeFileSync(path.join(bin, 'node_modules', 'fake-claude', 'cli.js'), source);
  writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*\r\n');
  return path.join(bin, 'claude.cmd');
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

const server = spawn(process.execPath, [main, '--port', '0', '--json', '--allow-fake', '--cwd', work], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const { url, port, key } = JSON.parse(await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)));
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

try {
  await page.emulateMedia({ colorScheme: 'dark' });
  // The terminal draws on a canvas (WebGL); its text is checked on the server side by the tests.
  const terminalShown = () => page.locator('.xterm-screen').first().waitFor({ timeout: 10_000 });
  // What the check provokes on purpose, and Chrome logs as errors: a refused choice of executable (a 400),
  // and the content of a conversation entry whose first request is cut off.
  const provoked = (message) => {
    const from = message.location().url;
    return (from.includes('/api/cli/') && /status of 400/.test(message.text())) || (from.includes('/conversation/') && /ERR_FAILED/.test(message.text()));
  };
  page.on('console', (message) => message.type() === 'error' && !provoked(message) && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  const workspace = page.getByRole('heading', { name: 'AgentHouse' });
  // Past the start screen: straight on when the environment is fine, else through 계속 (this machine may lack a CLI).
  const enter = async (shot) => {
    const proceed = page.getByRole('button', { name: '계속' });
    await workspace.or(proceed).first().waitFor({ timeout: 20_000 });
    if (await proceed.isVisible()) {
      if (shot) await page.screenshot({ path: path.join(out, `${shot}.png`) });
      await proceed.click();
    }
    await workspace.waitFor();
  };
  // Out of the way of hover styles and tooltips, after animations settle.
  const settle = async () => {
    await page.mouse.move(1, 899);
    await page.locator('body').evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(700);
  };
  await page.goto(url);
  await enter('startup-first-dark');
  check(!new URL(page.url()).searchParams.has('code'), 'the login code is spent and leaves the address');

  // A browser without a token gets the login page and the command for a new address; a spent address says so.
  for (const [address, label] of [
    [`${origin}/`, '로그인 필요'],
    [url, '로그인 링크 만료'],
  ]) {
    const stranger = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await stranger.emulateMedia({ colorScheme: 'dark' });
    await stranger.goto(address);
    await stranger.getByText(label).waitFor();
    check(await stranger.getByText('pnpm start').isVisible(), `a browser without a token: ${label}, with the command`);
    if (label === '로그인 필요') {
      await stranger.screenshot({ path: path.join(out, 'login-dark.png') });
      await stranger.emulateMedia({ colorScheme: 'light' });
      await stranger.screenshot({ path: path.join(out, 'login-light.png') });
    }
    await stranger.close();
  }

  // In the same tab the next load goes straight to the workspace: the start screen is for the first one.
  await page.reload();
  await workspace.waitFor();
  check(!(await page.getByText('환경 점검 중').isVisible()), 'a reload in the same tab skips the start screen');
  const asNewTab = () => page.evaluate(() => sessionStorage.removeItem('ah-started'));

  // The start screen: a loading bar while the environment is checked (held back here so it can be seen).
  await asNewTab();
  await page.route('**/api/env*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Let go by the unroute below if it came first.
    await route.continue().catch(() => {});
  });
  await page.reload();
  await page.getByText('환경 점검 중').waitFor();
  check(await page.getByRole('progressbar').isVisible(), 'the page opens on a loading bar while the environment is checked');
  await page.screenshot({ path: path.join(out, 'startup-loading-dark.png') });
  await page.unroute('**/api/env*');
  await enter();

  // The executable a CLI runs, chosen in the environment check: checked by running it, then saved.
  const fakeClaude = installFakeClaude(path.join(scratch, 'fake-claude'), '2.1.400');
  const openEnvironment = () => page.getByRole('button', { name: '환경 점검' }).click();
  const chooseDialog = page.getByRole('dialog', { name: 'Claude Code 실행 파일' });
  await openEnvironment();
  await page.getByRole('button', { name: 'Claude Code 실행 파일 변경' }).click();
  await chooseDialog.getByRole('radio', { name: '직접 지정' }).check();
  await chooseDialog.getByRole('textbox', { name: '전체 경로' }).fill(process.execPath);
  await chooseDialog.getByRole('button', { name: '저장' }).click();
  await chooseDialog.getByText('Claude Code가 아닙니다', { exact: false }).waitFor();
  check(true, 'a file that is not Claude Code is refused, with the reason');
  await chooseDialog.getByRole('textbox', { name: '전체 경로' }).fill(fakeClaude);
  await settle();
  await page.screenshot({ path: path.join(out, 'cli-choice-dark.png') });
  await chooseDialog.getByRole('button', { name: '저장' }).click();
  await chooseDialog.waitFor({ state: 'detached' });
  await page.getByText('2.1.400 · 지정함').waitFor();
  check(await page.getByText(fakeClaude).isVisible(), 'the chosen file is the one the environment check shows');
  await page.keyboard.press('Escape');

  // Gone since: the next start stops, says so, and takes the fix there.
  rmSync(path.join(scratch, 'fake-claude'), { recursive: true, force: true });
  await fetch(`${origin}/api/env?refresh=1`, { headers: { authorization: `Bearer ${key}` } });
  await asNewTab();
  await page.reload();
  await page.getByText('Claude Code 실행 파일을 쓸 수 없음').waitFor();
  check(await page.getByRole('button', { name: '계속' }).isVisible(), 'the start screen stops at a chosen file that is gone');
  await settle();
  await page.screenshot({ path: path.join(out, 'startup-issues-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await settle();
  await page.screenshot({ path: path.join(out, 'startup-issues-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Claude Code 실행 파일 변경' }).click();
  await chooseDialog.getByRole('radio', { name: /^셸 기본/ }).check();
  await chooseDialog.getByRole('button', { name: '저장' }).click();
  await enter();
  check(true, 'back to the shell\'s own, the start screen lets the workspace in');

  const created = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: 'fake', title: 'ui-check', cwd: work, theme: 'dark' }),
  });
  check(created.status === 201, 'a session starts', `HTTP ${created.status}`);

  await page.getByRole('button', { name: 'ui-check 열기' }).click();
  await terminalShown();
  check(true, 'the pane shows its terminal');

  // A Claude session takes text only once it has started (its first hook): the folder trust question may be up before.
  const ready = (title) =>
    page
      .getByRole('complementary', { name: '세션' })
      .locator('.ah-row', { has: page.getByRole('button', { name: `${title} 열기`, exact: true }) })
      .getByRole('img', { name: /^대기/ })
      .waitFor({ timeout: 10_000 });
  const box = page.getByRole('textbox', { name: '메시지' });
  await ready('ui-check');
  await box.fill('show me a tool call');
  await box.press('Control+Enter');
  await page.getByText('1개 세션에 보냄').waitFor({ timeout: 10_000 });
  check(true, 'the composer sends to the focused pane');

  const toConversation = page.getByRole('button', { name: '대화', exact: true });
  await toConversation.waitFor({ timeout: 10_000 });
  await toConversation.click();
  await page.getByText('fake answer: show me a tool call').waitFor({ timeout: 10_000 });
  check(await page.getByText('show me a tool call', { exact: true }).isVisible(), 'the conversation shows the prompt and the answer');
  const work_ = page.getByRole('button', { name: /도구 1/ });
  check(await work_.isVisible(), 'the tool call is folded into one row');
  await work_.click();
  // The first request for what the tool call holds is cut off: the row says so, and asks again when told to.
  await page.route('**/api/sessions/*/conversation/*', (route) => route.abort(), { times: 1 });
  // The tool's row; the session's row may still read "작업 중 · Bash" for a moment.
  await page.getByRole('button', { name: /Bash echo/ }).click();
  await page.getByText('불러오기 실패', { exact: true }).waitFor({ timeout: 5000 });
  check(true, 'an opened tool call whose content did not come says so');
  await page.getByRole('button', { name: '다시 불러오기' }).click();
  await page.getByText('fake-tool-output', { exact: true }).waitFor({ timeout: 5000 });
  check(true, 'asked again, it shows its output');
  check(await page.getByText(/fake-model · low · 입력/).isVisible(), 'the turn shows model, effort and tokens');

  await settle();
  await page.screenshot({ path: path.join(out, 'conversation-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'conversation-light.png') });
  await page.getByRole('button', { name: '터미널', exact: true }).click();
  await terminalShown();
  check(true, 'and back to the terminal');
  // The same from the keyboard, with the terminal focused: Ctrl+` never reaches the CLI.
  // The composer is folded while the terminal takes the typing, and opens for the conversation without moving the panes.
  const sendButton = page.getByRole('button', { name: '보내기' });
  const paneBox = () => page.getByRole('region', { name: 'ui-check', exact: true }).boundingBox();
  await page.locator('.xterm-screen').first().click();
  await sendButton.waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'while the terminal takes the typing, the composer is folded');
  const before = await paneBox();
  await page.keyboard.press('Control+Backquote');
  await page.getByRole('button', { name: /도구 1/ }).waitFor({ timeout: 5000 });
  // The pane drew the terminal in between; the conversation comes back as it was left.
  await page.getByText('fake-tool-output', { exact: true }).waitFor({ timeout: 5000 });
  check(true, 'back in the conversation, the tool call opened before is still open');
  await sendButton.waitFor({ state: 'visible', timeout: 5000 });
  check(true, 'Ctrl+` in the terminal shows the conversation, and the composer opens');
  await page.waitForTimeout(400);
  const after = await paneBox();
  check(Boolean(before && after && before.y === after.y && before.height === after.height), 'the pane stays where it was', JSON.stringify({ before, after }));
  const motion = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    });
    const reveal = rules.find((rule) => rule instanceof CSSKeyframesRule && rule.name === 'ah-reveal');
    const section = document.querySelector('section[aria-label="입력"]');
    return { keyframes: reveal?.cssText ?? '', transition: section ? getComputedStyle(section).transitionProperty : '' };
  });
  check(motion.keyframes.includes('max-width') && motion.transition.includes('padding'), 'it opens and folds with an animation', JSON.stringify(motion));
  await page.keyboard.press('Control+Backquote');
  await terminalShown();
  await page.waitForFunction(() => Boolean(document.activeElement?.closest('.xterm')), null, { timeout: 5000 });
  await sendButton.waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'and again: the terminal, ready to type, the composer folded');

  // Windows Terminal's keys: Ctrl+C copies a selection instead of interrupting, Ctrl+V pastes.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const screenBox = await page.locator('.xterm-screen').first().boundingBox();
  await page.mouse.dblclick(screenBox.x + 24, screenBox.y + 8); // the word 'fake-agent' on the first line
  await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(copied === 'fake-agent', 'Ctrl+C in the terminal copies the selection', copied);
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Backquote');
  await page.getByText('fake answer: fake-agent', { exact: true }).waitFor({ timeout: 10_000 });
  check(true, 'Ctrl+V pastes it, and nothing interrupted the CLI');
  await page.keyboard.press('Control+Backquote');
  await terminalShown();
  await page.reload();
  await enter();
  await terminalShown();
  await settle();
  await page.screenshot({ path: path.join(out, 'terminal-light.png') });
  // What a change of looks must leave alone, to compare before and after it: where the pane and its
  // terminal are, and the size the terminal asked the PTY for.
  const listed = await (await fetch(`${origin}/api/sessions`, { headers: { authorization: `Bearer ${key}`, origin } })).json();
  const sized = listed.find((session) => session.title === 'ui-check');
  const round = (rect) => rect && Object.fromEntries(Object.entries(rect).map(([side, px]) => [side, Math.round(px * 100) / 100]));
  console.log(`INFO  pane ${JSON.stringify(round(await paneBox()))}, terminal ${JSON.stringify(round(await page.locator('.xterm-screen').first().boundingBox()))}, ${sized?.cols}×${sized?.rows}`);

  // An ended session from an earlier host: folded into one row with the other ended ones until asked for;
  // its conversation is all that is left.
  const endedRow = page.getByRole('button', { name: /^종료 \d+$/ });
  check((await endedRow.isVisible()) && !(await page.getByRole('button', { name: 'readme-cleanup 열기' }).isVisible()), 'ended sessions fold into one row of the tree');
  await endedRow.click();
  await page.getByRole('button', { name: 'readme-cleanup 열기' }).click();
  await page.getByText('README를 정리하고 테스트를 돌려 줘').waitFor({ timeout: 10_000 });
  check(await page.getByRole('table').isVisible(), 'an ended session shows its conversation, markdown included');
  check(await page.getByText('폴더 구조 조사').isVisible(), 'a sub-agent shows as a block');
  check(await page.getByText('중단됨', { exact: true }).first().isVisible(), 'an interrupted turn is marked');
  check(await page.getByText('새 대화', { exact: true }).first().isVisible(), 'the conversation after /clear follows');
  check(await page.getByText(/Opus 5\.5 · high · 입력/).first().isVisible(), 'turns show the model name');
  await page.getByRole('button', { name: /도구 4/ }).click();
  await page.getByRole('button', { name: /Edit README\.md/ }).click();
  await page.getByText('+A small shop. Install first.').waitFor({ timeout: 5000 });
  check(true, 'an edit opens as a diff');
  await page.getByRole('button', { name: /Explore/ }).click();
  await page.getByText('구조 요약').waitFor({ timeout: 5000 });
  check(true, 'a sub-agent opens to its report');
  await settle();
  await page.screenshot({ path: path.join(out, 'ended-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'ended-dark.png') });

  // Sub-agents in the background: nested rows in the tree, each with a conversation of its own.
  const agents = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: 'fake', title: 'ui-agents', cwd: work, theme: 'dark' }),
  });
  check(agents.status === 201, 'a session for sub-agents starts', `HTTP ${agents.status}`);
  // The tree; the flow view and pane headers have buttons of the same names.
  const tree = page.getByRole('complementary', { name: '세션' });
  await tree.getByRole('button', { name: 'ui-agents 열기' }).click();
  await terminalShown();
  await ready('ui-agents');
  await box.fill('start agents please');
  await box.press('Control+Enter');
  const nestedRow = tree.getByRole('button', { name: 'Check the tests 열기' });
  await nestedRow.waitFor({ timeout: 10_000 });
  const indent = async (name) => tree.getByRole('button', { name }).evaluate((el) => el.parentElement.getBoundingClientRect().left + parseFloat(getComputedStyle(el.parentElement).paddingLeft));
  check((await indent('Check the tests 열기')) > (await indent('Plan the change 열기')), 'the agent a sub-agent started is nested under it');
  const rowDone = (name) => page.locator('.ah-row', { has: page.getByRole('button', { name: `${name} 열기` }) }).getByRole('img', { name: '완료' });
  for (const name of ['Look around', 'Check the tests', 'Plan the change']) await rowDone(name).waitFor({ timeout: 10_000 });
  check(true, 'all three are done once they report');

  // An agent picked in the tree shows its session's flow: a lane each, over time, that agent pointed out.
  await tree.getByRole('button', { name: 'Plan the change 열기' }).click();
  const flow = page.getByRole('region', { name: 'ui-agents' }).getByRole('list', { name: 'ui-agents 흐름' });
  await flow.waitFor({ timeout: 10_000 });
  check((await flow.getByRole('listitem').count()) === 4, "the tree's agent opens its session's flow: the session and its three agents");
  const marked = async () => (await flow.locator('[aria-current="true"]').innerText()).trim();
  check((await marked()) === 'Plan the change', 'the agent picked in the tree is pointed out', await marked());
  await settle();
  await page.screenshot({ path: path.join(out, 'flow-dark.png') });
  await flow.getByRole('button', { name: 'Plan the change 열기' }).click();
  const agentPane = page.getByRole('region', { name: 'Plan the change' });
  await agentPane.getByText('plan ready', { exact: true }).waitFor({ timeout: 10_000 });
  check(true, 'a row of the flow opens that agent in the same pane');
  const chip = agentPane.getByRole('group', { name: '서브에이전트' }).getByRole('button', { name: 'Check the tests 대화 열기' });
  check(await chip.isVisible(), 'its own sub-agent is a chip in its header');
  check(await agentPane.getByText('보고', { exact: true }).first().isVisible(), "the nested agent's report is in its conversation");
  await settle();
  await page.screenshot({ path: path.join(out, 'agents-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'agents-light.png') });
  await agentPane.getByRole('button', { name: '뒤로' }).click();
  await flow.waitFor({ timeout: 5000 });
  check((await marked()) === 'Plan the change', 'and back to the flow, the agent it came from pointed out', await marked());
  await settle();
  await page.screenshot({ path: path.join(out, 'flow-light.png') });

  // Grouping: a session dragged onto another one at the top goes under it, and stays there.
  const row = (title) => page.locator('.ah-row', { has: page.getByRole('button', { name: `${title} 열기`, exact: true }) });
  const left = (title) => row(title).evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  await row('ui-agents').dragTo(row('ui-check'));
  await page.getByRole('group', { name: 'ui-agents → ui-check' }).getByRole('button', { name: '묶기' }).click();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ timeout: 5000 });
  check((await left('ui-agents')) > (await left('ui-check')), 'a session dropped on another goes under it, marked as grouped');
  await page.reload();
  await enter();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ timeout: 10_000 });
  check(true, 'the group outlives a reload');
  await settle();
  await page.screenshot({ path: path.join(out, 'group-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'group-dark.png') });
  await tree.getByRole('button', { name: 'ui-agents 세부 정보' }).click();
  await page.getByRole('button', { name: '최상위로' }).click();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ state: 'detached', timeout: 5000 });
  check((await left('ui-agents')) === (await left('ui-check')), 'and back at the top from its details');
  await page.getByRole('button', { name: '아래로 넣기' }).click();
  await page.getByRole('menuitem', { name: 'ui-check' }).click();
  await page.getByRole('menuitem', { name: '묶기' }).click();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ timeout: 5000 });
  check(true, 'grouped without dragging, from the menu');
  // Dragged, it goes back to the top where the foot of the tree says so: a place that shows once the drag is under way.
  const grabbed = await row('ui-agents').boundingBox();
  await row('ui-agents').hover();
  await page.mouse.down();
  await page.mouse.move(grabbed.x + grabbed.width / 2, grabbed.y + grabbed.height + 30, { steps: 4 });
  const toTop = tree.locator('div:text-is("최상위로")');
  await toTop.waitFor({ timeout: 5000 });
  // Twice: the second move is what tells the place that something is over it.
  await toTop.hover();
  await toTop.hover();
  await page.mouse.up();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ state: 'detached', timeout: 5000 });
  check((await left('ui-agents')) === (await left('ui-check')), 'dragged to the foot of the tree, a placed session goes back to the top');

  // The bell at the top: how many sessions wait for the user, with the list of them, and whether
  // finished work is announced too. A stand-in records what the page hands the browser's
  // notifications, and the tab passes for one in the background.
  await page.evaluate(() => {
    window.__notes = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, options) {
        window.__notes.push({ title, body: options?.body });
      }
      close() {}
    };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  const announced = (body) => page.evaluate((text) => window.__notes.filter((note) => note.body === text).map((note) => note.title), body);
  const authed = { authorization: `Bearer ${key}`, origin, 'content-type': 'application/json' };
  const named = async (title) => (await (await fetch(`${origin}/api/sessions`, { headers: authed })).json()).find((session) => session.title === title);
  // To a session no pane shows, as the composer would send it.
  const tell = async (title, text) => fetch(`${origin}/api/sessions/${(await named(title)).id}/compose`, { method: 'POST', headers: authed, body: JSON.stringify({ text }) });
  const turnEnded = async (title, since) => {
    for (let tries = 0; tries < 100; tries += 1) {
      const { status } = await named(title);
      if (status.value === 'idle' && status.at >= since) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const asked = Date.now();
  await tell('ui-check', 'one more answer');
  await turnEnded('ui-check', asked);
  await page.waitForTimeout(500);
  check((await announced('작업 완료')).length === 0, 'finished work is not announced unless asked for');
  const bell = page.getByRole('button', { name: /^알림/ });
  await bell.click();
  const doneSwitch = page.getByRole('switch', { name: '완료 알림' });
  check((await page.getByText('없음', { exact: true }).isVisible()) && !(await doneSwitch.isChecked()), 'the bell opens on nobody waiting, and the switch for finished work off');
  await doneSwitch.check();
  await page.keyboard.press('Escape');
  await tell('ui-check', 'this needs approval');
  await page.getByRole('button', { name: '알림 · 승인·입력 대기 1' }).waitFor({ timeout: 10_000 });
  await bell.click();
  const waitingRow = page.getByRole('menuitem', { name: /ui-check/ });
  check(await waitingRow.getByText('승인 대기 · Write', { exact: false }).isVisible(), 'the bell counts a session that waits for approval, and lists it');
  await settle();
  await page.screenshot({ path: path.join(out, 'notifications-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await bell.click();
  await settle();
  await page.screenshot({ path: path.join(out, 'notifications-light.png') });
  await waitingRow.click();
  const asker = page.getByRole('region', { name: 'ui-check', exact: true });
  await asker.locator('.xterm-screen').waitFor({ timeout: 10_000 });
  check(true, 'a click on it shows that session');
  await page.getByRole('button', { name: '다크 모드' }).click();
  // Answered in its terminal, the turn goes on and ends.
  await asker.locator('.xterm-screen').click();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '알림', exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => window.__notes.some((note) => note.body === '작업 완료'), null, { timeout: 10_000 }).catch(() => {});
  check((await announced('승인 대기 · Write')).includes('ui-check'), 'a session that asks is announced while the tab is in the background');
  check((await announced('작업 완료')).includes('ui-check'), 'and its finished work too, with the switch on', JSON.stringify(await page.evaluate(() => window.__notes)));
  await page.evaluate(() => delete document.visibilityState);

  // What a session leaves running in the background and sets for later shows under it in the tree;
  // the skills its conversation was given, in its details.
  const background = tree.getByRole('group', { name: 'ui-check 백그라운드 작업' });
  const workRow = (title) => background.locator('.ah-row', { hasText: title });
  await tell('ui-check', 'run it in the background and keep it');
  await workRow('Wait for the build').getByRole('img', { name: '실행 중' }).waitFor({ timeout: 10_000 });
  await tell('ui-check', 'run the tests in the background');
  await workRow('Run the tests').getByRole('img', { name: '완료' }).waitFor({ timeout: 10_000 });
  check(await workRow('Wait for the build').getByRole('img', { name: '실행 중' }).isVisible(), 'a command in the background is a row under its session: running, then done');
  await tell('ui-check', 'monitor the deploy and keep it');
  await workRow('deploy status').getByText('모니터 · deployed 3 of 5').waitFor({ timeout: 10_000 });
  check(true, 'a monitor shows the latest line it read');
  await tell('ui-check', 'schedule a check and run it');
  await workRow('check the deploy').getByText('1분마다 · 1회').waitFor({ timeout: 10_000 });
  check(await workRow('check the deploy').getByRole('img', { name: '예약' }).isVisible(), 'a scheduled prompt is a row too, with its schedule in words and its runs');
  await background.getByRole('button', { name: 'Wait for the build 세부 정보' }).click();
  await tree.getByText('sleep 20; echo done').waitFor({ timeout: 5000 });
  check(true, 'opened, a task shows its command');
  await tell('ui-check', 'use a skill');
  await page.waitForFunction(async ([address, token]) => (await (await fetch(`${address}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).json()).some((s) => s.title === 'ui-check' && s.invoked.includes('ping-pong')), [origin, key], { timeout: 10_000 });
  await settle();
  await page.screenshot({ path: path.join(out, 'background-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'background-light.png') });
  // Skills and memory are the user's and the folder's, shared by its sessions and their sub-agents:
  // two buttons at the foot of the tree, a window each. The project's memory is next to its transcripts.
  const memoryDir = path.join(path.dirname((await named('ui-check')).transcripts[0].path), 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [Role](user-role.md) — who the user is\n');
  writeFileSync(path.join(memoryDir, 'user-role.md'), '---\nname: user-role\ndescription: who the user is and how they work\nmetadata:\n  type: user\n---\n\nA developer who reviews every change.\n');
  const library = tree.getByRole('group', { name: '스킬·메모리' });
  await library.getByRole('button', { name: '스킬' }).click();
  const skillWindow = page.getByRole('dialog', { name: '스킬', exact: true });
  await skillWindow.getByRole('group', { name: '기본' }).getByText('loop').waitFor({ timeout: 10_000 });
  check(await skillWindow.getByLabel('ping-pong 사용함').isVisible(), "the folder's skills open in a window of their own, the one a session ran marked");
  check(await skillWindow.getByRole('group', { name: '플러그인' }).getByText('fake-plugin:review').isVisible(), 'by where they come from');
  await settle();
  await page.screenshot({ path: path.join(out, 'skills-light.png') });
  // One of the project's own opens as the text it is, and is saved to its file.
  await skillWindow.getByRole('group', { name: '프로젝트' }).getByRole('button', { name: /ping-pong/ }).click();
  const skillEditor = page.getByRole('dialog', { name: 'ping-pong 편집' });
  const skillText = skillEditor.getByRole('textbox', { name: 'ping-pong' });
  await skillText.waitFor({ timeout: 10_000 });
  await page.waitForFunction((box) => box.value.includes('Reply with exactly the word: pong'), await skillText.elementHandle(), { timeout: 10_000 });
  check(await skillEditor.getByRole('button', { name: '저장' }).isDisabled(), "a skill of the project opens with its file's text, with nothing to save until that changes");
  await skillText.fill((await skillText.inputValue()).replace('word: pong\n', 'word: pong, and nothing else\n'));
  await settle();
  await page.screenshot({ path: path.join(out, 'note-editor-light.png') });
  await skillEditor.getByRole('button', { name: '저장' }).click();
  await skillEditor.waitFor({ state: 'detached', timeout: 10_000 });
  check(readFileSync(skillPath, 'utf8').endsWith('Reply with exactly the word: pong, and nothing else\n'), 'saved, the file has the new text', JSON.stringify(readFileSync(skillPath, 'utf8').slice(-40)));
  await skillWindow.getByRole('button', { name: '닫기' }).click();
  await skillWindow.waitFor({ state: 'detached', timeout: 5000 });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await library.getByRole('button', { name: '메모리' }).click();
  const memoryWindow = page.getByRole('dialog', { name: '메모리', exact: true });
  await memoryWindow.getByRole('menu', { name: '자동 메모리' }).getByText('who the user is and how they work').waitFor({ timeout: 10_000 });
  check(await memoryWindow.getByRole('menu', { name: '지침' }).getByText('CLAUDE.md').isVisible(), "and what Claude reads by itself: the project's instructions, then its memory notes by their own titles");
  await settle();
  await page.screenshot({ path: path.join(out, 'memory-dark.png') });
  await memoryWindow.getByRole('menuitem', { name: 'user-role 편집' }).click();
  const noteEditor = page.getByRole('dialog', { name: 'user-role 편집' });
  const noteText = noteEditor.getByRole('textbox', { name: 'user-role' });
  await noteText.waitFor({ timeout: 10_000 });
  await page.waitForFunction((box) => box.value.includes('A developer'), await noteText.elementHandle(), { timeout: 10_000 });
  await noteText.fill((await noteText.inputValue()).replace('who the user is and how they work', 'the user, in one line'));
  await settle();
  await page.screenshot({ path: path.join(out, 'note-editor-dark.png') });
  await noteText.press('Control+s');
  await noteEditor.waitFor({ state: 'detached', timeout: 10_000 });
  await memoryWindow.getByText('the user, in one line').waitFor({ timeout: 10_000 });
  check(readFileSync(path.join(memoryDir, 'user-role.md'), 'utf8').includes('description: the user, in one line'), 'a memory note is edited the same way, saved with Ctrl+S, and the list says what it says now');
  await memoryWindow.getByRole('button', { name: '닫기' }).click();
  await memoryWindow.waitFor({ state: 'detached', timeout: 5000 });
  await background.getByRole('button', { name: 'Wait for the build 세부 정보' }).click();

  // The dashboard: every session as a card, in the place of what it is doing, with what runs in it. The
  // workspace stays as it is underneath, so its panes and terminals keep their size.
  const sizeNow = async () => {
    const { cols, rows } = await named('ui-check');
    return `${JSON.stringify(round(await paneBox()))} ${cols}×${rows}`;
  };
  const sizedBefore = await sizeNow();
  await tell('ui-agents', 'this needs approval');
  await page.getByRole('button', { name: '알림 · 승인·입력 대기 1' }).waitFor({ timeout: 10_000 });
  const screens = page.getByRole('navigation', { name: '화면' });
  await screens.getByRole('button', { name: '대시보드' }).click();
  const dashboard = page.getByRole('region', { name: '대시보드' });
  const placeOf = (name) => dashboard.getByRole('group', { name, exact: true });
  const waitingCard = placeOf('승인·입력 대기').getByRole('button', { name: 'ui-agents 열기' });
  await waitingCard.getByText('승인 대기 · Write').waitFor({ timeout: 10_000 });
  check(true, 'the dashboard: a session that waits for the user comes first');
  const loopCard = placeOf('예약').getByRole('button', { name: 'ui-check 열기' });
  const runs = loopCard.getByRole('group', { name: 'ui-check 실행 중' });
  await runs.getByText('1분마다 · 1회').waitFor({ timeout: 10_000 });
  check((await runs.getByText('Wait for the build').isVisible()) && (await runs.getByText('모니터 · deployed 3 of 5').isVisible()), 'a session with a loop has a place of its own, and its card lists what runs in it');
  await loopCard.getByText('pong', { exact: true }).waitFor({ timeout: 10_000 });
  check(await loopCard.getByText('use a skill', { exact: true }).isVisible(), 'a card says what its session was last asked, and what it said');
  check(!(await tree.isVisible()), 'the workspace is out of sight under the dashboard');
  await dashboard.getByRole('button', { name: /^종료 \d+$/ }).click();
  await dashboard.getByRole('button', { name: 'readme-cleanup 열기' }).getByText('새 작업: 장바구니 세금 계산을 고쳐 줘').waitFor({ timeout: 10_000 });
  check(true, 'ended sessions fold away there too, each with the last it was asked');
  await settle();
  await page.screenshot({ path: path.join(out, 'dashboard-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'dashboard-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  // The screen shown last is shown again, and the terminals under it start at the size they had.
  await page.reload();
  await enter();
  await waitingCard.waitFor({ timeout: 10_000 });
  check(!(await tree.isVisible()), 'a reload shows the dashboard again');
  await waitingCard.click();
  const asking = page.getByRole('region', { name: 'ui-agents', exact: true });
  await asking.locator('.xterm-screen').waitFor({ timeout: 10_000 });
  check((await screens.getByRole('button', { name: '워크스페이스' }).getAttribute('aria-pressed')) === 'true', 'a card shows its session in the workspace');
  await asking.locator('.xterm-screen').click();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '알림', exact: true }).waitFor({ timeout: 10_000 });
  await tree.getByRole('button', { name: 'ui-check 열기', exact: true }).click();
  await page.getByRole('region', { name: 'ui-check', exact: true }).locator('.xterm-screen').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const sizedAfter = await sizeNow();
  check(sizedBefore === sizedAfter, 'the pane and its terminal are the size they were before the dashboard', `${sizedBefore} → ${sizedAfter}`);
  // The reload folded what was open in the tree; as it was, for the scenes that follow.
  await tree.getByRole('button', { name: 'ui-agents 세부 정보' }).click();

  // The plan's usage over the last seven days, drawn from the usage log (a made-up one: the fake agent
  // reports no limits). It lies over the workspace as the dashboard does.
  await screens.getByRole('button', { name: '사용량' }).click();
  const usage = page.getByRole('region', { name: '사용량' });
  const windowOf = (name) => usage.getByRole('group', { name, exact: true });
  const chart = (name) => usage.getByRole('img', { name });
  await chart('5시간 창의 사용률').waitFor({ timeout: 10_000 });
  check(!(await tree.isVisible()), 'the workspace is out of sight under the usage screen');
  const stands = async (name) => Number(await windowOf(name).getByRole('meter', { name }).getAttribute('aria-valuenow'));
  check(
    (await stands('5시간')) === used.fiveHour && (await stands('주간')) === used.sevenDay,
    'each window says what it stands at now: the last reading of the log',
    `5시간 ${await stands('5시간')}% (${used.fiveHour}), 주간 ${await stands('주간')}% (${used.sevenDay})`,
  );
  check(await page.getByRole('button', { name: `사용량 5시간 ${used.fiveHour}%` }).isVisible(), 'the same number the chip in the top bar has');
  check(await windowOf('주간').getByText(/^이 속도면 /).isVisible(), 'the weekly window says where it is heading');
  // A window is a line of its own with a wash under it; a day is a column.
  const marks = async (name) => chart(name).locator('path').count();
  check((await marks('5시간 창의 사용률')) >= 6 && (await marks('주간 창의 사용률')) >= 2 && (await marks('하루에 쓴 양')) >= 3, 'the graphs draw the windows and the days of the log');
  await settle();
  await page.screenshot({ path: path.join(out, 'usage-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'usage-light.png') });
  // Pointed at, a time is marked in both graphs over time, and the one under the pointer says what both windows stood at.
  const plotBox = await chart('5시간 창의 사용률').boundingBox();
  await page.mouse.move(plotBox.x + plotBox.width * 0.62, plotBox.y + plotBox.height * 0.5);
  const told = windowOf('5시간').getByRole('tooltip');
  await told.waitFor({ timeout: 5000 });
  check(/5시간/.test(await told.innerText()) && /주간/.test(await told.innerText()), 'a time pointed at in a graph: what both windows stood at then');
  check((await windowOf('주간').getByRole('tooltip').count()) === 0 && (await chart('주간 창의 사용률').locator('line[stroke="var(--ah-on-2)"]').count()) === 1, 'the other graph marks the same time');
  const dayBox = await chart('하루에 쓴 양').boundingBox();
  await page.mouse.move(dayBox.x + dayBox.width * 0.5, dayBox.y + dayBox.height * 0.5);
  check(/\d+%\s*주간 한도 대비/.test(await windowOf('하루').getByRole('tooltip').innerText()), 'a day pointed at: what it took of the weekly limit');
  await page.mouse.move(plotBox.x + plotBox.width * 0.62, plotBox.y + plotBox.height * 0.5);
  await told.waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'usage-point-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await page.mouse.move(plotBox.x + plotBox.width * 0.62, plotBox.y + plotBox.height * 0.5 + 1);
  await told.waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'usage-point-dark.png') });
  // The same in rows.
  await usage.getByRole('group', { name: '보기' }).getByRole('button', { name: '표' }).click();
  const dayRows = windowOf('하루').getByRole('table').getByRole('row');
  await dayRows.first().waitFor({ timeout: 5000 });
  check((await dayRows.count()) === 8 && (await windowOf('5시간').getByRole('table').getByRole('row').count()) > 2, 'as rows: a window a row, and a row for each of the seven days');
  await settle();
  await page.screenshot({ path: path.join(out, 'usage-table-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'usage-table-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await usage.getByRole('group', { name: '보기' }).getByRole('button', { name: '그래프' }).click();
  await screens.getByRole('button', { name: '워크스페이스' }).click();
  await page.getByRole('region', { name: 'ui-check', exact: true }).locator('.xterm-screen').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  check(sizedBefore === (await sizeNow()), 'the pane and its terminal are the size they were before the usage screen', `${sizedBefore} → ${await sizeNow()}`);

  // Tabs and free splits. A session dropped on the head of a stack is a tab of it: only the pane on top is
  // drawn, and no terminal changes its size for it. Dropped at a side of a stack, it is a stack of its own there,
  // and the room between two stacks is dragged to share their room anew.
  const stackOf = (name) => page.getByRole('region', { name, exact: true });
  const boxOf = async (name) => round(await stackOf(name).boundingBox());
  const whole = await boxOf('ui-check');
  const screenOf = async (name) => round(await stackOf(name).locator('.xterm-screen').boundingBox());
  const screenWhole = await screenOf('ui-check');
  // The terminal that is up is marked, to tell afterwards that it is still that one: not taken down and put up again.
  const mark = (name) => stackOf(name).locator('.xterm').evaluate((element) => void (element.dataset.kept = 'yes'));
  const stillUp = async (name) => (await stackOf(name).locator('.xterm[data-kept="yes"]').count()) === 1;
  /** A row of the tree dragged by hand to a point of the page: where it would land shows while it is held there. */
  const dragRow = async (title, to, held) => {
    await row(title).hover();
    await page.mouse.down();
    await page.mouse.move(to.x - 24, to.y, { steps: 6 });
    // Twice: the second move is what tells the place that something is over it.
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await held();
    await page.mouse.up();
  };
  await dragRow('ui-agents', { x: whole.x + whole.width / 2, y: whole.y + 24 }, async () => {
    await stackOf('ui-check').getByText('탭으로 추가', { exact: true }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(out, 'tabs-drop-dark.png') });
  });
  const tabsOf = (name) => stackOf(name).getByRole('tablist', { name: '탭' });
  await tabsOf('ui-agents').getByRole('tab', { name: 'ui-agents', exact: true, selected: true }).waitFor({ timeout: 5000 });
  await stackOf('ui-agents').locator('.xterm-screen').waitFor({ timeout: 10_000 });
  check((await tabsOf('ui-agents').getByRole('tab').count()) === 2 && JSON.stringify(await boxOf('ui-agents')) === JSON.stringify(whole), 'a session dropped on the head of a stack is a tab of it, on top, in the same box');
  check((await page.locator('.xterm-screen').count()) === 1, 'only the pane on top is drawn: the terminal under the other tab is taken down');
  await settle();
  await page.screenshot({ path: path.join(out, 'tabs-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'tabs-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await tabsOf('ui-agents').getByRole('tab', { name: 'ui-check', exact: true }).click();
  await stackOf('ui-check').locator('.xterm-screen').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  check(sizedBefore === (await sizeNow()), 'picked again, a tab puts its terminal up at the size it had', `${sizedBefore} → ${await sizeNow()}`);
  check(JSON.stringify(await screenOf('ui-check')) === JSON.stringify(screenWhole), 'under the tabs a terminal has the box it had under the name of its pane', `${JSON.stringify(screenWhole)} → ${JSON.stringify(await screenOf('ui-check'))}`);

  // At the right side of the stack: the pane that shows the session moves out into a stack of its own.
  await mark('ui-check');
  await dragRow('ui-agents', { x: whole.x + whole.width * 0.92, y: whole.y + whole.height / 2 }, async () => {
    await stackOf('ui-check').getByText('오른쪽에 열기', { exact: true }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(out, 'split-drop-dark.png') });
  });
  await stackOf('ui-agents').locator('.xterm-screen').waitFor({ timeout: 10_000 });
  const [leftHalf, rightHalf] = [await boxOf('ui-check'), await boxOf('ui-agents')];
  check(
    Math.abs(leftHalf.width - rightHalf.width) < 1 && Math.abs(leftHalf.width + 12 + rightHalf.width - whole.width) < 1 && rightHalf.x > leftHalf.x + leftHalf.width && leftHalf.height === whole.height,
    'dropped at a side of a stack, it is a stack of its own there: the two share the room evenly',
    `${leftHalf.width} + 12 + ${rightHalf.width} of ${whole.width}`,
  );
  check((await tabsOf('ui-check').count()) === 0, 'a stack left with one pane shows its name as before, without tabs');
  check(await stillUp('ui-check'), 'the terminal of the stack that was there stays up while a stack is made beside it');
  const colsOf = async (title) => (await named(title)).cols;
  const colsWhole = Number(sizedBefore.split(' ').at(-1).split('×')[0]);
  const toldCols = async (title, fits) => {
    for (let tries = 0; tries < 60 && !fits(await colsOf(title)); tries += 1) await page.waitForTimeout(100);
    return colsOf(title);
  };
  check((await toldCols('ui-check', (cols) => cols < colsWhole)) < colsWhole, 'its terminal tells the PTY its new width once the layout has settled', `${colsWhole} → ${await colsOf('ui-check')} columns`);
  // The room between the two, dragged: one takes what the other gives. A double click shares it evenly again.
  const divider = page.getByRole('separator', { name: '칸 크기' });
  const grip = await divider.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 160, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  const [wider, narrower] = [await boxOf('ui-check'), await boxOf('ui-agents')];
  check(Math.abs(wider.width - leftHalf.width - 160) < 2 && Math.abs(narrower.width - rightHalf.width + 160) < 2, 'the room between two stacks is dragged to share their room anew', `${leftHalf.width} → ${wider.width}, ${rightHalf.width} → ${narrower.width}`);
  await settle();
  await page.screenshot({ path: path.join(out, 'split-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'split-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await divider.dblclick();
  check(Math.abs((await boxOf('ui-check')).width - leftHalf.width) < 1, 'a double click on it shares the room evenly again');
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  check((await boxOf('ui-check')).width < leftHalf.width, 'and the arrow keys move it by a step');
  // An area too narrow for stacks side by side has them one above the other, each as wide as the area.
  const kept = [await boxOf('ui-check'), await boxOf('ui-agents')];
  await page.setViewportSize({ width: 1000, height: 900 });
  const [upper, lower] = [await boxOf('ui-check'), await boxOf('ui-agents')];
  check(
    upper.x === lower.x && upper.width === lower.width && upper.width > kept[0].width && Math.abs(lower.y - upper.y - upper.height - 12) < 1 && (await divider.isHidden()),
    'in a window too narrow for them side by side, the stacks lie one above the other, each as wide as the area',
    JSON.stringify([upper, lower]),
  );
  await settle();
  await page.screenshot({ path: path.join(out, 'split-narrow-dark.png') });
  await page.setViewportSize({ width: 1360, height: 900 });
  check(JSON.stringify([await boxOf('ui-check'), await boxOf('ui-agents')]) === JSON.stringify(kept) && (await stillUp('ui-check')), 'and side by side again, as they were, once there is room');
  // The layout is kept: a reload shows the same stacks at the same shares.
  await page.reload();
  await enter();
  await stackOf('ui-agents').locator('.xterm-screen').waitFor({ timeout: 10_000 });
  check(JSON.stringify([await boxOf('ui-check'), await boxOf('ui-agents')]) === JSON.stringify(kept), 'a reload shows the same stacks, each with the share it had');
  // Closed, a stack gives its room back, and the terminal that stays is told its old size again.
  await stackOf('ui-check').locator('.xterm-screen').waitFor({ timeout: 10_000 });
  await mark('ui-check');
  await stackOf('ui-agents').getByRole('button', { name: 'ui-agents 칸 닫기' }).click();
  await stackOf('ui-agents').waitFor({ state: 'detached', timeout: 5000 });
  await toldCols('ui-check', (cols) => cols === colsWhole);
  check(sizedBefore === (await sizeNow()), 'a stack closed gives its room back: the pane that stays is the size it was', `${sizedBefore} → ${await sizeNow()}`);
  check(await stillUp('ui-check'), 'and its terminal stayed up through it');
  // The reload folded what was open in the tree; as it was, for the scenes that follow.
  await tree.getByRole('button', { name: 'ui-agents 세부 정보' }).click();

  // Delegation: a session works for another; a piece of the lead's conversation goes to it, and its answer comes back.
  for (const title of ['ui-lead', 'ui-helper']) {
    await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'fake', title, cwd: work, theme: 'dark' }),
    });
  }
  await row('ui-helper').waitFor({ timeout: 10_000 });
  await row('ui-helper').dragTo(row('ui-lead'));
  await page.getByRole('group', { name: 'ui-helper → ui-lead' }).getByRole('button', { name: '위임' }).click();
  await row('ui-helper').getByRole('img', { name: '위임' }).waitFor({ timeout: 5000 });
  check(true, 'a session dropped on another can be delegated to');
  await page.getByRole('button', { name: 'ui-lead 열기', exact: true }).click();
  const lead = page.getByRole('region', { name: 'ui-lead' });
  await lead.locator('.xterm-screen').waitFor({ timeout: 10_000 });
  await ready('ui-lead');
  await box.fill('please outline the plan');
  await box.press('Control+Enter');
  await lead.getByRole('button', { name: '대화', exact: true }).click();
  const answer = lead.locator('.ah-answer', { hasText: 'fake answer: please outline the plan' });
  await answer.waitFor({ timeout: 10_000 });
  const helperChip = lead.getByRole('button', { name: 'ui-helper 위임' });
  check(await helperChip.isVisible(), "the delegate is a chip in the lead's header");
  // The reply's handle drags; the reply itself stays text to select.
  await answer.hover();
  await answer.getByRole('button', { name: '위임' }).dragTo(helperChip);
  const card = lead.getByRole('group', { name: '위임 · ui-helper' });
  await card.getByRole('button', { name: '전달' }).waitFor({ timeout: 10_000 });
  check(await card.getByText('fake answer: fake answer: please outline the plan').isVisible(), 'the delegate worked on it, and its answer shows on the card');
  await settle();
  await page.screenshot({ path: path.join(out, 'delegate-dark.png') });
  await card.getByRole('button', { name: '전달' }).click();
  await card.getByText('전달됨').waitFor({ timeout: 10_000 });
  await lead.getByText('[위임 결과 · ui-helper]', { exact: false }).first().waitFor({ timeout: 10_000 });
  check(true, 'handed back: the lead got the answer as a message');
  // Without dragging: the answer's own 위임 button.
  const second = lead.locator('.ah-answer', { hasText: 'fake answer: [위임 결과 · ui-helper]' });
  await second.waitFor({ timeout: 10_000 });
  await second.hover();
  await second.getByRole('button', { name: '위임' }).click();
  await page.getByRole('menuitem', { name: 'ui-helper' }).click();
  await lead.getByRole('group', { name: '위임 · ui-helper' }).nth(1).waitFor({ timeout: 10_000 });
  check(true, 'handed over from the menu as well');
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'delegate-light.png') });

  // Work in the user's own words: with the delegate among the composer's recipients, 위임 hands the
  // text over from the session it works for, and a card follows it like any other work.
  const composer = page.getByRole('region', { name: '입력', exact: true });
  const handOver = composer.getByRole('button', { name: '위임', exact: true });
  check((await handOver.count()) === 0, 'the composer only sends while no recipient is a delegate');
  await row('ui-helper').dragTo(composer);
  await composer.getByRole('img', { name: '위임' }).waitFor({ timeout: 5000 });
  await box.fill('summarize the risks');
  await handOver.click();
  await page.getByText('1개 세션에 위임').waitFor({ timeout: 10_000 });
  const cards = lead.getByRole('group', { name: '위임 · ui-helper' });
  await cards.nth(2).waitFor({ timeout: 10_000 });
  check(await cards.nth(2).getByText('fake answer: summarize the risks').isVisible(), 'the composer hands its text to a delegate as work, and the card follows it');
  await box.fill('list the open questions');
  await settle();
  await page.screenshot({ path: path.join(out, 'composer-delegate-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'composer-delegate-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await box.press('Control+Shift+Enter');
  await cards.nth(3).waitFor({ timeout: 10_000 });
  check(await cards.nth(3).getByText('fake answer: list the open questions').isVisible(), 'and from the keyboard, with Ctrl+Shift+Enter');
  await composer.getByRole('button', { name: 'ui-helper 빼기' }).click();
  await handOver.waitFor({ state: 'detached', timeout: 5000 });

  // The dashboard again, with more on it: idle sessions, each with the last it was asked and said, one of
  // them working for another. Back by the switch, the workspace is as it was left.
  await screens.getByRole('button', { name: '대시보드' }).click();
  const helperCard = placeOf('대기').getByRole('button', { name: 'ui-helper 열기' });
  await helperCard.getByText('fake answer: list the open questions').waitFor({ timeout: 10_000 });
  check((await helperCard.getByRole('img', { name: '위임' }).isVisible()) && (await helperCard.getByText('ui-lead', { exact: true }).isVisible()), 'the card of a delegate names the session it works for');
  check((await placeOf('대기').getByRole('button', { name: /열기$/ }).count()) === 3, 'idle sessions have their place, a card each');
  await settle();
  await page.screenshot({ path: path.join(out, 'dashboard-more-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'dashboard-more-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await screens.getByRole('button', { name: '워크스페이스' }).click();
  check((await cards.nth(3).getByText('fake answer: list the open questions').isVisible()) && (await box.inputValue()) === '', 'back by the switch, the conversation the pane showed is where it was');

  // The graph: every session with what runs under it. Who is under whom as cards tied by lines, then
  // when each worked as lanes over time. It lies over the workspace as the dashboard does.
  await screens.getByRole('button', { name: '그래프' }).click();
  const graph = page.getByRole('region', { name: '그래프' });
  const map = graph.getByRole('group', { name: '관계' });
  const node = (name) => map.getByRole('button', { name: `${name} 열기`, exact: true });
  await node('ui-helper').waitFor({ timeout: 10_000 });
  check(!(await tree.isVisible()), 'the workspace is out of sight under the graph');
  const endsAt = async (name) => {
    const at = await node(name).boundingBox();
    return at.x + at.width;
  };
  const startsAt = async (name) => (await node(name).boundingBox()).x;
  check(
    (await startsAt('ui-helper')) > (await endsAt('ui-lead')) && (await startsAt('Plan the change')) > (await endsAt('ui-agents')) && (await startsAt('Check the tests')) > (await endsAt('Plan the change')),
    'the graph: what is under a session is to its right, and what a sub-agent started further right',
  );
  check((await node('Wait for the build').isVisible()) && (await node('check the deploy').isVisible()), 'what a session runs by itself is there too: a command in the background, a prompt set for it');
  check((await node('Run the tests').count()) === 0 && (await node('readme-cleanup').count()) === 0, 'a command that ended is not, and an ended session is folded away');
  check(await map.getByText('완료', { exact: true }).isVisible(), 'the line of a delegation says how the work handed over stands');
  const under = (await map.getByRole('button', { name: /열기$/ }).count()) - 3;
  check((await map.locator('svg path[fill="none"]').count()) === under && under >= 7, 'every node under another is tied to it by a line', `${under} under the three sessions at the top`);
  await settle();
  await page.screenshot({ path: path.join(out, 'graph-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'graph-dark.png') });
  // Pointed at, a node shows with what it is under and what is under it; the rest steps back.
  await node('Plan the change').hover();
  await page.waitForTimeout(400);
  const shows = (name) => node(name).evaluate((element) => Number(getComputedStyle(element).opacity));
  check((await shows('ui-agents')) === 1 && (await shows('Check the tests')) === 1 && (await shows('Look around')) < 1 && (await shows('ui-lead')) < 1, 'a node pointed at: what is above and under it stays, the rest steps back');
  await page.screenshot({ path: path.join(out, 'graph-point-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await node('Plan the change').hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'graph-point-light.png') });
  // Only what runs: a session all of whose sub-agents are done goes, one with a command still running stays.
  const filters = graph.getByRole('group', { name: '거르기' });
  await filters.getByRole('button', { name: '실행 중' }).click();
  await node('ui-agents').waitFor({ state: 'detached', timeout: 5000 });
  check((await node('ui-check').isVisible()) && (await node('Wait for the build').isVisible()) && (await node('ui-lead').count()) === 0, 'only what runs: what is busy now, with what it is under');
  await filters.getByRole('button', { name: '전체' }).click();
  // The ended sessions come back from their fold.
  await graph.getByRole('button', { name: /^종료 \d+$/ }).click();
  await node('readme-cleanup').waitFor({ timeout: 5000 });
  await graph.getByRole('button', { name: /^종료 \d+$/ }).click();
  await node('readme-cleanup').waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'ended sessions fold away at the end, and come back from there');
  // The same over time: a lane each, all sessions on one sheet.
  await graph.getByRole('group', { name: '보기' }).getByRole('button', { name: '흐름' }).click();
  const lanes = graph.getByRole('list', { name: '흐름' });
  await lanes.getByRole('button', { name: 'ui-helper 열기' }).waitFor({ timeout: 10_000 });
  check((await lanes.getByRole('listitem').count()) === (await lanes.getByRole('button', { name: /열기$/ }).count()) && (await lanes.getByRole('listitem').count()) >= 10, 'the lanes: a row for every node of the graph, in the order of the tree');
  // A session's turns come from its transcript: its bars are there once they were read.
  // A lane is its name, then its track: the bars lie in the track, between the marks of the time.
  const barsOf = (name) => lanes.getByRole('button', { name: `${name} 열기`, exact: true }).locator(':scope > span:nth-child(2) > span:not([aria-hidden])');
  await barsOf('ui-lead').first().waitFor({ timeout: 10_000 });
  for (const [name, turns] of [['ui-helper', 3], ['ui-lead', 2], ['ui-check', 3], ['ui-agents', 2]]) await barsOf(name).nth(turns - 1).waitFor({ timeout: 10_000 });
  check(
    (await barsOf('ui-lead').count()) >= 2 && (await barsOf('ui-helper').count()) >= 3 && (await barsOf('Wait for the build').count()) === 1 && (await barsOf('check the deploy').count()) === 0,
    'a session has a bar for each of its turns, a running command one that grows, a prompt set for later none',
    `ui-lead ${await barsOf('ui-lead').count()}, ui-helper ${await barsOf('ui-helper').count()}`,
  );
  await settle();
  await page.screenshot({ path: path.join(out, 'graph-lanes-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'graph-lanes-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  // A lane opens its node in the workspace: a sub-agent in its session's flow, pointed out.
  await lanes.getByRole('button', { name: 'Look around 열기' }).click();
  const pointedOut = page.getByRole('region', { name: 'ui-agents' }).getByRole('list', { name: 'ui-agents 흐름' }).locator('[aria-current="true"]');
  await pointedOut.waitFor({ timeout: 10_000 });
  check((await pointedOut.innerText()).trim() === 'Look around' && (await screens.getByRole('button', { name: '워크스페이스' }).getAttribute('aria-pressed')) === 'true', 'a node opens in the workspace: a sub-agent in the flow of its session, pointed out');
  // As it was for the scenes that follow: the lead's conversation in the pane.
  await tree.getByRole('button', { name: 'ui-lead 열기', exact: true }).click();
  await lead.getByRole('button', { name: '대화', exact: true }).click();
  await cards.nth(3).waitFor({ timeout: 10_000 });

  // An answer nested too deep for the markdown parser shows as plain text, and the rest of the app stays.
  await box.fill(`deep\n${'- '.repeat(5000)}end`);
  await box.press('Control+Enter');
  const deep = lead.locator('.ah-answer', { hasText: 'fake answer: deep' });
  // 10 KB through the terminal and back through the transcript: it takes a while.
  await deep.waitFor({ timeout: 40_000 });
  const nested = await deep.locator('ul ul ul').count();
  check(nested === 0 && (await deep.innerText()).includes('- - - '), 'an answer nested too deep to draw shows as plain text', `nested lists: ${nested}`);
  check(await tree.isVisible(), 'and the rest of the app stays');
  // Drawn anew (the pane to its terminal and back), it is not parsed again: the parser gives up only
  // once the stack is full, and each try holds the page for seconds.
  await lead.getByRole('button', { name: /^터미널/ }).click();
  await lead.locator('.xterm-screen').waitFor({ timeout: 10_000 });
  const redrawnAt = Date.now();
  await lead.getByRole('button', { name: '대화', exact: true }).click();
  await deep.waitFor({ timeout: 40_000 });
  const redrawnIn = Date.now() - redrawnAt;
  check(redrawnIn < 2500, 'drawn anew, it is plain text at once: the parser is not tried a second time', `${redrawnIn} ms`);

  // Ended from AgentHouse, a session stays listed, ended, with its conversation.
  const agentsDetails = tree.getByRole('button', { name: 'ui-agents 세부 정보' });
  if ((await agentsDetails.getAttribute('aria-expanded')) === 'true') await agentsDetails.click(); // left open above
  await tree.getByRole('button', { name: 'ui-helper 세부 정보' }).click();
  await tree.getByRole('button', { name: '세션 종료' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '세션 종료' }).click();
  await row('ui-helper').getByRole('img', { name: /^종료/ }).waitFor({ timeout: 10_000 });
  check(true, 'a session ended from AgentHouse stays listed, ended');

  // And starts again from there: the same row, running, with the conversation it had.
  const again = tree.getByRole('button', { name: '이어서 열기' });
  await again.waitFor({ timeout: 5000 });
  await settle();
  await page.screenshot({ path: path.join(out, 'resume-light.png') });
  await again.click();
  await ready('ui-helper');
  const helper = page.getByRole('region', { name: 'ui-helper', exact: true });
  await helper.locator('.xterm-screen').waitFor({ timeout: 10_000 });
  check((await tree.getByRole('button', { name: 'ui-helper 열기', exact: true }).count()) === 1, 'an ended session starts again in its own row, and its terminal shows in a pane');
  await helper.getByRole('button', { name: '대화', exact: true }).click();
  await helper.getByText('fake answer: fake answer: please outline the plan', { exact: true }).first().waitFor({ timeout: 10_000 });
  check(true, 'with the conversation it had before it ended');

  // Sessions started outside AgentHouse, in a terminal or an editor (made up here: the fake agent
  // prints them as Claude's own list of sessions): with the others in the tree and on the dashboard,
  // marked, and only read. Watching them is turned off and on again, which asks for the list at once
  // instead of at the next interval.
  const outside = path.join(scratch, 'infra');
  mkdirSync(outside, { recursive: true });
  const [asks, digs, fresh] = writeOutsideSessions({ config, cwd: work, other: outside });
  const watching = (checked) => page.getByRole('switch', { name: '외부 세션', checked });
  await bell.click();
  check(await watching(true).isVisible(), 'sessions started elsewhere are watched unless that is turned off');
  await watching(true).click();
  await watching(false).waitFor({ timeout: 5000 });
  await watching(false).click();
  await watching(true).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await row(asks.name).getByText('외부', { exact: true }).waitFor({ timeout: 10_000 });
  check(await row(asks.name).getByText('Sonnet 5.5 · 승인 대기').isVisible(), 'a session started in a terminal is in the tree, marked, with its model and what it is doing');
  check((await tree.getByText('infra', { exact: true }).count()) === 1 && (await row(fresh.name).getByText('Claude Code', { exact: true }).isVisible()), 'in its folder; one nobody asked anything yet has a name and a state');
  await page.getByRole('button', { name: '알림 · 승인·입력 대기 1' }).waitFor({ timeout: 10_000 });
  check(true, 'the bell counts one that waits for an approval');

  await tree.getByRole('button', { name: `${digs.name} 열기`, exact: true }).click();
  const watched = page.getByRole('region', { name: digs.name, exact: true });
  await watched.getByText('어제 배포 뒤 오류 로그를 유형별로 묶어 줘').waitFor({ timeout: 10_000 });
  check(
    (await watched.getByText('외부', { exact: true }).isVisible()) && (await watched.getByRole('button', { name: /^터미널/ }).count()) === 0 && (await watched.getByRole('button', { name: '흐름', exact: true }).isVisible()),
    'its pane shows its conversation, marked: there is no terminal to switch to',
  );
  check(await watched.getByText(/Opus 5\.5 · high · 입력/).first().isVisible(), 'with the model and the effort its transcript names');
  check((await composer.getByText(digs.name).count()) === 0 && (await box.isVisible()), 'the composer has nobody to send to: such a session takes no messages');
  const endings = () => tree.getByRole('button', { name: /^(세션 종료|목록에서 제거|아래로 넣기|이어서 열기)$/ }).count();
  const keysBefore = await endings();
  await tree.getByRole('button', { name: `${asks.name} 세부 정보` }).click();
  await tree.getByText(String(asks.pid), { exact: true }).waitFor({ timeout: 5000 });
  check((await endings()) === keysBefore && (await tree.getByText('Claude Code 2.1.326', { exact: true }).isVisible()), 'its details are read, with nothing to press');
  await settle();
  await page.screenshot({ path: path.join(out, 'external-light.png') });
  await page.getByRole('button', { name: '다크 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'external-dark.png') });

  await screens.getByRole('button', { name: '대시보드' }).click();
  const asksCard = placeOf('승인·입력 대기').getByRole('button', { name: `${asks.name} 열기` });
  await asksCard.getByText('주문 테이블에 인덱스를 추가하는 마이그레이션을 만들어 줘').waitFor({ timeout: 10_000 });
  check(await asksCard.getByText('외부', { exact: true }).isVisible(), 'on the dashboard it stands with the others by what it is doing, marked: one that asks comes first');
  check(
    (await placeOf('작업 중').getByRole('button', { name: `${digs.name} 열기` }).getByText('infra · Opus 5.5 · high').isVisible()) &&
      (await placeOf('대기').getByRole('button', { name: `${fresh.name} 열기` }).getByText('infra · Claude Code').isVisible()),
    'its card says its folder and what it runs with, as far as that is known',
  );
  await settle();
  await page.screenshot({ path: path.join(out, 'external-dashboard-dark.png') });
  await page.getByRole('button', { name: '라이트 모드' }).click();
  await settle();
  await page.screenshot({ path: path.join(out, 'external-dashboard-light.png') });

  await bell.click();
  check(await page.getByRole('menuitem', { name: new RegExp(asks.name) }).getByText('외부', { exact: true }).isVisible(), 'the bell lists it, marked');
  await settle();
  await page.screenshot({ path: path.join(out, 'external-bell-light.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '다크 모드' }).click();
  await bell.click();
  await settle();
  await page.screenshot({ path: path.join(out, 'external-bell-dark.png') });
  // Turned off: they are gone from every place, the pane that showed one too, and nobody waits any more.
  await watching(true).click();
  await watching(false).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await asksCard.waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByRole('button', { name: '알림', exact: true }).waitFor({ timeout: 10_000 });
  await screens.getByRole('button', { name: '워크스페이스' }).click();
  check((await watched.count()) === 0 && (await row(asks.name).count()) === 0, 'turned off, they are gone: from the dashboard, the tree, the bell and the pane that showed one');
  await page.getByRole('button', { name: '라이트 모드' }).click();

  check(errors.length === 0, 'no errors in the browser console', errors.join(' | '));
  console.log(`INFO  screenshots: ${out}`);
} catch (error) {
  check(false, 'the check ran to the end', error.message.split('\n')[0]);
  await page.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {});
  console.log(`INFO  where it stopped: ${path.join(out, 'failed.png')}`);
  // What it was waiting for, and the line of this file that waited.
  const waited = error.message.split('\n').slice(1).filter((line) => line.trim());
  const line = error.stack?.split('\n').find((frame) => frame.includes('ui-check.mjs'));
  for (const said of [...waited, ...(line ? [line.trim()] : [])]) console.log(`INFO  ${said}`);
} finally {
  await browser.close();
  server.kill();
  try {
    execFileSync(process.execPath, [main, '--stop'], { env, stdio: 'ignore' });
  } catch {
    // the host may already be gone
  }
  if (flag('--out')) {
    try {
      console.log(`INFO  page: ${writePage({ out, before: before || null, since: started, labels: SCENES })}`);
    } catch (error) {
      check(false, 'the screenshots are on one page', error.message);
    }
  } else console.log('INFO  (screenshots are removed with the temporary folder unless --out is given)');
  // The whole temporary folder: with --out the screenshots are elsewhere, and what was left of it
  // (the work folder) piled up in the temp folder, one per run.
  setTimeout(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exitCode = failures ? 1 : 0;
}
