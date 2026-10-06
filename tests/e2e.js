const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = '/workspace/flashcards', T = '/tmp/fc-test', SHOTS = ROOT + '/screens';
const APP = 'file://' + ROOT + '/flashcards.html', ORIG = 'file://' + T + '/original.html';
const SAMPLES = 'file://' + T + '/dist-samples.html', REAL = 'file://' + ROOT + '/dist/flashcards.html';
const PREV = 'file://' + T + '/dist-prev.html';
const S1 = ROOT + '/decks/samples/sample-c202-ch01.json', S2 = ROOT + '/decks/samples/sample-c202-ch02.json';
let browser, pass = 0, fail = 0; const errors = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } }
async function page(opts = {}) {
  const base = opts.device ? { ...devices[opts.device] } : { viewport: opts.viewport || { width: 1280, height: 800 } };
  const ctx = await browser.newContext({ ...base, timezoneId: opts.tz || 'America/Denver', acceptDownloads: true });
  const p = await ctx.newPage();
  if (opts.now) await p.clock.setFixedTime(new Date(opts.now));
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

async function hideToast(p) { await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); }); await p.waitForTimeout(350); }
async function skipNudge(p) { if (await p.locator('#ovSkip').count()) await p.click('#ovSkip'); }

async function testPath() {
  console.log('\n[7] Suggested path + study filters');
  const { ctx, p } = await page();
  await p.goto(SAMPLES); await p.click('[data-open="deck-c202-ch01"]');
  const st = () => p.evaluate(() => [...document.querySelectorAll('.step')].map((e) => e.dataset.stepkey + (e.classList.contains('done') ? ':done' : '') + (e.classList.contains('next') ? ':next' : '')).join(' '));
  ok(await st() === 'guide:next concept practice boss', 'fresh folder: step 1 (study guide) is next');
  ok(await p.locator('.step.next button.gold').count() === 1, 'next step has the primary button');
  await p.click('#conceptBtn');
  ok(/Read the study guide first\? \(~1 min\)/.test(await p.textContent('.dialog-body')), 'nudge: "Read the study guide first? (~N min)"');
  await p.click('#ovSkip');
  ok((await S(p, () => view.studyMode + ':' + view.queue.length + ':' + view.queue.every((id) => !isScenario(state.cards.find((c) => c.id === id))))) === 'concept:8:true', 'Concept cards mode = regular cards only (8), flip mode');
  await p.click('#exitStudy'); await p.click('#scenarioBtn');
  ok(!(await S(p, () => document.getElementById('modal').open)), 'no second nudge after "Skip for now" in this session');
  ok((await S(p, () => view.studyMode + ':' + view.queue.length + ':' + view.queue.every((id) => isScenario(state.cards.find((c) => c.id === id))))) === 'scenario:4:true', 'Scenarios mode = scenario cards only (4)');
  await p.click('#exitStudy');
  await p.click('.step.next [data-step="guide"]'); await p.click('#guideRead');
  ok(await st() === 'guide:done concept:next practice boss', 'guide read -> concept cards next');
  await p.click('.step.next [data-step="concept"]');
  for (let i = 0; i < 8; i++) { await p.click('#flipBtn'); await p.click(i % 3 ? '#gotBtn' : '#missBtn'); }
  await p.click('#exitStudy');
  ok(await st() === 'guide:done concept:done practice:next boss', 'one full pass through concept cards -> scenarios & quiz next');
  await p.click('.step.next [data-step="quiz"]');
  for (let i = 0; i < 12; i++) { const idx = await S(p, (i) => view.choices.findIndex((c) => i < 4 ? !c.correct : c.correct), i); await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz'); }
  await p.click('#backDone');
  ok(await st() === 'guide:done concept:done practice:next boss' && (await S(p, () => folderById('deck-c202-ch01').quizBest)) === 67, 'quiz at 67% does not clear step 3 (needs 70%)');
  await p.click('#quizBtn');
  for (let i = 0; i < 12; i++) { const idx = await S(p, (i) => view.choices.findIndex((c) => i < 2 ? !c.correct : c.correct), i); await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz'); }
  await p.click('#backDone');
  ok(await st() === 'guide:done concept:done practice:done boss:next', 'quiz at 83% clears step 3 -> boss next');
  await p.click('.step.next [data-step="boss"]'); await answerBoss(p, () => true); await p.click('#exitBoss');
  ok(await st() === 'guide:done concept:done practice:done boss:done' && /Chapter complete/.test(await p.textContent('#pathCard')), 'boss passed -> path complete');
  // seed folder (no guide, no scenarios)
  await p.click('#backHome'); await p.click('.folder-card >> text=U.S. Employment Law');
  ok(await st() === 'guide:done concept:next practice boss' && await p.locator('.step.na').count() === 1, 'folder without a guide skips step 1');
  await ctx.close();
}

async function testPlanner() {
  console.log('\n[8] Pacing planner');
  const NOW = '2026-10-05T22:30:00-06:00'; // evening in Denver = already Oct 6 in UTC
  const { ctx, p } = await page({ now: NOW });
  await p.goto(SAMPLES);
  ok((await S(p, () => todayISO())) === '2026-10-05', 'local date at 10:30 PM Denver is Oct 5 (no UTC off-by-one)');
  ok(/no study plan yet/.test(await p.textContent('.plan-banner')), 'home shows a "plan my pace" banner before a plan exists');
  await p.click('#planBtn');
  ok(/Course started Wed, Sep 23, 2026/.test(await p.textContent('#app')), 'plan screen shows course start date');
  ok((await p.inputValue('#planStart')) === '2026-10-05' && await p.locator('.pace.sel >> text=Medium').count() === 1, 'defaults: start today, Medium (recommended) selected');
  await p.click('#savePlan');
  let plan = await S(p, () => state.plans.C202);
  const dues = (pl) => pl.schedule.map((e) => e.due.slice(5)).join(',');
  ok(dues(plan) === '10-06,10-08,10-10,10-11,10-13,10-15,10-17,10-18,10-20,10-21,10-22,10-23,10-24,10-25', 'Medium: Wk1 Ch1-4, Wk2 Ch5-8, Wk3 Ch9-14 dates');
  ok(plan.pace === 'medium' && plan.startDate === '2026-10-05' && plan.targetDate === '2026-10-25' && plan.createdAt === '2026-10-05' && Array.isArray(plan.history), 'plan stored with pace/startDate/targetDate/createdAt/schedule/history');
  ok(await p.locator('.plan-row.milestone').count() === 4 && /Q1 quarterly quiz/.test(await p.textContent('.plan-row.milestone >> nth=0')), '4 quarterly quiz milestones');
  ok(/by Sun, Oct 11/.test(await p.textContent('.plan-row.milestone >> nth=0')), 'Q1 quiz milestone dated with Ch 4');
  ok(await p.locator('.plan-row.soon').count() === 12, '12 chapters without decks show "coming soon"');
  const plans = await S(p, () => {
    const out = {};
    for (const pace of ['speedy', 'deliberate']) { makePlan('C202', pace, '2026-10-05'); out[pace] = state.plans.C202.schedule.map((e) => e.due.slice(5)).join(','); }
    makePlan('C202', 'custom', '2026-10-05', '2026-10-18'); out.custom14 = state.plans.C202.schedule.map((e) => e.due.slice(5)).join(',');
    makePlan('C202', 'custom', '2026-10-05', '2026-10-09'); out.custom5 = state.plans.C202.schedule.map((e) => e.due.slice(5)).join(',');
    makePlan('C202', 'custom', '2026-10-05', '2026-10-05'); out.same = [...new Set(state.plans.C202.schedule.map((e) => e.due))].join(',');
    try { makePlan('C202', 'custom', '2026-10-05', '2026-10-04'); out.before = 'no error'; } catch (e) { out.before = e.message; }
    makePlan('C202', 'custom', '2026-10-25', '2026-11-07'); out.dst = state.plans.C202.schedule.map((e) => e.due).join(',');
    makePlan('C202', 'medium', '2026-12-28'); out.year = state.plans.C202.schedule.map((e) => e.due).join(',');
    out.hist = state.plans.C202.history.length;
    return out;
  });
  ok(plans.speedy === '10-05,10-06,10-07,10-08,10-09,10-10,10-11,10-11,10-13,10-14,10-15,10-16,10-17,10-18', 'Speedy: Ch1-8 in week 1 (ends Oct 11), Ch9-14 in week 2 (ends Oct 18): ' + plans.speedy);
  ok(plans.deliberate.split(',')[3] === '10-11' && plans.deliberate.split(',')[7] === '10-18' && plans.deliberate.split(',')[11] === '10-25' && plans.deliberate.split(',')[13] === '11-01', 'Deliberate: one quarter per week (Ch4 Oct 11, Ch8 Oct 18, Ch12 Oct 25, Ch14 Nov 1)');
  ok(plans.custom14 === '10-05,10-06,10-07,10-08,10-09,10-10,10-11,10-12,10-13,10-14,10-15,10-16,10-17,10-18', 'Custom 14 days for 14 chapters = one per day ending on target');
  const c5 = plans.custom5.split(',');
  ok(c5[0] === '10-05' && c5[13] === '10-09' && c5.every((d) => d >= '10-05' && d <= '10-09') && c5.join() === c5.slice().sort().join(), 'Custom 5 days: chapters spread evenly, last on target: ' + plans.custom5);
  ok(plans.same === '2026-10-05', 'Custom target = start: everything due that day');
  ok(/on or after/.test(plans.before), 'Custom target before start is rejected');
  const dst = plans.dst.split(',');
  ok(dst.length === 14 && dst[0] === '2026-10-25' && dst[7] === '2026-11-01' && dst[8] === '2026-11-02' && dst[13] === '2026-11-07', 'Custom across the Nov 1 DST change: no skipped/duplicated day');
  ok(plans.year.split(',')[3] === '2027-01-03' && plans.year.split(',')[13] === '2027-01-17', 'Medium across New Year: dates roll into 2027 correctly');
  ok(plans.hist === 7, 'each pace change is recorded in history (7 replacements)');
  // Fresh medium plan, then mid-course switch with bosses passed
  await S(p, () => { delete state.plans.C202; save(); makePlan('C202', 'medium', '2026-10-05'); });
  await ctx.close();
  const raw = await (async () => { const c = await page({ now: NOW }); await c.p.goto(SAMPLES); await S(c.p, () => { makePlan('C202', 'medium', '2026-10-05'); }); const r = await S(c.p, () => localStorage.getItem('flashcards.v1')); await c.ctx.close(); return r; })();
  // a week later: behind
  let B = await page({ now: '2026-10-12T09:00:00-06:00' });
  await B.p.goto(ORIG); await S(B.p, (r) => localStorage.setItem('flashcards.v1', r), raw); await B.p.goto(SAMPLES);
  ok(/Behind by 4 chapters/.test(await B.p.textContent('#planStatus')), 'Oct 12, nothing passed: Behind by 4 chapters (Ch1-4 were due)');
  ok(/Week 2/.test(await B.p.textContent('#planBanner')) && /overdue: Ch 1, Ch 2, Ch 3, Ch 4/.test(await B.p.textContent('#planBanner')), 'banner shows week 2 and overdue chapters');
  await B.ctx.close();
  // Oct 6, three chapters passed: ahead
  B = await page({ now: '2026-10-06T08:00:00-06:00' });
  await B.p.goto(ORIG); await S(B.p, (r) => localStorage.setItem('flashcards.v1', r), raw); await B.p.goto(SAMPLES);
  await S(B.p, () => { ['deck-c202-ch01', 'deck-c202-ch02'].forEach((id) => { folderById(id).bestBoss = { pct: 90, passed: true, date: '2026-10-06' }; }); save(); view.page = 'home'; render(); });
  ok(/Ahead by 1 chapter/.test(await B.p.textContent('#planStatus')), 'Oct 6 with Ch1+Ch2 passed (only Ch1 due): Ahead by 1 chapter');
  ok(/Next: Ch 3/.test(await B.p.textContent('#planNext')) && /coming soon/.test(await B.p.textContent('#planNext')), 'next suggested chapter without a deck shows "coming soon"');
  await B.ctx.close();
  // On track + Go button runs the next step
  B = await page({ now: '2026-10-06T08:00:00-06:00' });
  await B.p.goto(ORIG); await S(B.p, (r) => localStorage.setItem('flashcards.v1', r), raw); await B.p.goto(SAMPLES);
  ok(/On track/.test(await B.p.textContent('#planStatus')) && /Next: Ch 1 · Study guide/.test(await B.p.textContent('#planNext')), 'Oct 6 morning, Ch1 due today: On track; next = Ch 1 · Study guide');
  await B.p.click('#planGo');
  ok((await S(B.p, () => view.page + ':' + view.folderId)) === 'guide:deck-c202-ch01', 'Go opens the Ch 1 study guide');
  await B.p.click('#guideRead'); await B.p.click('#backHome');
  ok(/Next: Ch 1 · Concept cards/.test(await B.p.textContent('#planNext')), 'after reading the guide, next step becomes Concept cards');
  await B.ctx.close();
  // mid-course switch on Oct 10 with Ch1+Ch2 passed
  B = await page({ now: '2026-10-10T12:00:00-06:00' });
  const q = B.p;
  await q.goto(ORIG); await S(q, (r) => localStorage.setItem('flashcards.v1', r), raw); await q.goto(SAMPLES);
  await S(q, () => { ['deck-c202-ch01', 'deck-c202-ch02'].forEach((id) => { folderById(id).bestBoss = { pct: 85, passed: true, date: '2026-10-08' }; }); save(); view.page = 'home'; render(); });
  await q.click('#planBtn');
  ok((await q.inputValue('#planStart')) === '2026-10-10', 'start date defaults to today when switching');
  await q.click('.pace >> text=Speedy'); await q.click('#savePlan');
  plan = await S(q, () => state.plans.C202);
  ok(plan.schedule[0].due === '2026-10-06' && plan.schedule[1].due === '2026-10-08', 'passed chapters keep their old due dates (done)');
  const rem = plan.schedule.slice(2).map((e) => e.due);
  ok(rem[0] >= '2026-10-10' && rem[5] === '2026-10-16' && rem[11] === '2026-10-23' && rem.every((d, i) => i === 0 || d >= rem[i - 1]), 'remaining Ch3-14 replanned from today with Speedy (Ch3-8 wk1 to Oct 16, Ch9-14 wk2 to Oct 23)');
  ok(plan.pace === 'speedy' && plan.startDate === '2026-10-10' && plan.history.length === 1 && plan.history[0].pace === 'medium' && plan.history[0].passedAtSwitch === 2, 'history records the switch from medium with 2 passed');
  ok(await q.locator('.plan-row.passed').count() === 2 && /Done before this plan/.test(await q.textContent('#planSchedule')), 'plan screen shows passed chapters as done');
  // custom via UI
  await q.click('.pace >> text=Custom'); await q.fill('#planTarget', '2026-10-21'); await q.dispatchEvent('#planTarget', 'change'); await q.click('#savePlan');
  plan = await S(q, () => state.plans.C202);
  ok(plan.pace === 'custom' && plan.targetDate === '2026-10-21' && plan.schedule[13].due === '2026-10-21' && plan.schedule[2].due === '2026-10-10', 'custom target via UI: 12 remaining chapters spread Oct 10-21');
  await q.click('.pace >> text=Custom'); await q.fill('#planTarget', '2026-10-01'); await q.dispatchEvent('#planTarget', 'change'); await q.click('#savePlan');
  ok(/on or after/.test(await q.textContent('#planError')) && (await S(q, () => state.plans.C202.targetDate)) === '2026-10-21', 'past target date shows an error and keeps the old plan');
  // share
  try { await B.ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (e) {}
  await q.click('#sharePlan');
  await q.waitForFunction(() => !/Copying/.test(document.getElementById('copyStatus').textContent));
  const text = await q.inputValue('#planTextBox');
  ok(/C202 Managing Human Capital study plan/.test(text) && /Generated: 2026-10-10/.test(text) && /Pace: Custom \(finish by/.test(text) && /Start: 2026-10-10 · Target finish: 2026-10-21 · Course started: 2026-09-23/.test(text), 'share text has pace, start/target, course start, generated date');
  ok(/Ch 1   due Tue 2026-10-06  passed \(boss 85%\)/.test(text) && /Ch 3 .*coming soon/.test(text) && />> Q1 quarterly quiz/.test(text) && /Current chapter: Ch 3 \(deck not loaded yet\)/.test(text), 'share text lists chapters with due/status, milestones, current chapter');
  ok(/Pace changes: 2/.test(text), 'share text mentions pace changes');
  console.log('      clipboard status: ' + (await q.textContent('#copyStatus')));
  let clip = ''; try { clip = await S(q, () => navigator.clipboard.readText()); } catch (e) { clip = ''; }
  ok(clip === text || /Copied|Couldn't/.test(await q.textContent('#copyStatus')), 'copy attempted (clipboard ' + (clip === text ? 'verified' : 'not readable in headless file://; fallback message shown') + ')');
  const [dl] = await Promise.all([q.waitForEvent('download'), q.click('#downloadPlan')]);
  ok(dl.suggestedFilename() === 'c202-plan.txt', 'Download offers c202-plan.txt');
  const dlPath = path.join(T, 'c202-plan.txt'); await dl.saveAs(dlPath);
  ok(fs.readFileSync(dlPath, 'utf8') === text, 'downloaded file matches the shared text');
  fs.writeFileSync(SHOTS + '/../screens/c202-plan-sample.txt', text);
  await q.click('#closeShare'); await q.click('#planBack');
  const [dl2] = await Promise.all([q.waitForEvent('download'), q.click('#exportBtn')]);
  const bk = path.join(T, 'backup-plan.json'); await dl2.saveAs(bk);
  ok(JSON.parse(fs.readFileSync(bk, 'utf8')).plans.C202.pace === 'custom', 'plan is included in the Export backup');
  await B.ctx.close();
}

async function testResumeAndQuick() {
  console.log('\n[9] Resume mid-session + Quick quiz');
  const { ctx, p } = await page();
  await p.goto(SAMPLES); await p.click('[data-open="deck-c202-ch01"]');
  // Start full quiz, answer 2, Save & leave
  await p.click('#quizBtn'); await skipNudge(p);
  ok(/Save & leave/.test(await p.textContent('#exitStudy')), 'mid-quiz exit button says Save & leave');
  const total = await S(p, () => view.quizTotal);
  ok(total === 12, 'full quiz has 12 questions');
  for (let i = 0; i < 2; i++) {
    const idx = await S(p, () => view.choices.findIndex((c) => c.correct));
    await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz');
  }
  const mid = await S(p, () => ({ index: view.index, score: view.score, asked: view.asked, id: view.queue[view.index] }));
  ok(mid.index === 2 && mid.score === 2, `after 2 correct: index=${mid.index} score=${mid.score}`);
  await p.click('#exitStudy'); // Save & leave
  ok((await S(p, () => view.page)) === 'folder', 'Save & leave returns to folder');
  ok(await p.locator('#resumeRow [data-resume="quiz"]').count() === 1, 'folder shows Resume quiz button');
  const resumeTxt = await p.textContent('[data-resume="quiz"]');
  ok(/Resume quiz/.test(resumeTxt) && /Question 3 of 12/.test(resumeTxt) && /2 correct/.test(resumeTxt), 'Resume label shows progress: ' + resumeTxt.replace(/\s+/g, ' ').trim());
  ok(await p.locator('#quickBtn').count() === 1, 'Quick quiz button present');
  // Resume continues exactly
  await p.click('[data-resume="quiz"]');
  const resumed = await S(p, () => ({ page: view.page, index: view.index, score: view.score, asked: view.asked, id: view.queue[view.index], leave: document.getElementById('exitStudy').textContent }));
  ok(resumed.page === 'quiz' && resumed.index === mid.index && resumed.score === mid.score && resumed.id === mid.id, 'resume restores exact quiz state');
  ok(/Save & leave/.test(resumed.leave), 'resumed mid-quiz still shows Save & leave');
  // Finish the quiz -> resume clears
  for (let i = resumed.index; i < total; i++) {
    const idx = await S(p, () => view.choices.findIndex((c) => c.correct));
    await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz');
  }
  ok(/Quiz complete/.test(await p.textContent('#app')), 'quiz completed');
  await p.click('#backDone');
  ok(await p.locator('[data-resume="quiz"]').count() === 0, 'completing clears Resume quiz');
  // Quick quiz length
  await p.click('#quickBtn');
  const qn = await S(p, () => ({ total: view.quizTotal, kind: view.quizKind, full: view.quizFull }));
  ok(qn.kind === 'quick' && qn.total === 10 && qn.full === false, `quick quiz: kind=quick, length=${qn.total}, not full`);
  ok(/Save & leave/.test(await p.textContent('#exitStudy')), 'quick quiz mid: Save & leave');
  // leave mid-quick, resume, complete
  const qi = await S(p, () => view.choices.findIndex((c) => c.correct));
  await p.click(`[data-choice="${qi}"]`); await p.click('#nextQuiz');
  await p.click('#exitStudy');
  ok(await p.locator('[data-resume="quick"]').count() === 1 && /Question 2 of 10/.test(await p.textContent('[data-resume="quick"]')), 'Resume quick shows after leave');
  await p.click('[data-resume="quick"]');
  for (let i = await S(p, () => view.index); i < 10; i++) {
    const idx = await S(p, () => view.choices.findIndex((c) => c.correct));
    await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz');
  }
  const results = await p.textContent('#app');
  ok(/Quiz complete/.test(results) && /Quick · 10 cards/.test(results) && /Retake quick/.test(results), 'quick results note Quick · N cards + Retake quick');
  // Quick does not count as full quiz for path (quizBest unchanged if we never set it from quick)
  const qb = await S(p, () => folderById('deck-c202-ch01').quizBest);
  // We finished a full quiz earlier at 100%, so quizBest should be 100; quick must not wipe it
  ok(qb === 100, 'quick quiz does not replace quizBest from full quiz (still ' + qb + ')');
  await p.click('#backDone');
  ok(await p.locator('[data-resume="quick"]').count() === 0, 'completing quick clears resume');
  // Starting fresh with a saved session asks to discard
  await p.click('#quizBtn');
  for (let i = 0; i < 1; i++) { const idx = await S(p, () => view.choices.findIndex((c) => c.correct)); await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz'); }
  await p.click('#exitStudy');
  p.dialogAnswers = [false]; p.dialogLog.length = 0;
  await p.click('#quizBtn');
  ok(p.dialogLog.some((m) => /discard/i.test(m)) && await p.locator('[data-resume="quiz"]').count() === 1, 'Start fresh with saved session asks discard; cancel keeps resume');
  p.dialogAnswers = [true];
  await p.click('#quizBtn');
  ok((await S(p, () => view.page + ':' + view.index + ':' + view.quizKind)) === 'quiz:0:full' && await p.locator('[data-resume="quiz"]').count() === 0, 'confirm discard starts fresh full quiz and clears resume');
  await p.click('#exitStudy');
  // Export includes sessions
  await p.click('#quizBtn');
  const idx2 = await S(p, () => view.choices.findIndex((c) => c.correct));
  await p.click(`[data-choice="${idx2}"]`); await p.click('#nextQuiz');
  await p.click('#exitStudy');
  await p.click('#backHome');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
  const bp = path.join(T, 'backup-sessions.json'); await dl.saveAs(bp);
  const backup = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const sk = Object.keys(backup.sessions || {}).find((k) => k.endsWith(':quiz'));
  ok(sk && backup.sessions[sk].index === 1, 'Export backup includes sessions keyed by folder:mode');
  await hideToast(p);
  await p.click('[data-open="deck-c202-ch01"]');
  await p.screenshot({ path: SHOTS + '/folder-resume-quick.png' });
  await ctx.close();
}

async function testReal(raw) {
  console.log('\n[10] Real inbox decks in dist/flashcards.html');
  const decks = fs.readdirSync(ROOT + '/decks/inbox').filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(ROOT + '/decks/inbox/' + f, 'utf8')));
  const d1 = decks.find((d) => d.id === 'c202-ch01'), d2 = decks.find((d) => d.id === 'c202-ch02');
  ok(d1 && d2, `inbox has ${decks.map((d) => d.id + ' (' + d.cards.length + ' cards)').join(', ')}`);
  const html = fs.readFileSync(ROOT + '/dist/flashcards.html', 'utf8');
  ok(!/sample-c202|Sample HR textbook/.test(html), 'dist contains nothing from decks/samples');
  for (const mode of ['fresh', 'v1']) {
    const { ctx, p } = await page({ now: '2026-10-05T19:30:00-06:00' });
    if (mode === 'v1') { await p.goto(ORIG); await S(p, (r) => localStorage.setItem('flashcards.v1', r), raw); }
    await p.goto(REAL);
    const st = await S(p, () => state);
    for (const d of [d1, d2]) ok(st.cards.filter((c) => c.folderId === 'deck-' + d.id).length === d.cards.length, `${mode}: ${d.id} has ${d.cards.length} cards`);
    const course = await p.textContent('.course >> nth=0');
    ok(/^\s*C202/.test(await p.textContent('.course-head >> nth=0')) && course.includes(d1.folder) && course.includes(d2.folder), `${mode}: both chapters under the C202 heading`);
    ok(await p.locator('[data-open="deck-c202-ch02"].locked').count() === 1, `${mode}: Ch 2 soft-locked until the Ch 1 boss is passed`);
    if (mode === 'v1') {
      const old = JSON.parse(raw);
      ok(old.cards.every((c) => st.cards.some((x) => x.id === c.id && x.front === c.front)) && Object.entries(old.progress).every(([k, v]) => JSON.stringify(st.progress[k]) === JSON.stringify(v)), 'v1: existing cards and progress intact alongside the decks');
    }
    // study guide reading view
    await p.click('[data-open="deck-c202-ch01"] [data-guide]');
    const words = d1.summary.split(/\s+/).filter(Boolean).length, mins = Math.max(1, Math.round(words / 220));
    ok((await S(p, () => view.page)) === 'guide' && (await p.textContent('.guide-meta')).includes(`~${mins} min read · ${words.toLocaleString('en-US')} words`), `${mode}: study guide opens in reading view (~${mins} min, ${words} words)`);
    const colW = await p.$eval('.guide-md', (e) => e.getBoundingClientRect().width);
    ok(colW > 500 && colW < 760, `${mode}: comfortable column width (${Math.round(colW)}px)`);
    ok(await p.locator('.guide-md h3, .guide-md h4').count() > 5, `${mode}: headings rendered (${await p.locator('.guide-md h4').count()} sections)`);
    await p.mouse.wheel(0, 4000); await p.waitForTimeout(250);
    const prog1 = await p.textContent('#guideLeft');
    ok(/min left · \d+%/.test(prog1) && !/ 0%/.test(prog1), `${mode}: reading progress updates (${prog1})`);
    if (mode === 'fresh') { await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100); await hideToast(p); await p.screenshot({ path: SHOTS + '/study-guide-reading-desktop.png' }); }
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(150);
    await p.click('#guideRead');
    ok((await S(p, () => folderById('deck-c202-ch01').guideRead)) === '2026-10-05' && (await S(p, () => view.page)) === 'folder', `${mode}: Mark as read stores guideRead date and returns to the chapter`);
    ok(/✓ Read Oct 5/.test(await p.textContent('.step[data-stepkey="guide"]')), `${mode}: path shows the guide as read`);
    await p.click('#studyBtn');
    ok(!(await S(p, () => document.getElementById('modal').open)), `${mode}: no nudge once the guide is read`);
    await S(p, () => { const id = view.queue.find((x) => isScenario(state.cards.find((c) => c.id === x))); view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); });
    const correct = await S(p, () => currentCard().correct);
    await p.click(`[data-spick="${correct}"]`);
    ok(/Correct/.test(await p.textContent('#explainBox')) && /Read more/i.test(await p.textContent('#explainBox')), `${mode}: scenario in study grades and shows Read more`);
    await p.click('#exitStudy'); await p.click('#quizBtn');
    const qi = await S(p, () => { const sc = view.queue.map((id) => state.cards.find((c) => c.id === id)); const s = sc.find(isScenario), r = sc.find((c) => !isScenario(c)); return { s: JSON.stringify(makeChoices(s).map((x) => x.text)) === JSON.stringify(s.choices), r: makeChoices(r).length }; });
    ok(qi.s && qi.r === 4, `${mode}: quiz uses supplied scenario choices; regular cards get 4 options`);
    await p.click('#exitStudy'); await p.click('#bossBtn');
    ok((await S(p, () => view.boss.ids.length)) === d1.cards.length, `${mode}: boss has all ${d1.cards.length} cards`);
    await answerBoss(p, (i) => i % 10 !== 0);
    const res = await p.textContent('#bossResult');
    ok(/Boss defeated/.test(res) && /now unlocked/.test(res), `${mode}: Ch 1 boss passes (${res.match(/\d+%/)[0]}) and unlocks Ch 2`);
    ok(await p.locator('.review-item .readmore').count() > 0, `${mode}: boss review shows Read more`);
    await p.click('#exitBoss'); await p.click('#matchBtn');
    const ids = await S(p, () => view.match.pairs.map((x) => x.id));
    for (const id of ids) { await p.click(`[data-term="${id}"]`); await p.click(`[data-def="${id}"]`); }
    await p.waitForSelector('#matchResult');
    ok(ids.length === 6, `${mode}: matching game completes on Ch 1`);
    await p.click('#matchBack'); await p.click('#backHome');
    ok(await p.locator('.folder-card.locked[data-open="deck-c202-ch02"]').count() === 0 && await p.locator('[data-open="deck-c202-ch02"]').count() === 1, `${mode}: Ch 2 unlocked on home`);
    if (await p.locator('[data-open="deck-c202-ch03"]').count()) ok(await p.locator('.folder-card.locked[data-open="deck-c202-ch03"]').count() === 1, `${mode}: Ch 3 still locked behind Ch 2 boss`);
    await p.click('[data-open="deck-c202-ch02"]'); await p.click('#matchBtn');
    ok(/Read the study guide first\? \(~15 min\)/.test(await p.textContent('.dialog-body')), `${mode}: Ch 2 nudge shows ~15 min`);
    await p.click('#ovSkip');
    const ids2 = await S(p, () => view.match.pairs.map((x) => x.id));
    for (const id of ids2) { await p.click(`[data-term="${id}"]`); await p.click(`[data-def="${id}"]`); }
    await p.waitForSelector('#matchResult');
    ok(true, `${mode}: matching game completes on Ch 2`);
    await ctx.close();
  }
  // in-place update from a previous ch01 version
  const { ctx, p } = await page();
  await p.goto(PREV);
  ok((await S(p, () => state.cards.filter((c) => c.folderId === 'deck-c202-ch01').length)) === 77, 'previous ch01 build: 77 cards');
  await p.click('[data-open="deck-c202-ch01"]'); await p.click('#studyBtn');
  for (let i = 0; i < 10; i++) {
    if (await p.locator('[data-spick]').count()) { const c = await S(p, () => currentCard().correct); await p.click(`[data-spick="${c}"]`); await p.click('#nextStudy'); }
    else { await p.click('#flipBtn'); await p.click('#gotBtn'); }
  }
  await S(p, () => { state.progress['c202-ch01-001'] = { streak: 3, retired: true }; folderById('deck-c202-ch01').bestMatch = { ms: 9000, pairs: 6, date: '2026-10-05' }; save(); });
  const before = await S(p, () => JSON.parse(JSON.stringify(state.progress)));
  await p.goto(REAL);
  const st = await S(p, () => state);
  ok(st.folders.filter((f) => f.deckId === 'c202-ch01').length === 1 && st.cards.filter((c) => c.folderId === 'deck-c202-ch01').length === d1.cards.length, `ch01 updated in place: one folder, ${d1.cards.length} cards, no duplicates`);
  ok(Object.entries(before).filter(([k]) => k.startsWith('c202-ch01')).every(([k, v]) => JSON.stringify(st.progress[k]) === JSON.stringify(v)) && Object.keys(before).filter((k) => k.startsWith('c202-ch01')).length >= 10, `progress from the previous ch01 version kept (${Object.keys(before).filter((k) => k.startsWith('c202-ch01') && (before[k].streak || before[k].retired)).length} cards with progress)`);
  const c1 = st.cards.find((c) => c.id === 'c202-ch01-001'), n1 = d1.cards.find((c) => c.id === 'c202-ch01-001');
  ok(c1.answer === n1.answer && (c1.note || '') === (n1.note || '') && st.folders.find((f) => f.deckId === 'c202-ch01').summary && st.folders.find((f) => f.deckId === 'c202-ch01').bestMatch.ms === 9000, 'card content, notes and study guide updated; folder stats kept');
  ok(/updated/.test(await p.textContent('#toast')), 'toast: ' + (await p.textContent('#toast')));
  await ctx.close();
}

async function screenshots() {
  console.log('\n[11] Screenshots');
  const NOW = '2026-10-05T19:30:00-06:00';
  for (const [tag, opt] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { device: 'iPhone 13' }]]) {
    // samples: grouping/locked, scenario, boss results, match
    let { ctx, p } = await page({ ...opt, now: NOW });
    await p.goto(SAMPLES); await hideToast(p);
    await p.screenshot({ path: `${SHOTS}/home-course-locked-${tag}.png`, fullPage: true });
    await p.click('[data-open="deck-c202-ch01"]');
    await p.click('#studyBtn');
    await p.screenshot({ path: `${SHOTS}/read-guide-prompt-${tag}.png` });
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
    // real decks: plan, banner, path, guide
    ({ ctx, p } = await page({ ...opt, now: NOW }));
    await p.goto(REAL); await hideToast(p);
    await p.click('#planBtn'); await p.click('#savePlan'); await hideToast(p);
    await p.screenshot({ path: `${SHOTS}/plan-screen-${tag}.png`, fullPage: true });
    await p.click('#planBack'); await hideToast(p);
    await p.screenshot({ path: `${SHOTS}/home-plan-banner-${tag}.png`, fullPage: tag === 'phone' });
    await p.click('[data-open="deck-c202-ch01"]');
    await S(p, () => { folderById('deck-c202-ch01').guideRead = '2026-10-05'; save(); render(); });
    await p.screenshot({ path: `${SHOTS}/folder-path-${tag}.png` });
    await p.click('[data-step="guide"]'); await hideToast(p);
    await p.screenshot({ path: `${SHOTS}/study-guide-reading-${tag}.png` });
    await p.mouse.wheel(0, 2500); await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/study-guide-scrolled-${tag}.png` });
    await p.click('#guideBack');
    await p.click('#studyBtn');
    await S(p, () => { const id = view.queue.find((x) => isScenario(state.cards.find((c) => c.id === x))); view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); });
    await p.click('[data-spick="0"]'); await hideToast(p);
    await p.screenshot({ path: `${SHOTS}/real-c202-ch01-scenario-${tag}.png`, fullPage: true });
    await ctx.close();
  }
  ok(true, 'screenshots written to ' + SHOTS);
}

(async () => {
  execSync(`cd ${ROOT} && git show 0066785:flashcards.html > ${T}/original.html`);
  fs.rmSync(T + '/inbox', { recursive: true, force: true }); fs.mkdirSync(T + '/inbox', { recursive: true });
  for (const f of fs.readdirSync(ROOT + '/decks/samples')) fs.copyFileSync(ROOT + '/decks/samples/' + f, T + '/inbox/' + f);
  execSync(`${ROOT}/build.sh --inbox ${T}/inbox --out ${T}/dist-samples.html`);
  fs.rmSync(T + '/inbox-prev', { recursive: true, force: true }); fs.mkdirSync(T + '/inbox-prev');
  fs.copyFileSync(T + '/ch01-prev.json', T + '/inbox-prev/c202-ch01.json');
  execSync(`${ROOT}/build.sh --inbox ${T}/inbox-prev --out ${T}/dist-prev.html`);
  browser = await chromium.launch();
  try {
    const raw = await makeV1Data();
    await testV1(raw);
    await testMergeImport();
    await testScenario();
    await testBossGating();
    await testMatch();
    await testBundled();
    await testPath();
    await testPlanner();
    await testResumeAndQuick();
    await testReal(raw);
    await screenshots();
  } catch (e) { fail++; console.log('EXCEPTION', e); }
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ':\n' + errors.join('\n') : ''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
