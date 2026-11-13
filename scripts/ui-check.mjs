#!/usr/bin/env node
// Drives the built app in the installed Chrome (headless, nothing downloaded)
// with the fake agent: the login, a session in a pane, a message through the
// composer and its turn in the pane's conversation view, an ended session that
// an earlier session host left in sessions.json (ui-sample.mjs), sub-agents,
// groups and delegation. Light and dark screenshots go to the output folder.
// Uses throwaway state and Claude config folders, so it never touches real
// sessions or ~/.claude.
//   pnpm build && pnpm ui:check [-- --out <folder>] [-- --headed]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeSampleSession } from './ui-sample.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'apps/server/dist/main.js');
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
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
  // A refused choice of executable is a 400 the check provokes on purpose; Chrome logs it as an error.
  const provoked = (message) => message.location().url.includes('/api/cli/') && /status of 400/.test(message.text());
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
  // The tool's row; the session's row may still read "작업 중 · Bash" for a moment.
  await page.getByRole('button', { name: /Bash echo/ }).click();
  await page.getByText('fake-tool-output', { exact: true }).waitFor({ timeout: 5000 });
  check(true, 'an opened tool call shows its output');
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
  await page.getByRole('button', { name: '묶기', exact: true }).click();
  await page.getByRole('menuitem', { name: 'ui-check' }).click();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ timeout: 5000 });
  check(true, 'grouped without dragging, from the menu');
  await page.getByRole('button', { name: '최상위로' }).click();
  await row('ui-agents').getByRole('img', { name: '묶음' }).waitFor({ state: 'detached', timeout: 5000 });

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

  // An answer nested too deep for the markdown parser shows as plain text, and the rest of the app stays.
  await box.fill(`deep\n${'- '.repeat(5000)}end`);
  await box.press('Control+Enter');
  const deep = lead.locator('.ah-answer', { hasText: 'fake answer: deep' });
  // 10 KB through the terminal and back through the transcript: it takes a while.
  await deep.waitFor({ timeout: 40_000 });
  const nested = await deep.locator('ul ul ul').count();
  check(nested === 0 && (await deep.innerText()).includes('- - - '), 'an answer nested too deep to draw shows as plain text', `nested lists: ${nested}`);
  check(await tree.isVisible(), 'and the rest of the app stays');

  // Ended from AgentHouse, a session stays listed, ended, with its conversation.
  const agentsDetails = tree.getByRole('button', { name: 'ui-agents 세부 정보' });
  if ((await agentsDetails.getAttribute('aria-expanded')) === 'true') await agentsDetails.click(); // left open above
  await tree.getByRole('button', { name: 'ui-helper 세부 정보' }).click();
  await tree.getByRole('button', { name: '세션 종료' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '세션 종료' }).click();
  await row('ui-helper').getByRole('img', { name: /^종료/ }).waitFor({ timeout: 10_000 });
  check(true, 'a session ended from AgentHouse stays listed, ended');

  check(errors.length === 0, 'no errors in the browser console', errors.join(' | '));
  console.log(`INFO  screenshots: ${out}`);
} catch (error) {
  check(false, 'the check ran to the end', error.message.split('\n')[0]);
  await page.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {});
  console.log(`INFO  where it stopped: ${path.join(out, 'failed.png')}`);
} finally {
  await browser.close();
  server.kill();
  try {
    execFileSync(process.execPath, [main, '--stop'], { env, stdio: 'ignore' });
  } catch {
    // the host may already be gone
  }
  if (!flag('--out')) console.log('INFO  (screenshots are removed with the temporary folder unless --out is given)');
  // The whole temporary folder: with --out the screenshots are elsewhere, and what was left of it
  // (the work folder) piled up in the temp folder, one per run.
  setTimeout(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exitCode = failures ? 1 : 0;
}
