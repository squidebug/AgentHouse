#!/usr/bin/env node
// Drives the built app in the installed Chrome (headless, nothing downloaded)
// with the fake agent: a session opens in a pane, a message goes through the
// composer, and the pane's conversation view shows the turn with its tool call.
// Then an ended session that an earlier session host left in sessions.json
// (ui-sample.mjs) shows its conversation. Light and dark screenshots go to the
// output folder. Uses throwaway state and
// Claude config folders, so it never touches real sessions or ~/.claude.
//   pnpm build && pnpm ui:check [-- --out <folder>] [-- --headed]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

const server = spawn(process.execPath, [main, '--port', '0', '--json', '--allow-fake', '--cwd', work], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const { url, port, token } = JSON.parse(await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)));
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

try {
  await page.emulateMedia({ colorScheme: 'dark' });
  // The terminal draws on a canvas (WebGL); its text is checked on the server side by the tests.
  const terminalShown = () => page.locator('.xterm-screen').first().waitFor({ timeout: 10_000 });
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading', { name: 'AgentHouse' }).waitFor();

  const created = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { cookie: `ah_token=${token}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: 'fake', title: 'ui-check', cwd: work, theme: 'dark' }),
  });
  check(created.status === 201, 'a session starts', `HTTP ${created.status}`);

  await page.getByRole('button', { name: 'ui-check 열기' }).click();
  await terminalShown();
  check(true, 'the pane shows its terminal');

  const box = page.getByRole('textbox', { name: '메시지' });
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
  await page.getByRole('button', { name: /Bash/ }).click();
  await page.getByText('fake-tool-output', { exact: true }).waitFor({ timeout: 5000 });
  check(true, 'an opened tool call shows its output');
  check(await page.getByText(/fake-model · low · 입력/).isVisible(), 'the turn shows model, effort and tokens');

  // Out of the way of hover styles and tooltips, after animations settle.
  const settle = async () => {
    await page.mouse.move(1, 899);
    await page.locator('body').evaluate((body) => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(700);
  };
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
  await page.reload();
  await terminalShown();
  await settle();
  await page.screenshot({ path: path.join(out, 'terminal-light.png') });

  // An ended session from an earlier host: its conversation is all that is left.
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
    headers: { cookie: `ah_token=${token}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: 'fake', title: 'ui-agents', cwd: work, theme: 'dark' }),
  });
  check(agents.status === 201, 'a session for sub-agents starts', `HTTP ${agents.status}`);
  // The tree; the flow view and pane headers have buttons of the same names.
  const tree = page.getByRole('complementary', { name: '세션' });
  await tree.getByRole('button', { name: 'ui-agents 열기' }).click();
  await terminalShown();
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
      headers: { cookie: `ah_token=${token}`, origin, 'content-type': 'application/json' },
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
  await box.fill('please outline the plan');
  await box.press('Control+Enter');
  await lead.getByRole('button', { name: '대화', exact: true }).click();
  const answer = lead.locator('.ah-answer', { hasText: 'fake answer: please outline the plan' });
  await answer.waitFor({ timeout: 10_000 });
  const helperChip = lead.getByRole('button', { name: 'ui-helper 위임' });
  check(await helperChip.isVisible(), "the delegate is a chip in the lead's header");
  await answer.dragTo(helperChip);
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
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
    if (!flag('--out')) rmSync(scratch, { recursive: true, force: true });
  }, 500);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exitCode = failures ? 1 : 0;
}
