// End-to-end tests. Run: cd /workspace/pwtest && node /workspace/flashcards/tests/e2e.js  (needs playwright + chromium installed there,
// /tmp/fc-test/original.html = `git show 0066785:flashcards.html`, and /tmp/fc-test/dist-samples.html built from decks/samples via build.sh --inbox).
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = '/workspace/flashcards', T = '/tmp/fc-test', SHOTS = ROOT + '/screens';
const APP = 'file://' + ROOT + '/flashcards.html', ORIG = 'file://' + T + '/original.html';
const SAMPLES = 'file://' + T + '/dist-samples.html', REAL = 'file://' + ROOT + '/dist/flashcards.html';
const S1 = ROOT + '/decks/samples/sample-c202-ch01.json', S2 = ROOT + '/decks/samples/sample-c202-ch02.json';
let browser, pass = 0, fail = 0; const errors = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } }
async function page(opts = {}) {
  const ctx = await browser.newContext(opts.device ? { ...devices[opts.device] } : { viewport: opts.viewport || { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.dialogAnswers = []; p.dialogLog = [];
  p.on('dialog', (d) => { p.dialogLog.push(d.message()); const a = p.dialogAnswers.length ? p.dialogAnswers.shift() : true; a ? d.accept() : d.dismiss(); });
  p.on('pageerror', (e) => errors.push(`[pageerror ${p.url()}] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[console ${p.url()}] ${m.text()}`); });
  return { ctx, p };
}
const S = (p, fn, arg) => p.evaluate(fn, arg);
async function importFile(p, file) {
  await p.click('#importBtn'); await p.setInputFiles('#mergeFile', file);
  await p.waitForSelector('#importSummary'); const t = await p.textContent('#importSummary'); await p.click('#closeSummary'); return t;
}
function tmpJson(name, obj) { const f = path.join(T, name); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; }
async function noBroke(p) { return !(await p.locator('text=Something broke').count()); }
async function answerBoss(p, rightFn) {
  for (let i = 0; ; i++) {
    if (await p.locator('#bossResult').count()) break;
    const idx = await S(p, (want) => view.boss.choices.findIndex((c) => want ? c.correct : !c.correct), rightFn(i));
    await p.click(`[data-bpick="${idx}"]`); await p.click('#bossNext');
  }
}

async function makeV1Data() {
  console.log('\n[setup] create real v1 data with the ORIGINAL app');
  const { ctx, p } = await page();
  await p.goto(ORIG);
  await p.click('.folder-card'); await p.click('#studyBtn');
  for (let i = 0; i < 6; i++) { await p.click('#flipBtn'); await p.click(i === 2 ? '#missBtn' : '#gotBtn'); }
  await p.click('#exitStudy'); await p.click('#backHome');
  await p.click('#newFolderBtn'); await p.fill('#folderName', 'My Own Folder'); await p.click('#saveFolder');
  await p.click('.folder-card >> text=My Own Folder'); await p.click('#addCardBtn');
  await p.fill('#cardFront', 'Custom term'); await p.fill('#cardSubtitle', '2024'); await p.fill('#cardNote', 'my note'); await p.fill('#cardAnswer', 'My own answer'); await p.fill('#cardPoints', 'pt one\npt two');
  await p.click('#saveCard');
  const raw = await S(p, () => localStorage.getItem('flashcards.v1'));
  await ctx.close();
  return raw;
}

async function testV1(raw) {
  console.log('\n[1] Old v1 data loads unchanged with progress intact');
  const old = JSON.parse(raw);
  ok(Object.keys(old.progress).length >= 5, `original app recorded progress for ${Object.keys(old.progress).length} cards`);
  const { ctx, p } = await page();
  await p.goto(ORIG); await S(p, (r) => localStorage.setItem('flashcards.v1', r), raw);
  await p.goto(APP);
  const st = await S(p, () => JSON.parse(JSON.stringify(state)));
  let same = old.folders.every((f) => { const n = st.folders.find((x) => x.id === f.id); return n && Object.keys(f).every((k) => JSON.stringify(n[k]) === JSON.stringify(f[k])); });
  ok(same && st.folders.length === old.folders.length, 'all folders preserved with identical fields');
  same = old.cards.every((c) => { const n = st.cards.find((x) => x.id === c.id); return n && Object.keys(c).every((k) => JSON.stringify(n[k]) === JSON.stringify(c[k])); });
  ok(same && st.cards.length === old.cards.length, `all ${old.cards.length} cards preserved with identical fields (incl. legacy year/extra/purpose/protections)`);
  ok(Object.entries(old.progress).every(([k, v]) => JSON.stringify(st.progress[k]) === JSON.stringify(v)), 'all progress entries identical');
  ok(st.schema === 2 && typeof st.bundled === 'object', 'migration added schema/bundled defaults');
  ok(await p.locator('.folder-card').count() === 2 && await noBroke(p), 'home renders both folders');
  const mastered = await p.textContent('.folder-card >> nth=0');
  ok(/17 cards/.test(mastered), 'U.S. Employment Law still shows 17 cards: ' + mastered.replace(/\s+/g, ' ').trim().slice(0, 80));
  await p.click('.folder-card >> text=My Own Folder'); await p.click('#studyBtn');
  ok(!(await p.locator('.flash .readmore').count()) && !(await p.textContent('#flipCard')).includes('my note'), 'study front does not show the note');
  await p.click('#flipBtn');
  ok((await p.textContent('#flipCard .readmore')).includes('my note'), 'note shows on the back as a Note line');
  await p.click('#gotBtn');
  const saved = await S(p, () => localStorage.getItem('flashcards.v1'));
  await p.goto(ORIG);
  ok(await noBroke(p) && await p.locator('.folder-card').count() === 2, 'downgrade: original app still opens data saved by the new app');
  await ctx.close();
  return raw;
}

async function testMergeImport() {
  console.log('\n[2] Merge import / re-import / updated deck / backup merge / restore');
  const { ctx, p } = await page();
  await p.goto(APP);
  ok(/1 folder added · 12 cards added · 0 updated/.test(await importFile(p, S1)), 'deck import: 1 folder, 12 cards added');
  await S(p, () => { state.progress['c202-ch01-001'] = { streak: 2, retired: false }; state.progress['c202-ch01-014'] = { streak: 3, retired: true }; save(); });
  await p.click('[data-open="deck-c202-ch01"]'); await p.click('#renameFolder'); await p.fill('#folderName', 'My Ch1'); await p.click('#saveFolder'); await p.click('#backHome');
  const t2 = await importFile(p, S1);
  ok(/0 folders added · 0 cards added · 0 updated · 12 already up to date/.test(t2), 're-import: no changes (' + t2 + ')');
  let st = await S(p, () => state);
  ok(st.cards.length === 29 && st.folders.length === 2, 'no duplicate folders/cards after re-import');
  ok(st.progress['c202-ch01-001'].streak === 2 && st.progress['c202-ch01-014'].retired, 'progress kept after re-import');
  const d = JSON.parse(fs.readFileSync(S1, 'utf8'));
  d.folder = 'C202 Ch 1: Renamed Upstream'; d.cards[0].answer = 'UPDATED answer text'; d.summary = 'Updated summary'; d.cards.push({ id: 'c202-ch01-099', front: 'Brand new card', answer: 'New answer' });
  const t3 = await importFile(p, tmpJson('upd.json', d));
  ok(/0 folders added · 1 card added · 1 updated · 11 already up to date/.test(t3), 'updated deck: 1 added, 1 updated (' + t3 + ')');
  st = await S(p, () => state);
  const c1 = st.cards.find((c) => c.id === 'c202-ch01-001'), f1 = st.folders.find((f) => f.deckId === 'c202-ch01');
  ok(c1.answer === 'UPDATED answer text' && st.progress['c202-ch01-001'].streak === 2, 'card updated in place, progress kept');
  ok(f1.name === 'My Ch1' && f1.summary === 'Updated summary' && f1.course === 'C202' && f1.order === 1, "user's folder rename kept; summary/course/order stored");
  ok(/1 folder added · 12 cards added/.test(await importFile(p, tmpJson('arr.json', [JSON.parse(fs.readFileSync(S2, 'utf8'))]))), 'array-of-decks import works');
  const bad = d.cards.slice(); const dBad = { ...d, id: 'bad-deck', folder: 'Bad', cards: [{ id: 'x1', type: 'scenario', front: 'Q', choices: ['a'], correct: 0 }, { id: 'x2', front: 'ok', answer: 'fine' }] };
  ok(/1 card added.*1 skipped/.test(await importFile(p, tmpJson('bad.json', dBad))), 'invalid scenario card is skipped and reported');
  p.dialogLog.length = 0;
  await p.click('#importBtn'); await p.setInputFiles('#mergeFile', tmpJson('junk.json', { hello: 1 }));
  await p.waitForTimeout(200);
  ok(p.dialogLog.some((m) => /could not be imported/.test(m)), 'non-deck file rejected with message');
  await p.click('#cancelModal');
  // export works
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
  const backupPath = path.join(T, 'backup.json'); await dl.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  ok(backup.folders.length === 4 && backup.progress['c202-ch01-001'].streak === 2, 'Export downloads a full backup');
  await ctx.close();

  // backup merge into a different device (fresh seed)
  const B = await page(); const q = B.p;
  await q.goto(APP);
  await S(q, () => { const c = state.cards[0]; state.progress[c.id] = { streak: 1, retired: false }; save(); });
  const before = await S(q, () => state.cards.length);
  const tb = await importFile(q, backupPath);
  st = await S(q, () => state);
  ok(st.folders.filter((f) => f.name === 'U.S. Employment Law').length === 1, 'backup merge: seed folder not duplicated (matched by name)');
  ok(st.cards.length === before + 12 + 1 + 12 + 1, `backup merge: only new cards added (${tb})`);
  ok(st.progress['c202-ch01-001'].streak === 2 && st.progress['c202-ch01-014'].retired, 'backup merge: progress carried over');
  ok(Object.values(st.progress).some((x) => x.streak === 1), 'backup merge: local progress kept');
  // restore path
  q.dialogAnswers = [false];
  await q.click('#importBtn'); await q.setInputFiles('#restoreFile', backupPath); await q.waitForTimeout(200);
  ok((await S(q, () => state.cards.length)) === st.cards.length, 'restore cancelled at confirm: nothing changed');
  await q.click('#cancelModal');
  q.dialogLog.length = 0;
  await q.click('#importBtn'); await q.setInputFiles('#restoreFile', S1); await q.waitForTimeout(200);
  ok(q.dialogLog.some((m) => /Restore needs a full backup/.test(m)) && (await S(q, () => state.cards.length)) === st.cards.length, 'restore with a deck file is refused');
  await q.click('#cancelModal');
  q.dialogAnswers = [true];
  await q.click('#importBtn'); await q.setInputFiles('#restoreFile', backupPath); await q.waitForTimeout(300);
  const after = await S(q, () => state);
  ok(after.cards.length === backup.cards.length && after.folders.length === backup.folders.length && after.progress['c202-ch01-001'].streak === 2, 'restore (confirmed) replaces everything with the backup');
  await q.reload();
  ok((await S(q, () => state.cards.length)) === backup.cards.length, 'restored data persists after reload');
  await B.ctx.close();
}

async function testScenario() {
  console.log('\n[3] Scenario cards in study, quiz, editor');
  const { ctx, p } = await page();
  await p.goto(APP); await importFile(p, S2);
  await p.click('[data-open="deck-c202-ch02"]'); p.dialogAnswers = [true];
  await p.click('#studyBtn');
  if (await p.locator('#ovSkip').count()) await p.click('#ovSkip');
  await S(p, () => { view.queue = ['c202-ch02-015', ...view.queue.filter((x) => x !== 'c202-ch02-015')]; view.index = 0; view.studyPicked = null; render(); });
  ok(await p.locator('[data-spick]').count() === 3 && !(await p.locator('#flipBtn').count()), 'scenario shows choice buttons instead of flip');
  ok(!(await p.locator('.readmore').count()), 'no Read more before answering');
  await p.click('[data-spick="0"]');
  ok(await p.locator('button.choice.wrong').count() === 1 && await p.locator('button.choice.correct').count() === 1, 'wrong pick highlighted red, correct green');
  const ex = await p.textContent('#explainBox');
  ok(/Not quite/.test(ex) && /ADEA/.test(ex) && /Read more/.test(ex), 'explanation + Read more shown after answering');
  ok((await S(p, () => state.progress['c202-ch02-015'].streak)) === 0, 'wrong answer graded (streak 0)');
  for (let i = 0; i < 3; i++) {
    await p.click('#nextStudy');
    await S(p, () => { view.queue = ['c202-ch02-015', ...view.queue.filter((x) => x !== 'c202-ch02-015')]; view.index = 0; render(); });
    await p.click('[data-spick="1"]');
  }
  ok((await S(p, () => state.progress['c202-ch02-015'])).retired === true, '3 correct in a row retires the scenario card');
  await p.click('#nextStudy');
  // regular card study: note on back only
  await S(p, () => { const id = view.queue.find((x) => !isScenario(state.cards.find((c) => c.id === x))); view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); });
  ok(!(await p.textContent('#flipCard')).includes('Read more'), 'regular card front hides the Read more note');
  await p.click('#flipBtn'); ok(/Read more/.test(await p.textContent('#flipCard .readmore')), 'Read more appears on the back');
  await p.click('#exitStudy');
  // quiz
  await p.click('#quizBtn');
  const qinfo = await S(p, () => view.queue.map((id) => { const c = state.cards.find((x) => x.id === id); return { scen: isScenario(c), choices: makeChoices(c).map((x) => x.text), supplied: c.choices }; }));
  ok(qinfo.filter((q) => q.scen).every((q) => JSON.stringify(q.choices) === JSON.stringify(q.supplied)), 'quiz: scenario cards use their supplied choices in order');
  const scenTexts = await S(p, () => state.cards.filter(isScenario).flatMap((c) => [c.answer, c.explanation, ...c.choices]).filter(Boolean));
  ok(qinfo.filter((q) => !q.scen).every((q) => q.choices.length === 4 && q.choices.every((t) => !scenTexts.includes(t))), 'quiz: regular-card distractors come only from regular cards');
  ok((await S(p, () => view.quizSource.length)) === 12, 'quizBtn fix: view.quizSource is set (12)');
  await S(p, () => { const id = 'c202-ch02-017'; view.queue[view.index] = id; view.choices = makeChoices(state.cards.find((c) => c.id === id)); render(); });
  await p.click('[data-choice="2"]');
  ok(/Not quite/.test(await p.textContent('#explainBox')) && /Read more/.test(await p.textContent('#explainBox')), 'quiz: wrong scenario answer shows explanation + Read more');
  await p.click('#exitStudy');
  // editor
  await p.click('[data-edit="c202-ch02-014"]');
  ok(await p.inputValue('#cardType') === 'scenario' && await p.isVisible('#scenarioFields') && !(await p.isVisible('#basicFields')), 'editor opens scenario with scenario fields');
  ok(await p.inputValue('#cardCorrect') === '0' && (await p.inputValue('#cardChoices')) === 'Legal\nIllegal\nDepends', 'editor shows choices and correct selector');
  await p.click('#cancelModal');
  await p.click('#addCardBtn'); await p.selectOption('#cardType', 'scenario');
  await p.fill('#cardFront', 'Boss asks applicant about religion'); await p.fill('#cardChoices', 'Legal\nIllegal');
  await p.selectOption('#cardCorrect', '1'); await p.fill('#cardExplanation', 'Title VII.'); await p.click('#saveCard');
  let nc = await S(p, () => state.cards.find((c) => c.front === 'Boss asks applicant about religion'));
  ok(nc && nc.type === 'scenario' && nc.correct === 1 && nc.choices.length === 2 && nc.explanation === 'Title VII.', 'editor creates a scenario card');
  await p.click(`[data-edit="${nc.id}"]`); await p.fill('#cardChoices', 'only one'); await p.click('#saveCard');
  ok(/2 to 5 choices/.test(await p.textContent('#formError')), 'editor validates choice count');
  await p.selectOption('#cardType', 'basic'); await p.fill('#cardAnswer', 'Illegal under Title VII'); await p.click('#saveCard');
  nc = await S(p, (id) => state.cards.find((c) => c.id === id), nc.id);
  ok(!nc.type && !nc.choices && nc.answer === 'Illegal under Title VII', 'editor converts scenario back to a flash card');
  ok(await p.locator('.pill.scen').count() === 4, 'folder list shows scenario pills');
  await ctx.close();
}

async function testBossGating() {
  console.log('\n[4] Boss quiz pass/fail, gating lock/unlock/override');
  const { ctx, p } = await page();
  await p.goto(SAMPLES);
  ok((await p.locator('.course-head').allTextContents()).some((t) => t.startsWith('C202')), 'C202 course heading present');
  const order = await p.$$eval('.course >> nth=0 >> .folder-card h3', (els) => els.map((e) => e.textContent));
  ok(/Ch 1/.test(order[0]) && /Ch 2/.test(order[1]), 'chapters sorted by order under course');
  ok(await p.locator('[data-open="deck-c202-ch02"].locked').count() === 1 && /Pass Ch 1 boss to unlock/.test(await p.textContent('[data-open="deck-c202-ch02"]')), 'Ch 2 locked behind Ch 1 boss');
  ok(await p.locator('[data-open="deck-c202-ch01"].locked').count() === 0, 'Ch 1 is open');
  p.dialogAnswers = [false]; await p.click('[data-open="deck-c202-ch02"]');
  ok((await S(p, () => view.page)) === 'home' && /Open anyway/.test(p.dialogLog.pop()), 'locked click asks "Open anyway?"; cancel stays home');
  p.dialogAnswers = [true]; await p.click('[data-open="deck-c202-ch02"]');
  ok((await S(p, () => view.page + ':' + view.folderId)) === 'folder:deck-c202-ch02', 'override opens the folder');
  await p.click('#backHome');
  ok(/Opened early/.test(await p.textContent('[data-open="deck-c202-ch02"]')), 'overridden folder shows "Opened early" this session');
  await p.click('[data-open="deck-c202-ch01"]'); await p.click('#bossBtn'); if (await p.locator('#ovSkip').count()) await p.click('#ovSkip');
  ok((await S(p, () => view.boss.ids.length)) === 12, 'boss includes all 12 cards (scenarios + regular)');
  ok(await p.locator('#bossNext[disabled]').count() === 1, 'cannot advance without answering (no skip)');
  await p.click('[data-bpick="0"]');
  ok(!(await p.locator('button.choice.correct, button.choice.wrong').count()), 'no right/wrong feedback during the boss');
  await S(p, () => { view.boss.sel = null; render(); });
  await answerBoss(p, () => false);
  let txt = await p.textContent('#bossResult');
  ok(/Not yet/.test(txt) && /0%/.test(txt), 'all wrong: fail at 0%');
  ok(await p.locator('.review-item').count() === 12 && await p.locator('.review-item .readmore').count() === 12, 'review lists 12 missed with correct answers + Read more');
  ok(/Correct:/.test(await p.textContent('.review-item >> nth=0')), 'review shows the correct answer');
  await p.click('#bossPractice');
  ok((await S(p, () => view.page + ':' + view.quizTotal)) === 'quiz:12', 'Practice missed starts a quiz of the missed cards');
  await p.click('#exitStudy'); await p.reload();
  ok(await p.locator('[data-open="deck-c202-ch02"].locked').count() === 1, 'after reload, Ch 2 still locked after failing');
  ok(/Boss best: 0%/.test(await p.textContent('[data-open="deck-c202-ch01"]')), 'best boss score shown on folder card');
  await p.click('[data-open="deck-c202-ch01"]'); await p.click('#bossBtn'); if (await p.locator('#ovSkip').count()) await p.click('#ovSkip');
  await answerBoss(p, (i) => i >= 2); // 10/12 = 83%
  txt = await p.textContent('#bossResult');
  ok(/Boss defeated/.test(txt) && /83%/.test(txt) && /now unlocked/.test(txt), 'pass at 83% unlocks next chapter');
  ok(await p.locator('.review-item').count() === 2, 'review shows 2 missed');
  const bb = await S(p, () => folderById('deck-c202-ch01').bestBoss);
  ok(bb.pct === 83 && bb.passed && /^\d{4}-\d\d-\d\d$/.test(bb.date), 'bestBoss stored {pct:83, passed, date}');
  await p.click('#bossRetake'); await answerBoss(p, () => false);
  const bb2 = await S(p, () => folderById('deck-c202-ch01').bestBoss);
  ok(bb2.pct === 83 && bb2.passed, 'a worse retake keeps the best score and passed flag');
  await p.reload();
  ok(await p.locator('.folder-card.locked').count() === 0 && /Boss best: 83%/.test(await p.textContent('[data-open="deck-c202-ch01"]')), 'after reload Ch 2 unlocked; best 83% shown');
  await ctx.close();
}

async function testMatch() {
  console.log('\n[5] Matching game');
  const { ctx, p } = await page({ device: 'iPhone 13' });
  await p.goto(SAMPLES); await p.tap('[data-open="deck-c202-ch01"]');
  await p.tap('#matchBtn'); if (await p.locator('#ovSkip').count()) await p.tap('#ovSkip');
  const ids = await S(p, () => view.match.pairs.map((x) => x.id));
  ok(ids.length === 6, 'round uses 6 pairs');
  ok((await S(p, () => view.match.pairs.every((x) => !isScenario(state.cards.find((c) => c.id === x.id))))), 'only regular cards used');
  const t0 = await p.textContent('#matchTime'); await p.waitForTimeout(400);
  ok(t0 !== await p.textContent('#matchTime'), 'timer is running');
  await p.tap(`[data-term="${ids[0]}"]`); await p.tap(`[data-def="${ids[1]}"]`);
  ok(await p.locator('.match-tile.wrong').count() === 2, 'wrong pair flashes red');
  ok((await S(p, () => view.match.penalty)) === 2000 && /\+2s/.test(await p.textContent('#matchStatus')), '2-second penalty added');
  await p.tap(`[data-def="${ids[2]}"]`); await p.tap(`[data-term="${ids[2]}"]`);
  ok(await p.locator('.match-tile.matched').count() === 2, 'definition-first also works; correct pair locks green');
  for (const id of ids) if (id !== ids[2]) { await p.tap(`[data-term="${id}"]`); await p.tap(`[data-def="${id}"]`); }
  await p.waitForSelector('#matchResult');
  const best1 = await S(p, () => folderById('deck-c202-ch01').bestMatch);
  ok(best1 && best1.pairs === 6 && best1.ms >= 2000, `result shown; best time stored (${(best1.ms / 1000).toFixed(1)}s)`);
  ok(await p.locator('.readmore').count() === 6, 'results list the pairs with Read more notes');
  await p.tap('#matchAgain');
  const ids2 = await S(p, () => view.match.pairs.map((x) => x.id));
  await p.waitForTimeout(best1.ms + 300);
  for (const id of ids2) { await p.tap(`[data-term="${id}"]`); await p.tap(`[data-def="${id}"]`); }
  await p.waitForSelector('#matchResult');
  const best2 = await S(p, () => folderById('deck-c202-ch01').bestMatch);
  ok(best2.ms === best1.ms, 'slower round does not replace best time');
  await p.tap('#matchBack'); await p.tap('#backHome');
  ok(/Match best/.test(await p.textContent('[data-open="deck-c202-ch01"]')), 'best match time shown on folder card');
  // disabled when < 3 regular cards
  await S(p, () => { const fid = 'tiny'; state.folders.push({ id: fid, name: 'Tiny' }); state.cards.push({ id: 't1', folderId: fid, front: 'A', answer: 'a' }, { id: 't2', folderId: fid, front: 'B', answer: 'b' }, { id: 't3', folderId: fid, front: 'S', type: 'scenario', choices: ['x', 'y'], correct: 0, explanation: '' }); save(); view.page = 'folder'; view.folderId = fid; render(); });
  ok(await p.locator('#matchBtn[disabled]').count() === 1 && /at least 3 regular/.test(await p.getAttribute('#matchBtn', 'title')), 'Match disabled with message when < 3 regular cards');
  await ctx.close();
}

async function testBundled() {
  console.log('\n[6] Bundled decks build + apply');
  const { ctx, p } = await page();
  await p.goto(SAMPLES);
  let st = await S(p, () => state);
  ok(st.folders.length === 3 && st.cards.length === 41, 'fresh load: seed + 2 bundled decks (41 cards)');
  ok(/New study material/.test(await p.textContent('#toast')), 'toast announces new material');
  ok(/Includes 2 built-in decks/.test(await p.textContent('footer.note')), 'footer shows build info');
  await S(p, () => { state.progress['c202-ch01-002'] = { streak: 2, retired: false }; save(); });
  await p.reload();
  st = await S(p, () => state);
  ok(st.folders.length === 3 && st.cards.length === 41, 'reload: no duplicates');
  p.dialogAnswers = [true, true];
  await p.click('[data-open="deck-c202-ch02"]'); await p.click('#deleteFolder');
  await p.reload();
  ok((await S(p, () => state.folders.length)) === 2, 'deleted bundled deck is not resurrected on reload');
  // rebuild with changed content
  const inbox2 = path.join(T, 'inbox2'); fs.rmSync(inbox2, { recursive: true, force: true }); fs.mkdirSync(inbox2);
  const d1 = JSON.parse(fs.readFileSync(S1, 'utf8')); d1.cards[1].answer = 'Changed HRM answer'; fs.writeFileSync(path.join(inbox2, 'a.json'), JSON.stringify(d1));
  const d2 = JSON.parse(fs.readFileSync(S2, 'utf8')); d2.cards.push({ id: 'c202-ch02-050', front: 'New ch2 card', answer: 'x' }); fs.writeFileSync(path.join(inbox2, 'b.json'), JSON.stringify(d2));
  execSync(`${ROOT}/build.sh --inbox ${inbox2} --out ${T}/dist-v2.html`);
  await p.goto('file://' + T + '/dist-v2.html');
  st = await S(p, () => state);
  ok(st.folders.length === 3 && st.cards.filter((c) => c.folderId === 'deck-c202-ch02').length === 13, 'changed deck comes back (content hash changed), with new card');
  ok(st.cards.find((c) => c.id === 'c202-ch01-002').answer === 'Changed HRM answer' && st.progress['c202-ch01-002'].streak === 2, 'updated bundled card changed in place, progress kept');
  ok(st.cards.filter((c) => c.folderId === 'deck-c202-ch01').length === 12, 'no duplicates in updated deck');
  await ctx.close();
  // build validation rejects bad decks
  const bad = path.join(T, 'inbox-bad'); fs.rmSync(bad, { recursive: true, force: true }); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'x.json'), JSON.stringify({ id: 'x', folder: 'X', cards: [{ id: '1', type: 'scenario', front: 'q', choices: ['a', 'b'], correct: 5 }] }));
  let failed = false; try { execSync(`${ROOT}/build.sh --inbox ${bad} --out ${T}/bad.html`, { stdio: 'pipe' }); } catch (e) { failed = /correct/.test(String(e.stderr)); }
  ok(failed && !fs.existsSync(T + '/bad.html'), 'build.sh rejects an invalid deck and writes nothing');
}

async function testReal(raw) {
  console.log('\n[7] Real inbox deck in dist/flashcards.html');
  const deck = JSON.parse(fs.readFileSync(ROOT + '/decks/inbox/c202-ch01.json', 'utf8'));
  const n = deck.cards.length, nScen = deck.cards.filter((c) => c.type === 'scenario').length;
  for (const mode of ['fresh', 'v1']) {
    const { ctx, p } = await page();
    if (mode === 'v1') { await p.goto(ORIG); await S(p, (r) => localStorage.setItem('flashcards.v1', r), raw); }
    await p.goto(REAL);
    const st = await S(p, () => state);
    const f = st.folders.find((x) => x.deckId === deck.id);
    ok(f && st.cards.filter((c) => c.folderId === f.id).length === n, `${mode}: deck folder with ${n} cards`);
    const heads = await p.locator('.course-head').allTextContents();
    ok(heads[0].startsWith('C202') && (await p.textContent('.course >> nth=0')).includes(deck.folder), `${mode}: "${deck.folder}" under C202 heading`);
    if (mode === 'v1') {
      const old = JSON.parse(raw);
      ok(old.cards.every((c) => st.cards.some((x) => x.id === c.id && x.front === c.front)) && Object.entries(old.progress).every(([k, v]) => JSON.stringify(st.progress[k]) === JSON.stringify(v)), 'v1: existing cards and progress intact alongside the deck');
      ok(await p.locator('.course-head >> text=Other folders').count() === 1, 'v1: old folders under "Other folders"');
    }
    if (deck.summary) {
      ok(await p.locator(`[data-open="${f.id}"] .ov-link`).count() === 1, `${mode}: home card shows Read overview link`);
    }
    await p.click(`[data-open="${f.id}"]`);
    if (deck.summary) ok(await p.locator('#overview').count() === 1, `${mode}: overview card present`);
    await p.click('#studyBtn'); if (await p.locator('#ovSkip').count()) await p.click('#ovSkip');
    await S(p, () => { const id = view.queue.find((x) => isScenario(state.cards.find((c) => c.id === x))); view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); });
    const correct = await S(p, () => currentCard().correct);
    await p.click(`[data-spick="${correct}"]`);
    ok(/Correct/.test(await p.textContent('#explainBox')) && (await S(p, () => prog(currentCard().id).streak)) === 1, `${mode}: scenario in study grades correctly`);
    if (mode === 'fresh') { await p.screenshot({ path: SHOTS + '/real-c202-ch01-scenario-desktop.png' }); }
    await p.click('#exitStudy'); await p.click('#quizBtn');
    const qi = await S(p, () => { const sc = view.queue.map((id) => state.cards.find((c) => c.id === id)); const s = sc.find(isScenario), r = sc.find((c) => !isScenario(c)); return { s: JSON.stringify(makeChoices(s).map((x) => x.text)) === JSON.stringify(s.choices), r: makeChoices(r).length }; });
    ok(qi.s && qi.r === 4, `${mode}: quiz uses supplied scenario choices; regular cards get 4 options`);
    await p.click('[data-choice="0"]'); ok(await p.locator('#explainBox').count() === 1, `${mode}: quiz shows feedback after answering`);
    await p.click('#exitStudy'); await p.click('#bossBtn');
    ok((await S(p, () => view.boss.ids.length)) === n, `${mode}: boss has all ${n} cards`);
    await answerBoss(p, (i) => i % 10 !== 0);
    const res = await p.textContent('#bossResult');
    ok(/Boss defeated/.test(res), `${mode}: boss completes and passes (${res.match(/\d+%/)[0]})`);
    if (deck.cards.some((c) => c.note)) ok(await p.locator('.review-item .readmore').count() > 0, `${mode}: boss review shows Read more`);
    if (mode === 'fresh') { await p.screenshot({ path: SHOTS + '/real-c202-ch01-boss-results-desktop.png' }); }
    await p.click('#exitBoss'); await p.click('#matchBtn');
    const ids = await S(p, () => view.match.pairs.map((x) => x.id));
    for (const id of ids) { await p.click(`[data-term="${id}"]`); await p.click(`[data-def="${id}"]`); }
    await p.waitForSelector('#matchResult');
    ok(ids.length === 6, `${mode}: matching game completes`);
    if (mode === 'fresh') {
      await p.click('#matchBack'); await p.click('#backHome'); await p.waitForTimeout(100);
      await p.evaluate(() => document.getElementById('toast') && document.getElementById('toast').classList.remove('show')); await p.waitForTimeout(400);
      await p.screenshot({ path: SHOTS + '/real-c202-ch01-home-desktop.png' });
      if (deck.summary) { await p.click(`[data-open="${f.id}"]`); await p.click('#overview summary'); await p.screenshot({ path: SHOTS + '/real-c202-ch01-overview-desktop.png', fullPage: false }); }
    }
    await ctx.close();
  }
}

async function screenshots() {
  console.log('\n[8] Screenshots');
  for (const [tag, opt] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { device: 'iPhone 13' }]]) {
    const { ctx, p } = await page(opt);
    const hideToast = async () => { await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); }); await p.waitForTimeout(400); };
    await p.goto(SAMPLES); await hideToast();
    await p.screenshot({ path: `${SHOTS}/home-course-locked-${tag}.png`, fullPage: true });
    await p.click('[data-open="deck-c202-ch01"] .ov-link');
    await p.screenshot({ path: `${SHOTS}/chapter-overview-${tag}.png` });
    await S(p, () => { view.ovOpen = null; render(); window.scrollTo(0, 0); });
    await p.click('#studyBtn');
    await p.screenshot({ path: `${SHOTS}/read-overview-prompt-${tag}.png` });
    await p.click('#ovSkip');
    await S(p, () => { const id = 'c202-ch01-014'; view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); });
    await p.click('[data-spick="0"]');
    await p.screenshot({ path: `${SHOTS}/scenario-answered-${tag}.png`, fullPage: true });
    await p.click('#exitStudy'); await p.click('#bossBtn');
    await answerBoss(p, (i) => i % 3 !== 0);
    await p.screenshot({ path: `${SHOTS}/boss-results-${tag}.png`, fullPage: true });
    await p.click('#exitBoss'); await p.click('#matchBtn');
    const ids = await S(p, () => view.match.pairs.map((x) => x.id));
    await p.click(`[data-term="${ids[0]}"]`); await p.click(`[data-def="${ids[0]}"]`);
    await p.click(`[data-term="${ids[1]}"]`); await p.click(`[data-def="${ids[1]}"]`);
    await p.click(`[data-term="${ids[2]}"]`); await p.click(`[data-def="${ids[3]}"]`);
    await p.waitForTimeout(150);
    await p.click(`[data-term="${ids[4]}"]`);
    await p.screenshot({ path: `${SHOTS}/match-midgame-${tag}.png`, fullPage: true });
    await ctx.close();
  }
  const { ctx, p } = await page({ device: 'iPhone 13' });
  await p.goto(REAL); await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); }); await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/real-c202-ch01-home-phone.png` });
  await ctx.close();
  ok(true, 'screenshots written to ' + SHOTS);
}

(async () => {
  browser = await chromium.launch();
  try {
    const raw = await makeV1Data();
    await testV1(raw);
    await testMergeImport();
    await testScenario();
    await testBossGating();
    await testMatch();
    await testBundled();
    await testReal(raw);
    await screenshots();
  } catch (e) { fail++; console.log('EXCEPTION', e); }
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ':\n' + errors.join('\n') : ''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
