const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = '/workspace/flashcards', T = '/tmp/fc-test', SHOTS = ROOT + '/screens';
const APP = 'file://' + ROOT + '/flashcards.html', ORIG = 'file://' + T + '/original.html';
const SAMPLES = 'file://' + T + '/dist-samples.html', REAL = 'file://' + ROOT + '/dist/flashcards.html';
const PREV = 'file://' + T + '/dist-prev.html';
const GOOGLE = 'file://' + T + '/dist-google.html';
const GIST = 'file://' + T + '/dist-gist.html'; // real decks, no Firebase config (gist-only UI)
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
  // The app's custom confirm dialog (#confirmDlg) is answered the same way as native dialogs.
  if (!opts.manualDialogs) {
    await p.exposeFunction('__testDialog', (msg) => { p.dialogLog.push(msg); return p.dialogAnswers.length ? p.dialogAnswers.shift() : true; });
    await p.addInitScript(() => {
      new MutationObserver(() => {
        const d = document.getElementById('confirmDlg');
        if (!d || !d.open || d.dataset.t) return;
        d.dataset.t = '1';
        const msg = Array.from(d.querySelectorAll('.cd-msg p')).map((x) => x.textContent).join('\n\n');
        window.__testDialog(msg).then((yes) => { const b = d.querySelector(yes ? '#cdYes' : '#cdNo'); if (b) b.click(); });
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    });
  }
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
  ok(qinfo.filter((q) => q.scen).every((q) => JSON.stringify(q.choices.slice().sort()) === JSON.stringify(q.supplied.slice().sort())), 'quiz: scenario cards use exactly their supplied choices (shuffled)');
  const scenTexts = await S(p, () => state.cards.filter(isScenario).flatMap((c) => [c.answer, c.explanation, ...c.choices]).filter(Boolean));
  ok(qinfo.filter((q) => !q.scen).every((q) => q.choices.length === 4 && q.choices.every((t) => !scenTexts.includes(t))), 'quiz: regular-card distractors come only from regular cards');
  ok((await S(p, () => view.quizSource.length)) === 12, 'quizBtn fix: view.quizSource is set (12)');
  await S(p, () => { const id = 'c202-ch02-017'; view.queue[view.index] = id; view.choices = makeChoices(state.cards.find((c) => c.id === id)); render(); });
  await p.click(`[data-choice="${await S(p, () => view.choices.findIndex((c) => !c.correct))}"]`);
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
  execSync(`${ROOT}/build.sh --firebase-config none --inbox ${inbox2} --out ${T}/dist-v2.html`);
  await p.goto('file://' + T + '/dist-v2.html');
  st = await S(p, () => state);
  ok(st.folders.length === 3 && st.cards.filter((c) => c.folderId === 'deck-c202-ch02').length === 13, 'changed deck comes back (content hash changed), with new card');
  ok(st.cards.find((c) => c.id === 'c202-ch01-002').answer === 'Changed HRM answer' && st.progress['c202-ch01-002'].streak === 2, 'updated bundled card changed in place, progress kept');
  ok(st.cards.filter((c) => c.folderId === 'deck-c202-ch01').length === 12, 'no duplicates in updated deck');
  await ctx.close();
  // build validation rejects bad decks
  const bad = path.join(T, 'inbox-bad'); fs.rmSync(bad, { recursive: true, force: true }); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'x.json'), JSON.stringify({ id: 'x', folder: 'X', cards: [{ id: '1', type: 'scenario', front: 'q', choices: ['a', 'b'], correct: 5 }] }));
  let failed = false; try { execSync(`${ROOT}/build.sh --firebase-config none --inbox ${bad} --out ${T}/bad.html`, { stdio: 'pipe' }); } catch (e) { failed = /correct/.test(String(e.stderr)); }
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
    const qi = await S(p, () => { const sc = view.queue.map((id) => state.cards.find((c) => c.id === id)); const s = sc.find(isScenario), r = sc.find((c) => !isScenario(c)); return { s: JSON.stringify(makeChoices(s).map((x) => x.text).sort()) === JSON.stringify(s.choices.slice().sort()), r: makeChoices(r).length }; });
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
  await p.click('[data-open="deck-c202-ch01"]'); await p.click('#studyBtn'); await skipNudge(p);
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

/* ---------- Study counter (roundTotal / roundPos) ---------- */
async function answerCard(p, right = true) {
  if (await p.locator('#flipBtn').count()) { await p.click('#flipBtn'); await p.click(right ? '#gotBtn' : '#missBtn'); return; }
  const idx = await S(p, (right) => { const c = state.cards.find((x) => x.id === view.queue[view.index]); return right ? c.correct : (c.correct + 1) % c.choices.length; }, right);
  await p.click(`[data-spick="${idx}"]`); await p.click('#nextStudy');
}

async function testCounter() {
  console.log('\n[12] Study counter keeps the shuffle total fixed');
  const { ctx, p } = await page();
  await p.goto(REAL);
  await p.click('[data-open="deck-c202-ch01"]'); await skipNudge(p);
  await p.click('#studyBtn'); await skipNudge(p);
  const label = async () => (await p.textContent('.study-wrap')).match(/Card (\d+) of (\d+)/);
  const m1 = await label();
  ok(m1 && m1[1] === '1', 'starts at Card 1 of ' + (m1 && m1[2]));
  await answerCard(p, true);
  const m2 = await label();
  ok(m2 && m2[1] === '2' && m2[2] === m1[2], `after a correct answer: Card ${m2 && m2[1]} of ${m2 && m2[2]} (total unchanged)`);
  await answerCard(p, false);
  const m3 = await label();
  ok(m3 && m3[1] === '3' && m3[2] === m1[2], `after a miss: Card ${m3 && m3[1]} of ${m3 && m3[2]}`);
  await p.click('#exitStudy');
  const resume = await p.textContent('body');
  ok(new RegExp(`Card 3 of ${m1[2]}`).test(resume), 'saved session label keeps the same position and total');
  await ctx.close();
}

/* ---------- Cross-device sync through a mocked GitHub Gist API ---------- */
const GOOD_TOKEN = 'github_pat_11TESTTOKENabcdefghijklmnopqrstuvwxyz';
function makeGistStore() {
  return { gists: {}, calls: [], fail: null, nextId: 1 };
}
async function mockGitHub(ctx, store) {
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS', 'access-control-expose-headers': 'X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    store.calls.push(`${method} ${url.pathname}`);
    if (store.fail === 'offline') return route.abort('internetdisconnected');
    const json = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...cors, ...headers }, body: JSON.stringify(body) });
    if (store.fail === 'rate') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    if (store.fail === '502') return json(502, { message: 'Bad gateway' });
    if (req.headers()['authorization'] !== 'Bearer ' + GOOD_TOKEN) return json(401, { message: 'Bad credentials' });
    const full = (g) => ({ ...g, files: Object.fromEntries(Object.entries(g.files).map(([n, f]) => [n, { filename: n, raw_url: `https://gist.githubusercontent.com/x/${g.id}/raw/${n}`, size: f.content.length, truncated: false, content: f.content }])) });
    if (method === 'GET' && url.pathname === '/gists') {
      const page = Number(url.searchParams.get('page') || 1);
      const list = page === 1 ? Object.values(store.gists).map((g) => { const f = full(g); Object.values(f.files).forEach((x) => delete x.content); return f; }) : [];
      return json(200, list);
    }
    if (method === 'POST' && url.pathname === '/gists') {
      const body = JSON.parse(req.postData());
      const id = 'a1b2c3d4e5f6a7b8c9d0' + String(store.nextId++).padStart(4, '0');
      store.gists[id] = { id, description: body.description, public: body.public, owner: { login: 'BraydenMacfarlane' }, files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, { content: f.content }])) };
      store.lastBody = req.postData();
      return json(201, full(store.gists[id]));
    }
    const m = url.pathname.match(/^\/gists\/([0-9a-f]+)$/);
    if (m && store.gists[m[1]]) {
      const g = store.gists[m[1]];
      if (method === 'GET') return json(200, full(g));
      if (method === 'PATCH') {
        store.lastBody = req.postData();
        const body = JSON.parse(req.postData());
        Object.entries(body.files || {}).forEach(([n, f]) => { if (f === null) delete g.files[n]; else g.files[n] = { content: f.content }; });
        store.patches = (store.patches || 0) + 1;
        return json(200, full(g));
      }
    }
    return json(404, { message: 'Not Found' });
  });
}
function remotePayload(store) { const g = Object.values(store.gists)[0]; return g ? JSON.parse(g.files['study-buddy-sync.json'].content) : null; }
async function syncDevice(opts = {}) {
  const d = await page(opts);
  await mockGitHub(d.ctx, opts.store);
  await d.p.goto(GIST);
  return d;
}
async function openSync(p) { await p.click('#syncBtn'); await p.waitForSelector('#syncStatus'); }
async function waitStatus(p, re, timeout = 8000) {
  await p.waitForFunction((src) => { const el = document.querySelector('[data-sync-status]'); return el && new RegExp(src).test(el.textContent); }, re.source, { timeout }).catch(() => {});
  return (await p.textContent('[data-sync-status]')) || '';
}
async function syncNowAndWait(p) { return S(p, () => syncNow('test')); }
async function setProg(p, ids, streak, retired = false) { await S(p, ([ids, streak, retired]) => { ids.forEach((id) => { state.progress[id] = { streak, retired }; }); save(); }, [ids, streak, retired]); }
async function getProg(p, id) { return S(p, (id) => state.progress[id] || null, id); }

async function testSync() {
  console.log('\n[13] Cross-device sync via a secret GitHub Gist (GitHub API mocked)');
  const errStart = errors.length;
  const store = makeGistStore();
  const A = await syncDevice({ store });
  const ch1 = await S(A.p, () => cardsIn('deck-c202-ch01').map((c) => c.id));
  const ch2 = await S(A.p, () => cardsIn('deck-c202-ch02').map((c) => c.id));
  // Real study on device A (UI), plus a couple of mastered cards.
  await A.p.click('[data-open="deck-c202-ch01"]'); await skipNudge(A.p); await A.p.click('#studyBtn'); await skipNudge(A.p);
  for (let i = 0; i < 3; i++) await answerCard(A.p, true);
  await A.p.click('#exitStudy'); await A.p.click('#backHome');
  await setProg(A.p, ch1.slice(0, 2), 3, true);
  const aStudied = await S(A.p, () => Object.keys(state.progress).filter((k) => state.progress[k].streak > 0));
  ok(store.calls.length === 0, 'no GitHub calls before connecting');

  // ---- Device A: first connect creates the secret gist.
  await openSync(A.p);
  ok(/Not connected/.test(await A.p.textContent('#syncStatus')), 'Sync screen says Not connected at first');
  ok(await A.p.locator('a[href="https://github.com/settings/personal-access-tokens/new"]').count() === 1, 'how-to links to the new fine-grained token page');
  ok(/Gists/.test(await A.p.textContent('.sync-steps')) && /Read and write/.test(await A.p.textContent('.sync-steps')), 'how-to names the Gists: Read and write permission');
  await A.p.fill('#syncToken', GOOD_TOKEN); await A.p.click('#syncConnect');
  let st = await waitStatus(A.p, /Synced/);
  ok(/Synced just now/.test(st), 'device A status after connect: ' + st);
  const gids = Object.keys(store.gists);
  ok(gids.length === 1 && store.calls.includes('POST /gists'), 'first connect created exactly one gist');
  const g = store.gists[gids[0]];
  ok(g.public === false && g.description === 'Study-Buddy-1000 sync', 'gist is secret with the fixed description');
  ok(g.files['study-buddy-sync.json'] && g.files['c202-plan.txt'], 'gist has study-buddy-sync.json and c202-plan.txt');
  ok((await A.p.textContent('#syncId')).trim() === gids[0], 'Sync ID shown on the Sync screen matches the gist id');
  let R = remotePayload(store);
  ok(aStudied.every((id) => R.p[id] && R.p[id][0] > 0) && R.p[ch1[0]][1] === 1, `payload carries device A progress (${aStudied.length} studied cards)`);
  const sizeKB = g.files['study-buddy-sync.json'].content.length / 1024;
  const bundledFront = await S(A.p, () => state.cards.find((c) => c.folderId === 'deck-c202-ch03').front);
  ok(sizeKB < 40 && !g.files['study-buddy-sync.json'].content.includes(bundledFront) && !/"summary":"#/.test(g.files['study-buddy-sync.json'].content), `payload is compact (${sizeKB.toFixed(1)} KB) with no bundled card text or study guides`);
  ok(!JSON.stringify(store.gists).includes(GOOD_TOKEN) && !(store.lastBody || '').includes(GOOD_TOKEN), 'token is never written to the gist');
  ok(R.summary && R.summary.courses && R.summary.courses.C202 && R.summary.courses.C202.length === 14, 'payload has a 14-chapter progress summary for the helper');
  ok(await noBroke(A.p), 'app fine after connect');

  // ---- Device B: fresh context (iPhone-sized), same token, finds the same gist and gets A's progress.
  const B = await syncDevice({ store, device: 'iPhone 13' });
  ok(!((await getProg(B.p, ch1[0])) || {}).streak, 'device B starts with no progress');
  await B.p.tap('#syncBtn'); await B.p.waitForSelector('#syncToken');
  await hideToast(B.p); await B.p.screenshot({ path: `${SHOTS}/sync-phone-connect.png`, fullPage: true });
  await B.p.fill('#syncToken', GOOD_TOKEN); await B.p.tap('#syncConnect');
  st = await waitStatus(B.p, /Synced/);
  ok(/Synced/.test(st) && Object.keys(store.gists).length === 1, 'device B connected to the SAME gist (no second gist created)');
  ok((await B.p.textContent('#syncId')).trim() === gids[0], 'device B shows the same Sync ID');
  const bp = await getProg(B.p, ch1[0]);
  ok(bp && bp.retired && bp.streak === 3, 'device B received device A progress (mastered card)');
  ok(aStudied.every((id) => true) && (await S(B.p, (ids) => ids.every((id) => state.progress[id] && state.progress[id].streak > 0), aStudied)), 'device B has every card studied on A');
  const empCount = async (p) => S(p, () => state.folders.filter((f) => f.name === 'U.S. Employment Law').length);
  ok(await empCount(B.p) === 1 && (await S(B.p, () => cardsIn(state.folders.find((f) => f.name === 'U.S. Employment Law').id).length)) === 17, 'starter folder seeded on both devices is not duplicated (17 cards, one folder)');
  await hideToast(B.p); await B.p.screenshot({ path: `${SHOTS}/sync-phone-connected.png`, fullPage: true });
  await B.p.tap('#syncBack');
  ok(/Synced/.test(await B.p.textContent('footer.note')), 'home footer shows the sync status');

  // ---- Concurrent changes on both devices merge without loss.
  await setProg(A.p, [ch1[10]], 2);
  await S(A.p, () => { state.folders.push({ id: 'user-f1', name: 'My Phone-Free Notes' }); state.cards.push({ id: 'user-c1', folderId: 'user-f1', front: 'Own term', answer: 'Own answer', subtitle: '', note: '', points: [] }); save(); });
  await setProg(B.p, [ch2[5]], 2);
  await S(B.p, () => { folderById('deck-c202-ch02').guideRead = '2026-10-10'; makePlan('C202', 'speedy', '2026-10-05'); save(); });
  await S(B.p, () => { const f = folderById('deck-c202-ch01'); f.bestBoss = { pct: 70, passed: false, date: '2026-10-10' }; save(); });
  await S(A.p, () => { const f = folderById('deck-c202-ch01'); f.bestBoss = { pct: 90, passed: true, date: '2026-10-11' }; save(); });
  // Same card changed on both: the later change wins (B answers it wrong after A mastered it).
  await setProg(A.p, [ch1[20]], 1); await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  await setProg(A.p, [ch1[20]], 2);
  await A.p.waitForTimeout(20);
  await setProg(B.p, [ch1[20]], 0);
  await syncNowAndWait(A.p); await syncNowAndWait(B.p); await syncNowAndWait(A.p);
  const a = await S(A.p, ([c1, c2]) => ({ p10: state.progress[c1[10]], p5: state.progress[c2[5]], p20: state.progress[c1[20]], guide: folderById('deck-c202-ch02').guideRead, plan: state.plans.C202 && state.plans.C202.pace, boss: folderById('deck-c202-ch01').bestBoss, uf: !!folderById('user-f1') }), [ch1, ch2]);
  const b = await S(B.p, ([c1, c2]) => ({ p10: state.progress[c1[10]], p5: state.progress[c2[5]], p20: state.progress[c1[20]], guide: folderById('deck-c202-ch02').guideRead, plan: state.plans.C202 && state.plans.C202.pace, boss: folderById('deck-c202-ch01').bestBoss, uf: !!folderById('user-f1'), uc: state.cards.find((c) => c.id === 'user-c1') }), [ch1, ch2]);
  ok(a.p5 && a.p5.streak === 2 && a.guide === '2026-10-10' && a.plan === 'speedy', 'device A got B\'s progress, guide-read flag and plan');
  ok(b.p10 && b.p10.streak === 2 && b.uf && b.uc && b.uc.answer === 'Own answer', 'device B got A\'s progress and user-made folder + card');
  ok(a.boss.pct === 90 && a.boss.passed && b.boss.pct === 90 && b.boss.passed, 'boss best keeps the better score on both');
  ok(a.p20 && a.p20.streak === 0 && b.p20 && b.p20.streak === 0, 'same card changed on both: the most recent answer wins on both devices');
  ok(aStudied.every((id) => true) && (await S(A.p, (ids) => ids.every((id) => state.progress[id] && state.progress[id].streak > 0), aStudied)), 'nothing from the first round was lost');
  ok(/C202 .*study plan/.test(store.gists[gids[0]].files['c202-plan.txt'].content) && /Pace: /.test(store.gists[gids[0]].files['c202-plan.txt'].content), 'c202-plan.txt in the gist holds the Share-plan text');
  ok(store.gists[gids[0]].files['c202-plan.txt'].content === await S(B.p, () => planText('C202')), 'c202-plan.txt matches Share plan output exactly');

  // ---- Deletions stick (tombstones) and don't come back.
  await S(A.p, () => { state.cards = state.cards.filter((c) => c.folderId !== 'user-f1'); state.folders = state.folders.filter((f) => f.id !== 'user-f1'); save(); });
  await S(B.p, () => { const id = cardsIn('deck-c202-ch14')[0].id; window.__delCard = id; state.cards = state.cards.filter((c) => c.id !== id); delete state.progress[id]; save(); });
  const delCard = await S(B.p, () => window.__delCard);
  await syncNowAndWait(A.p); await syncNowAndWait(B.p); await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  ok(!(await S(B.p, () => !!folderById('user-f1'))) && !(await S(A.p, () => !!folderById('user-f1'))), 'folder deleted on A is gone on both and stays gone');
  ok(!(await S(A.p, (id) => state.cards.some((c) => c.id === id), delCard)), 'built-in card deleted on B is gone on A too');
  await A.p.reload(); await syncNowAndWait(A.p);
  ok(!(await S(A.p, () => !!folderById('user-f1'))) && !(await S(A.p, (id) => state.cards.some((c) => c.id === id), delCard)), 'deleted items stay gone after a reload + sync');
  // Sessions: a mid-session save syncs, and clearing it syncs too.
  await S(A.p, () => setSession('deck-c202-ch03', 'quiz', { ids: ['x'], index: 0, quizTotal: 5, score: 0 }));
  await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  ok(await S(B.p, () => !!getSession('deck-c202-ch03', 'quiz')), 'a saved mid-session reaches the other device');
  await S(B.p, () => clearSession('deck-c202-ch03', 'quiz'));
  await syncNowAndWait(B.p); await syncNowAndWait(A.p);
  ok(!(await S(A.p, () => !!getSession('deck-c202-ch03', 'quiz'))), 'finishing / discarding a session on one device clears it on the other');

  // ---- Debounced automatic push after a change (no manual sync).
  const before = store.patches || 0;
  await A.p.click('[data-open="deck-c202-ch04"]'); await skipNudge(A.p); await A.p.click('#studyBtn'); await skipNudge(A.p);
  const cur = await S(A.p, () => view.queue[view.index]);
  await answerCard(A.p, true);
  await A.p.waitForTimeout(7500);
  R = remotePayload(store);
  ok((store.patches || 0) > before && R.p[cur] && R.p[cur][0] === 1, 'a study answer is pushed automatically ~6s later');
  // Hidden page flushes pending changes right away.
  await answerCard(A.p, true);
  const cur2 = await S(A.p, () => view.queue[view.index - 1] || null);
  await S(A.p, () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await A.p.waitForTimeout(800);
  const pushedHidden = remotePayload(store);
  ok(Object.keys(pushedHidden.p).length >= Object.keys(R.p).length && store.lastBody && (await S(A.p, () => !SYNC.dirty)), 'switching away from the app pushes pending changes immediately');
  await S(A.p, () => { delete document.visibilityState; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
  await A.p.click('#exitStudy'); await A.p.click('#backHome');

  // ---- Offline / failed push leaves local data intact.
  store.fail = 'offline';
  await setProg(A.p, [ch2[30]], 2, false);
  await syncNowAndWait(A.p);
  st = await A.p.textContent('[data-sync-status]');
  ok(/Offline, will retry/.test(st), 'offline: status says ' + st);
  ok((await getProg(A.p, ch2[30])).streak === 2 && await noBroke(A.p), 'offline: local change kept, app not broken');
  await A.p.reload();
  await A.p.waitForTimeout(500);
  ok((await getProg(A.p, ch2[30])).streak === 2 && await noBroke(A.p), 'offline: change survives a reload while still offline');
  store.fail = '502';
  await syncNowAndWait(A.p);
  ok(/will retry/.test(await A.p.textContent('[data-sync-status]')) && (await getProg(A.p, ch2[30])).streak === 2, 'GitHub 5xx: will retry, local data intact');
  store.fail = 'rate';
  await syncNowAndWait(A.p);
  ok(/GitHub is busy, will retry at/.test(await A.p.textContent('[data-sync-status]')), 'rate limit: friendly status with retry time');
  store.fail = null;
  await syncNowAndWait(A.p);
  ok(remotePayload(store).p[ch2[30]][0] === 2 && /Synced/.test(await A.p.textContent('[data-sync-status]')), 'back online: the offline change reached the gist');

  // ---- Bad token: clear message, nothing created, local data untouched.
  const C = await syncDevice({ store, device: 'iPhone 13' });
  await setProg(C.p, [ch1[50]], 1);
  await C.p.tap('#syncBtn'); await C.p.fill('#syncToken', 'ghp_wrongtoken'); await C.p.tap('#syncConnect');
  st = await waitStatus(C.p, /Token problem/);
  ok(/Token problem/.test(st) && await C.p.locator('#syncToken').count() === 1, 'wrong token: "Token problem" and the token box stays');
  ok(Object.keys(store.gists).length === 1 && (await getProg(C.p, ch1[50])).streak === 1, 'wrong token: no gist created, local progress intact');
  await C.ctx.close();

  // ---- Export never contains the token.
  await A.p.click('#syncBtn'); await A.p.click('#syncBack');
  const [dl] = await Promise.all([A.p.waitForEvent('download'), A.p.click('#exportBtn')]);
  const exported = fs.readFileSync(await dl.path(), 'utf8');
  ok(!exported.includes(GOOD_TOKEN) && !exported.includes('flashcards.sync') && exported.includes('"progress"'), 'Export backup does not contain the token');

  // ---- Disconnect keeps local data; reconnecting finds the same gist.
  await openSync(A.p);
  await A.p.click('#syncDisconnect');
  ok(/Not connected/.test(await A.p.textContent('#syncStatus')) && !(await S(A.p, () => localStorage.getItem('flashcards.sync.token'))), 'Disconnect removes the token from this device');
  ok((await getProg(A.p, ch1[0])).retired && (await getProg(A.p, ch2[30])).streak === 2, 'Disconnect keeps all local progress');
  await A.p.fill('#syncToken', GOOD_TOKEN); await A.p.click('#syncConnect');
  await waitStatus(A.p, /Synced/);
  ok(Object.keys(store.gists).length === 1 && (await A.p.textContent('#syncId')).trim() === gids[0], 'reconnecting finds the same gist');

  // ---- Box helper reads the plan anonymously.
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const m = req.url.match(/^\/gists\/([0-9a-f]+)$/);
    const gg = m && store.gists[m[1]];
    if (req.headers.authorization) { res.writeHead(500); return res.end('auth header sent'); }
    if (!gg) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...gg, files: Object.fromEntries(Object.entries(gg.files).map(([n, f]) => [n, { filename: n, content: f.content, truncated: false }])) }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let out = '';
  out = await new Promise((res) => require('child_process').exec(`${ROOT}/tools/read-plan.sh ${gids[0]}`, { env: { ...process.env, GIST_API_BASE: `http://127.0.0.1:${srv.address().port}`, GH_TOKEN: 'ghp_shouldNeverBeUsed' } }, (e, so, se) => res(e ? 'ERR ' + e.message + so + se : so)));
  srv.close();
  ok(/C202 .*study plan/.test(out) && /Pace: /.test(out) && out.includes(store.gists[gids[0]].files['c202-plan.txt'].content), 'tools/read-plan.sh prints the pacing plan');
  ok(/C202: \d+\/23\d\d cards mastered/.test(out) && /Ch 1 /.test(out) && /boss best 90% passed/.test(out), 'tools/read-plan.sh prints a progress summary');
  ok(!out.includes(GOOD_TOKEN) && !out.includes('ghp_') && !out.startsWith('ERR'), 'helper output has no token and sends no auth header');

  await A.ctx.close(); await B.ctx.close();
  // Expected network noise from the offline / 401 / 5xx / rate-limit cases above.
  const noise = /Failed to load resource|net::ERR_|api\.github\.com/;
  for (let i = errors.length - 1; i >= errStart; i--) if (noise.test(errors[i])) errors.splice(i, 1);
}

/* ---------- Per-mode session slots + "I know this" + retire after 2 ---------- */
async function skipVis(p) { const l = p.locator('#ovSkip'); if (await l.count() && await l.isVisible()) await l.click(); }
async function testSlotsAndKnow() {
  console.log('\n[14] Every study method has its own saved session; "I know this"; retire after 2');
  const { ctx, p } = await page();
  await p.goto(REAL);
  await p.click('[data-open="deck-c202-ch01"]'); await skipVis(p);
  await p.click('#quizBtn'); await skipVis(p);
  await p.click('[data-choice="0"]');
  await p.click('#exitStudy');
  const starts = [['#scenarioBtn', 'study-scenario'], ['#conceptBtn', 'study-concept'], ['#studyBtn', 'study-mixed']];
  for (const [btn, slot] of starts) {
    p.dialogLog.length = 0;
    await p.click(btn); await skipVis(p);
    ok(p.dialogLog.length === 0, `${btn} after other saves: no discard prompt (${p.dialogLog.join(' | ') || 'none'})`);
    await answerCard(p, true);
    await p.click('#exitStudy');
    ok(await S(p, (k) => !!state.sessions['deck-c202-ch01:' + k], slot), `saved into its own slot ${slot}`);
  }
  p.dialogLog.length = 0;
  await p.click('#quickBtn'); await skipVis(p); await p.click('[data-choice="0"]'); await p.click('#exitStudy');
  await p.click('#bossBtn'); await skipVis(p); await p.click('[data-bpick="0"]'); await p.click('#exitBoss');
  await p.click('#matchBtn'); await skipVis(p); await p.click('#exitMatch');
  ok(p.dialogLog.length === 0, 'quick, boss and match start without prompting about other saves');
  const keys = await S(p, () => Object.keys(state.sessions).filter((k) => k.startsWith('deck-c202-ch01:')).map((k) => k.split(':')[1]).sort());
  ok(['boss', 'match', 'quick', 'quiz', 'study-concept', 'study-mixed', 'study-scenario'].every((k) => keys.includes(k)), 'all 7 saves coexist: ' + keys.join(', '));
  const row = await p.textContent('#resumeRow');
  ok(['Resume quiz', 'Resume quick', 'Resume boss', 'Continue shuffled', 'Continue concept cards', 'Continue scenarios', 'Resume match'].every((t) => row.includes(t)), 'resume row has one labelled button per mode');
  ok(/Scenarios/.test(await p.textContent('[data-resume="study-scenario"]')) && /Concept cards/.test(await p.textContent('[data-resume="study-concept"]')), 'resume labels show the study method');
  await p.click('[data-resume="study-scenario"]');
  ok(await S(p, () => view.page === 'study' && view.studyMode === 'scenario'), 'Continue scenarios resumes the scenario session');
  await p.click('#exitStudy');
  p.dialogLog.length = 0; p.dialogAnswers.push(true);
  await p.click('#scenarioBtn'); await skipVis(p);
  ok(p.dialogLog.length === 1 && /saved scenario session/.test(p.dialogLog[0]), 'restarting Scenarios asks only about the saved scenario session');
  await p.click('#exitStudy');
  ok(await S(p, () => ['quiz', 'quick', 'boss', 'match', 'study-concept', 'study-mixed'].every((k) => !!state.sessions['deck-c202-ch01:' + k])), 'restarting Scenarios leaves every other save untouched');

  const legacy = await S(p, () => { const st = JSON.parse(localStorage.getItem('flashcards.v1')); const s = st.sessions['deck-c202-ch01:study-concept']; delete st.sessions['deck-c202-ch01:study-concept']; st.sessions['deck-c202-ch01:study'] = s; localStorage.setItem('flashcards.v1', JSON.stringify(st)); return s.studyMode; });
  await p.reload();
  ok(legacy === 'concept' && await S(p, () => !state.sessions['deck-c202-ch01:study'] && !!state.sessions['deck-c202-ch01:study-concept']), 'an old shared "study" save moves into its mode slot on load');
  await p.click('[data-open="deck-c202-ch01"]'); await skipVis(p);
  await p.click('[data-resume="study-concept"]');
  ok(await S(p, () => view.page === 'study' && view.studyMode === 'concept'), 'the migrated old save still resumes');
  await p.click('#exitStudy'); await p.click('#backHome');

  const ids = await S(p, () => cardsIn('deck-c202-ch02').filter((c) => !isScenario(c)).map((c) => c.id));
  await S(p, (ids) => { const st = JSON.parse(localStorage.getItem('flashcards.v1')); st.progress[ids[0]] = { streak: 2, retired: false }; st.progress[ids[1]] = { streak: 1, retired: false }; localStorage.setItem('flashcards.v1', JSON.stringify(st)); }, ids);
  await p.reload();
  ok(await S(p, (ids) => state.progress[ids[0]].retired && !state.progress[ids[1]].retired && RETIRE_AFTER === 2, ids), 'existing streak 2 counts as retired; streak 1 does not');
  await p.click('[data-open="deck-c202-ch02"]'); await skipVis(p);
  ok(/after 2 correct in a row/.test(await p.textContent('body')), 'folder copy says 2 correct in a row');
  await p.click('#conceptBtn'); await skipVis(p);
  ok(/streak \d\/2/.test(await p.textContent('.study-wrap')), 'study shows streak out of 2');
  const c1 = await S(p, () => view.queue[view.index]);
  await answerCard(p, true);
  await S(p, (id) => { view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; render(); }, c1);
  await answerCard(p, true);
  ok(await S(p, (id) => state.progress[id].retired, c1), 'two correct in a row retires a card');
  const k1 = await S(p, () => view.queue[view.index]);
  const left0 = await S(p, () => activeStudy(view.folderId, 'concept').length);
  ok(await p.locator('#knowBtn').count() === 1 && !(await S(p, () => view.flipped)), '"I know this" is available before revealing the answer');
  await p.click('#knowBtn');
  ok(await S(p, ([id, l]) => state.progress[id].retired && !view.queue.slice(view.index).includes(id) && activeStudy(view.folderId, 'concept').length === l - 1, [k1, left0]), '"I know this" retires the card and removes it from the round');
  await p.click('#flipBtn');
  ok(await p.locator('#knowBtn').count() === 1, '"I know this" also shows after revealing');
  await p.click('#exitStudy');
  await p.click('#scenarioBtn'); await skipVis(p);
  const sc = await S(p, () => view.queue[view.index]);
  await p.click(`[data-spick="${await S(p, (id) => state.cards.find((c) => c.id === id).correct, sc)}"]`);
  await p.click('#knowBtn');
  ok(await S(p, (id) => state.progress[id].retired && !view.queue.slice(view.index).includes(id), sc), '"I know this" works on a scenario after answering');
  await S(p, () => startStudy('scenario'));
  ok(await S(p, (id) => !view.queue.includes(id), sc), 'a known card stays out of later rounds');
  await p.click('#resetStudy');
  ok(await S(p, (id) => !state.progress[id].retired && activeStudy(view.folderId, 'scenario').some((c) => c.id === id), sc), 'Reset progress brings known cards back');
  await p.click('#exitStudy');
  ok(await noBroke(p), 'app fine');
  await ctx.close();

  const store = makeGistStore();
  const A = await syncDevice({ store }), B = await syncDevice({ store, device: 'iPhone 13' });
  for (const d of [A, B]) { await d.p.click('#syncBtn'); await d.p.fill('#syncToken', GOOD_TOKEN); await d.p.click('#syncConnect'); await waitStatus(d.p, /Synced/); await d.p.click('#syncBack'); }
  await A.p.click('[data-open="deck-c202-ch03"]'); await skipVis(A.p); await A.p.click('#conceptBtn'); await skipVis(A.p);
  const kA = await S(A.p, () => view.queue[view.index]);
  await A.p.click('#knowBtn'); await answerCard(A.p, true); await A.p.click('#exitStudy');
  await A.p.click('#scenarioBtn'); await skipVis(A.p); await answerCard(A.p, true); await A.p.click('#exitStudy');
  await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  ok(await S(B.p, (id) => state.progress[id] && state.progress[id].retired, kA), 'a card marked known on desktop is retired on the phone after sync');
  ok(await S(B.p, () => !!state.sessions['deck-c202-ch03:study-concept'] && !!state.sessions['deck-c202-ch03:study-scenario']), 'both study-method saves sync as separate slots');
  await A.ctx.close(); await B.ctx.close();
}

/* ---------- Optional per-card distractors ---------- */
async function testDistractors() {
  console.log('\n[15] Optional per-card "distractors" for concept cards');
  const cards = [
    { id: 'd-1', front: 'Q1', answer: 'Right one', distractors: ['Wrong A', 'Wrong B', 'Wrong C', 'Wrong D', 'Wrong E'] },
    { id: 'd-2', front: 'Q2', answer: 'Second right', distractors: ['Only wrong', 'second RIGHT', 'Only wrong ', '', 7] },
    { id: 'd-3', front: 'Q3', answer: 'Third right' },
    { id: 'd-4', front: 'Q4', answer: 'Fourth right' },
    { id: 'd-5', front: 'Q5', answer: 'Fifth right' },
    { id: 'd-6', type: 'scenario', front: 'S', choices: ['L', 'I'], correct: 0, explanation: 'x', distractors: ['nope', 'nah'] }
  ];
  const file = tmpJson('distractor-deck.json', { id: 'dtest', folder: 'Distractor test', cards });
  const { ctx, p } = await page();
  await p.goto(APP);
  const sum = await importFile(p, file);
  ok(/6 cards added/.test(sum), 'lenient import accepts a deck with messy distractors: ' + sum);
  const st = await S(p, () => ({ d1: state.cards.find((c) => c.id === 'd-1').distractors, d2: state.cards.find((c) => c.id === 'd-2').distractors, d3: 'distractors' in state.cards.find((c) => c.id === 'd-3'), d6: 'distractors' in state.cards.find((c) => c.id === 'd-6') }));
  ok(JSON.stringify(st.d1) === JSON.stringify(['Wrong A', 'Wrong B', 'Wrong C', 'Wrong D', 'Wrong E']), 'valid distractors kept as written');
  ok(JSON.stringify(st.d2) === JSON.stringify(['Only wrong', '7']) , 'import drops blanks, duplicates and the answer itself: ' + JSON.stringify(st.d2));
  ok(!st.d3 && !st.d6, 'no distractors field on cards without one or on scenarios');
  const runs = await S(p, () => {
    const pick = (id) => makeChoices(state.cards.find((c) => c.id === id));
    const r = { d1: [], d2: [], d3: [] };
    for (let i = 0; i < 40; i++) { r.d1.push(pick('d-1')); r.d2.push(pick('d-2')); r.d3.push(pick('d-3')); }
    return r;
  });
  const wrongs = (cs) => cs.filter((c) => !c.correct).map((c) => c.text);
  ok(runs.d1.every((cs) => cs.length === 4 && cs.filter((c) => c.correct).length === 1 && wrongs(cs).every((t) => /^Wrong [A-E]$/.test(t))), 'card with 5 distractors: 3 of its own are used every time');
  ok(new Set(runs.d1.flatMap(wrongs)).size === 5, 'all 5 authored distractors rotate in over several quizzes');
  ok(runs.d2.every((cs) => cs.length === 4 && wrongs(cs).includes('Only wrong') && wrongs(cs).includes('7') && new Set(cs.map((c) => c.text.toLowerCase())).size === 4 && !wrongs(cs).some((t) => /second right/i.test(t))), 'fewer than 3: authored ones first, filled from other cards, no duplicates or answer');
  const others = ['Right one', 'Second right', 'Fourth right', 'Fifth right'];
  ok(runs.d3.every((cs) => cs.length === 4 && wrongs(cs).every((t) => others.includes(t))) && new Set(runs.d3.flatMap(wrongs)).size === 4, 'card without distractors keeps random picks from other cards');
  await p.click('[data-open="deck-dtest"]'); await skipVis(p); await p.click('#quizBtn'); await skipVis(p);
  ok(await p.locator('[data-choice]').count() >= 2 && await noBroke(p), 'quiz runs on the deck');
  await ctx.close();
  // Real Ch 2 deck: a quiz question uses the card's own authored distractors.
  {
    const { ctx, p } = await page();
    await p.goto(REAL);
    const info = await S(p, () => ({ total: state.cards.filter((c) => (folderById(c.folderId) || {}).deckId).length, withD: state.cards.filter((c) => c.distractors && c.distractors.length === 3).length, ch1: cardsIn('deck-c202-ch01').filter((c) => c.distractors).length }));
    ok(info.total === 2380 && info.withD === 1121 && info.ch1 === 0, `built app: ${info.withD} of ${info.total} cards carry 3 distractors (Ch 1: ${info.ch1})`);
    await p.click('[data-open="deck-c202-ch02"]'); await skipVis(p); await p.click('#quizBtn'); await skipVis(p);
    const id = await S(p, () => cardsIn('deck-c202-ch02').find((c) => c.distractors && !isScenario(c)).id);
    await S(p, (id) => { view.queue = [id, ...view.queue.filter((x) => x !== id)]; view.index = 0; view.choices = makeChoices(state.cards.find((c) => c.id === id)); render(); }, id);
    const shown = (await p.locator('[data-choice]').allTextContents()).map((t) => t.trim());
    const card = await S(p, (id) => { const c = state.cards.find((x) => x.id === id); return { ans: cardAnswerText(c), d: c.distractors }; }, id);
    ok(shown.length === 4 && card.d.every((d) => shown.some((t) => t === d || t.startsWith(d.slice(0, 40)))) && shown.some((t) => t === card.ans || t.startsWith(card.ans.slice(0, 40))), 'Ch 2 quiz shows the card\'s own 3 distractors plus the answer');
    await ctx.close();
  }
  // build.sh validation
  const dir = path.join(T, 'inbox-distractors'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const bad = { id: 'bad', folder: 'Bad', cards: [
    { id: 'b1', front: 'f', answer: 'Ans', distractors: ['one'] },
    { id: 'b2', front: 'f', answer: 'Ans', distractors: ['x', 'X '] },
    { id: 'b3', front: 'f', answer: 'Ans', distractors: ['ans', 'y'] },
    { id: 'b4', front: 'f', answer: 'Ans', distractors: ['', 'y'] },
    { id: 'b5', front: 'f', answer: 'Ans', distractors: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { id: 'b6', type: 'scenario', front: 'f', choices: ['a', 'b'], correct: 0, explanation: 'e', distractors: ['p', 'q'] } ] };
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(bad));
  let out = '';
  try { execSync(`${ROOT}/build.sh --firebase-config none --inbox ${dir} --out ${T}/bad.html 2>&1`); out = 'BUILT'; } catch (e) { out = String(e.stdout || ''); }
  ok(out !== 'BUILT' && /card 1: "distractors" must be a list of 2-5/.test(out) && /card 2: distractors must be unique/.test(out) && /card 3: a distractor matches the answer/.test(out) && /card 4: every distractor must be a non-empty string/.test(out) && /card 5: "distractors" must be a list of 2-5/.test(out) && /card 6: "distractors" is only for concept cards/.test(out), 'build.sh rejects each bad distractors case with a clear error');
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'good', folder: 'Good', cards: [{ id: 'g1', front: 'f', answer: 'Ans', distractors: ['p', 'q', 'r'] }, { id: 'g2', front: 'f', answer: 'Ans2' }] }));
  try { execSync(`${ROOT}/build.sh --firebase-config none --inbox ${dir} --out ${T}/good.html 2>&1`); out = 'BUILT'; } catch (e) { out = String(e.stdout || ''); }
  ok(out === 'BUILT' && fs.readFileSync(`${T}/good.html`, 'utf8').includes('"distractors":["p","q","r"]'), 'build.sh accepts valid distractors and bakes them in');
}

/* ---------- Google sign-in sync (Firebase SDK + Firestore mocked) ---------- */
const FAKE_ID_TOKEN = 'FAKE-GOOGLE-ID-TOKEN-0123456789';
const FAKE_FB = {
  'firebase-app.js': `export function initializeApp(options) { return { options }; }`,
  'firebase-auth.js': `
    const KEY = 'fakeAuth.user'; const listeners = [];
    export const indexedDBLocalPersistence = {}, browserLocalPersistence = {}, browserPopupRedirectResolver = {};
    export function initializeAuth(app) { return { app, currentUser: JSON.parse(localStorage.getItem(KEY) || 'null'), authStateReady: async () => {} }; }
    export class GoogleAuthProvider { setCustomParameters() {} }
    const behaviour = async () => (await fetch('https://fake-firebase.test/auth/behaviour')).json();
    const err = (code) => Object.assign(new Error(code), { code });
    function setUser(a, u) { a.currentUser = u; if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY); listeners.forEach((f) => f(u)); }
    export async function signInWithPopup(a) { const b = await behaviour(); if (b.mode === 'popup-unsupported') throw err('auth/operation-not-supported-in-this-environment'); if (b.mode === 'closed') throw err('auth/popup-closed-by-user'); setUser(a, b.user); return { user: b.user }; }
    export async function signInWithRedirect(a) { const b = await behaviour(); localStorage.setItem('fakeAuth.redirect', JSON.stringify(b.user)); window.__redirected = (window.__redirected || 0) + 1; setTimeout(() => location.reload(), 10); return new Promise(() => {}); }
    export async function getRedirectResult(a) { const u = localStorage.getItem('fakeAuth.redirect'); if (!u) return null; localStorage.removeItem('fakeAuth.redirect'); setUser(a, JSON.parse(u)); return { user: JSON.parse(u) }; }
    export function onAuthStateChanged(a, f) { listeners.push(f); setTimeout(() => f(a.currentUser), 0); return () => {}; }
    export async function signOut(a) { setUser(a, null); }`,
  'firebase-firestore-lite.js': `
    export function getFirestore(app) { return { app }; }
    export function doc(db, ...p) { return { path: p.join('/') }; }
    export function serverTimestamp() { return { __ts: true }; }
    const err = (code) => Object.assign(new Error(code), { code });
    async function call(method, ref, data) {
      const u = JSON.parse(localStorage.getItem('fakeAuth.user') || 'null');
      let r;
      try { r = await fetch('https://fake-firebase.test/fs/' + ref.path, { method, headers: { 'x-uid': u ? u.uid : '', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); }
      catch (e) { throw err('unavailable'); }
      if (r.status === 403) throw err('permission-denied');
      if (!r.ok) throw err('unavailable');
      return r.json();
    }
    export async function getDoc(ref) { const j = await call('GET', ref); return { exists: () => j.exists, data: () => j.data }; }
    export async function setDoc(ref, data) { await call('POST', ref, data); }`
};
function makeFbStore() { return { docs: {}, calls: [], fail: null, mode: 'ok', user: { uid: 'uid-brayden', email: 'brayden@example.com', displayName: 'Brayden', accessToken: FAKE_ID_TOKEN } }; }
async function mockFirebase(ctx, fb) {
  await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop();
    route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_FB[name] || 'export {}' });
  });
  await ctx.route('https://fake-firebase.test/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-uid, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (url.pathname === '/auth/behaviour') return json(200, { mode: fb.mode, user: fb.user });
    const p = url.pathname.replace(/^\/fs\//, ''), uid = req.headers()['x-uid'] || '';
    fb.calls.push(`${m} ${p}`);
    if (fb.fail === 'offline') return route.abort('internetdisconnected');
    if (fb.fail === 'denied') return json(403, { error: 'PERMISSION_DENIED' });
    const [col, id] = p.split('/');
    // Mirror firebase/firestore.rules.
    if (col === 'users' && uid !== id) return json(403, {});
    if (m === 'GET') return json(200, { exists: !!fb.docs[p], data: fb.docs[p] || null });
    const body = JSON.parse(req.postData());
    if (col === 'shares' && (!/^[0-9a-f]{32}$/.test(id) || body.owner !== uid || (fb.docs[p] && fb.docs[p].owner !== uid) || Object.keys(body).some((k) => !['owner', 'plan', 'summary', 'updatedAt'].includes(k)))) return json(403, {});
    fb.docs[p] = { ...body, updatedAt: new Date().toISOString() };
    fb.writes = (fb.writes || 0) + 1;
    return json(200, {});
  });
}
async function googleDevice(fb, opts = {}) {
  const d = await page(opts);
  await mockFirebase(d.ctx, fb);
  if (opts.gist) await mockGitHub(d.ctx, opts.gist);
  await d.p.goto(GOOGLE);
  return d;
}
function userDoc(fb) { const d = fb.docs['users/uid-brayden']; return d ? JSON.parse(d.payload) : null; }

async function testGoogleSync() {
  console.log('\n[16] Google sign-in sync (Firebase Auth + Firestore mocked)');
  const errStart = errors.length;
  const fb = makeFbStore();
  // Without a Firebase config the app keeps the gist-only screen.
  {
    const { ctx, p } = await page(); await p.goto(GIST); await p.click('#syncBtn');
    ok(await p.locator('#googleSignIn').count() === 0 && await p.locator('#syncToken').count() === 1, 'no Firebase config: Sync screen is the gist screen, no Google button');
    await ctx.close();
  }
  const A = await googleDevice(fb);
  const ch1 = await S(A.p, () => cardsIn('deck-c202-ch01').map((c) => c.id));
  const ch2 = await S(A.p, () => cardsIn('deck-c202-ch02').map((c) => c.id));
  ok(!(await S(A.p, () => !!FB)), 'Firebase SDK is not loaded until sign-in is used');
  await setProg(A.p, ch1.slice(0, 3), 2, true);
  await S(A.p, () => { makePlan('C202', 'speedy', '2026-10-05'); });
  await A.p.click('#syncBtn');
  ok(await A.p.locator('#googleSignIn').count() === 1 && !(await A.p.getAttribute('#gistDetails', 'open') !== null), 'Sync screen offers Sign in with Google; gist option tucked away');
  await hideToast(A.p);
  await A.p.screenshot({ path: `${SHOTS}/sync-google-desktop-signed-out.png`, fullPage: true });
  await A.p.click('#googleSignIn');
  let st = await waitStatus(A.p, /Synced/);
  ok(/Synced/.test(st) && /brayden@example.com/.test(await A.p.textContent('#googleEmail')), 'one click: signed in as brayden@example.com and synced');
  let D = userDoc(fb);
  ok(D && ch1.slice(0, 3).every((id) => D.p[id] && D.p[id][1] === 1), 'users/{uid} doc holds the progress (same payload format as the gist)');
  const share = Object.keys(fb.docs).find((k) => k.startsWith('shares/'));
  ok(share && fb.docs[share].owner === 'uid-brayden' && /study plan/.test(fb.docs[share].plan) && fb.docs[share].plan === await S(A.p, () => planText('C202')), 'shares/{id} mirrors the C202 plan text for Study Buddy');
  const planId = (await A.p.textContent('#planId')).trim();
  ok(planId === 'fs:study-buddy-1000/' + share.split('/')[1], 'Sync screen shows the plan link: ' + planId);
  ok(!JSON.stringify(fb.docs).includes(FAKE_ID_TOKEN), 'no Google token stored in Firestore');

  // Second device (phone), same Google account.
  const B = await googleDevice(fb, { device: 'iPhone 13' });
  await B.p.tap('#syncBtn'); await B.p.tap('#googleSignIn');
  await waitStatus(B.p, /Synced/);
  ok(await S(B.p, (ids) => ids.every((id) => state.progress[id] && state.progress[id].retired), ch1.slice(0, 3)), 'phone gets the desktop progress after one tap');
  ok((await B.p.textContent('#planId')).trim() === planId, 'phone reuses the same plan link');
  await hideToast(B.p);
  await B.p.screenshot({ path: `${SHOTS}/sync-google-phone-signed-in.png`, fullPage: true });

  // Concurrent changes merge.
  await setProg(A.p, [ch2[1]], 1); await setProg(B.p, [ch2[2]], 1);
  await S(B.p, () => { folderById('deck-c202-ch03').guideRead = '2026-10-12'; save(); });
  await syncNowAndWait(A.p); await syncNowAndWait(B.p); await syncNowAndWait(A.p);
  ok(await S(A.p, (id) => state.progress[id].streak === 1 && folderById('deck-c202-ch03').guideRead === '2026-10-12', ch2[2]) && await S(B.p, (id) => state.progress[id].streak === 1, ch2[1]), 'changes on both devices merge both ways');

  // Reload: still signed in, pulls on load.
  await setProg(B.p, [ch2[3]], 1); await syncNowAndWait(B.p);
  await A.p.reload();
  await A.p.waitForFunction((id) => state.progress[id] && state.progress[id].streak === 1, ch2[3], { timeout: 8000 }).catch(() => {});
  ok(await S(A.p, (id) => state.progress[id] && state.progress[id].streak === 1, ch2[3]), 'after a reload the device is still signed in and pulls the latest');

  // Offline and permission problems never lose local data.
  fb.fail = 'offline'; await setProg(A.p, [ch2[4]], 1); await syncNowAndWait(A.p);
  ok(/Offline, will retry/.test(await A.p.textContent('[data-sync-status]')) && (await getProg(A.p, ch2[4])).streak === 1 && await noBroke(A.p), 'offline: status says so, local change kept');
  fb.fail = 'denied'; await syncNowAndWait(A.p);
  ok(/Sign-in problem/.test(await A.p.textContent('[data-sync-status]')) && (await getProg(A.p, ch2[4])).streak === 1, 'permission denied: "Sign-in problem", local data intact');
  fb.fail = null; await syncNowAndWait(A.p);
  ok(userDoc(fb).p[ch2[4]][0] === 1, 'recovered: the offline change reached Firestore');

  // Export and sign-out.
  if (await A.p.locator('#syncBack').count()) await A.p.click('#syncBack');
  const [dl] = await Promise.all([A.p.waitForEvent('download'), A.p.click('#exportBtn')]);
  const exported = fs.readFileSync(await dl.path(), 'utf8');
  ok(!exported.includes(FAKE_ID_TOKEN) && !exported.includes('fakeAuth'), 'Export contains no Google credential');
  await A.p.click('#syncBtn'); await A.p.click('#googleSignOut');
  ok(await A.p.locator('#googleSignIn').count() === 1 && /Not connected/.test(await A.p.textContent('#syncStatus')) && (await getProg(A.p, ch2[4])).streak === 1, 'Sign out: back to the Sign in button, local progress kept');
  await A.ctx.close(); await B.ctx.close();

  // Redirect fallback when popups aren't supported (e.g. some home-screen apps).
  fb.mode = 'popup-unsupported';
  const C = await googleDevice(fb, { device: 'iPhone 13' });
  await C.p.tap('#syncBtn'); await C.p.tap('#googleSignIn');
  await C.p.waitForEvent('load', { timeout: 8000 }).catch(() => {});
  await C.p.waitForFunction(() => SYNC && SYNC.status === 'ok', null, { timeout: 8000 }).catch(() => {});
  ok(await S(C.p, (id) => !!(SYNC.user && state.progress[id] && state.progress[id].retired), ch1[0]), 'popup unsupported: falls back to redirect, comes back signed in and synced');
  await C.ctx.close();
  fb.mode = 'closed';
  const C2 = await googleDevice(fb);
  await C2.p.click('#syncBtn'); await C2.p.click('#googleSignIn'); await C2.p.waitForTimeout(300);
  ok(await C2.p.locator('#googleSignIn').count() === 1 && await noBroke(C2.p), 'closing the Google window just leaves you signed out');
  await C2.ctx.close();
  fb.mode = 'ok';

  // Migration: a device already on gist sync signs in with Google.
  const gist = makeGistStore();
  const G = await googleDevice(fb, { gist });
  await G.p.click('#syncBtn'); await G.p.click('#gistDetails summary');
  await G.p.fill('#syncToken', GOOD_TOKEN); await G.p.click('#syncConnect');
  await waitStatus(G.p, /Synced/);
  const gid = Object.keys(gist.gists)[0];
  // Older phone wrote something to the gist only.
  const R = remotePayload(gist); R.p[ch2[50]] = [1, 0, Date.now()]; gist.gists[gid].files['study-buddy-sync.json'].content = JSON.stringify(R);
  const t0 = Date.now();
  await G.p.click('#googleSignIn');
  await G.p.waitForFunction((t0) => SYNC.user && SYNC.status === 'ok' && !SYNC.busy && SYNC.lastOk > t0, t0, { timeout: 10000 }).catch(() => {});
  ok(userDoc(fb).p[ch2[50]] && userDoc(fb).p[ch2[50]][0] === 1, 'first Google sign-in on a gist device: gist progress merged into Firestore');
  ok(remotePayload(gist).p[ch2[4]] && remotePayload(gist).p[ch2[4]][0] === 1, 'and the gist receives what was only in Firestore');
  ok(gist.gists[gid].files['c202-plan.txt'].content === await S(G.p, () => planText('C202')), 'gist keeps getting c202-plan.txt while its token is connected');
  ok(await G.p.getAttribute('#gistDetails', 'open') !== null && /Still connected/.test(await G.p.textContent('#gistNote')), 'Sync screen shows the gist as still connected');
  await G.ctx.close();

  // Box helper reads the plan link anonymously over the Firestore REST format.
  const http = require('http');
  const sid = planId.split('/')[1];
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization) { res.writeHead(500); return res.end('auth sent'); }
    const ok2 = req.url === `/v1/projects/study-buddy-1000/databases/(default)/documents/shares/${sid}` || req.url === `/v1/projects/study-buddy-1000/databases/%28default%29/documents/shares/${sid}`;
    if (!ok2) { res.writeHead(404); return res.end('{}'); }
    const d = fb.docs['shares/' + sid];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'x', fields: { owner: { stringValue: d.owner }, plan: { stringValue: d.plan }, summary: { stringValue: d.summary }, updatedAt: { timestampValue: d.updatedAt } } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const out = await new Promise((res) => require('child_process').exec(`${ROOT}/tools/read-plan.sh ${planId}`, { env: { ...process.env, FIRESTORE_API_BASE: `http://127.0.0.1:${srv.address().port}` } }, (e, so, se) => res(e ? 'ERR ' + e.message + so + se : so)));
  srv.close();
  ok(/study plan/.test(out) && out.includes(fb.docs['shares/' + sid].plan) && /C202: \d+\/23\d\d cards mastered/.test(out), 'tools/read-plan.sh fs:… prints the plan and progress summary without credentials');

  const noise = /Failed to load resource|net::ERR_|api\.github\.com|fake-firebase/;
  for (let i = errors.length - 1; i >= errStart; i--) if (noise.test(errors[i])) errors.splice(i, 1);
}

/* ---------- Rounds of 20 (study / scenarios / multiple choice) + migration of old saves ---------- */
async function answerQuiz(p, right = true) {
  const idx = await S(p, (r) => view.choices.findIndex((c) => r ? c.correct : !c.correct), right);
  await p.click(`[data-choice="${idx}"]`); await p.click('#nextQuiz');
}
async function testRounds() {
  console.log('\n[17] Rounds of 20, round summary, migration of old (pre-rounds) saves');
  const F = 'deck-c202-ch02';
  let { ctx, p } = await page({ device: 'iPhone 13' });
  await p.goto(GIST); await hideToast(p);
  // A realistic old state: progress mid-chapter, a best quiz score, and pre-rounds saves in every slot style.
  const old = await S(p, (F) => {
    const st = JSON.parse(localStorage.getItem('flashcards.v1'));
    const all = cardsIn(F), con = all.filter((c) => !isScenario(c)), scn = all.filter(isScenario);
    con.slice(0, 12).forEach((c) => { st.progress[c.id] = { streak: 2, retired: true }; });
    con.slice(12, 20).forEach((c) => { st.progress[c.id] = { streak: 1, retired: false }; });
    con.slice(20, 23).forEach((c) => { st.progress[c.id] = { streak: 0, retired: false }; });
    scn.slice(0, 3).forEach((c) => { st.progress[c.id] = { streak: 3, retired: false }; }); // old rule leftovers: streak>=2 counts as retired
    const f = st.folders.find((x) => x.id === F); f.quizBest = 65; f.conceptPass = null;
    const activeCon = con.slice(12).map((c) => c.id);
    st.sessions = st.sessions || {};
    st.sessions[F + ':study-concept'] = { studyMode: 'concept', queue: activeCon, index: 5, flipped: true, studyPicked: null, studyTargets: activeCon, studySeen: activeCon.slice(0, 5), roundTotal: activeCon.length + 5, roundPos: 6, savedAt: Date.now() - 86400000 };
    const sq = scn.slice(3).map((c) => c.id);
    st.sessions[F + ':study'] = { studyMode: 'scenario', queue: sq, index: 2, flipped: false, studyPicked: (scn[5].correct + 1) % scn[5].choices.length, studyTargets: [], studySeen: [], roundTotal: sq.length, roundPos: 3, savedAt: Date.now() - 3600000 };
    const qids = all.map((c) => c.id);
    st.sessions[F + ':quiz'] = { queue: qids, index: 30, score: 25, asked: 30, run: 2, missed: qids.slice(0, 5), choices: [], picked: null, quizTotal: qids.length, quizSource: qids, quizFull: true, quizFolder: F, quizKind: 'full', savedAt: Date.now() - 7200000 };
    localStorage.setItem('flashcards.v1', JSON.stringify(st));
    return { total: all.length, con: con.length, scn: scn.length, current: activeCon[5], scen: sq[2], prog: st.progress, activeCon };
  }, F);
  await p.reload(); await hideToast(p);
  ok(old.con > 40 && old.scn >= 6, `chapter 2 is big enough for several rounds (${old.con} concept, ${old.scn} scenarios)`);
  const after = await S(p, () => state.progress);
  ok(Object.keys(old.prog).every((id) => after[id] && after[id].streak === old.prog[id].streak && (after[id].retired === (old.prog[id].retired || old.prog[id].streak >= 2))), 'every old streak / retired flag is kept on load');
  ok(await S(p, (F) => folderById(F).quizBest === 65 && !!state.sessions[F + ':study-scenario'] && !state.sessions[F + ':study'] && !!state.sessions[F + ':quiz'] && !!state.sessions[F + ':study-concept'], F), 'quizBest and all old saves survive (shared "study" slot moved to study-scenario)');
  await p.click(`[data-open="${F}"]`); await skipVis(p);
  ok(/Card 1 of 20/.test(await p.textContent('[data-resume="study-concept"]')), 'old concept save is offered as a round: "Card 1 of 20"');
  ok(/Round 2: question 1 of 20 · 30 of/.test(await p.textContent('[data-resume="quiz"]')), 'old quiz save shows its place: ' + await p.textContent('[data-resume="quiz"]'));

  // --- old concept save resumes on the same revealed card, as a round of 20
  await p.click('[data-resume="study-concept"]');
  let st = await S(p, () => ({ id: view.queue[view.index], flipped: view.flipped, total: view.roundTotal, q: view.queue.slice(), active: view.queue.every((id) => !prog(id).retired) }));
  ok(st.id === old.current && st.flipped && st.total === 20 && st.q.length === 20 && st.active, 'old concept save resumes on the same (revealed) card in a round of 20 active cards');
  ok((await p.textContent('#roundCounter')).trim() === 'Card 1 of 20' && /left to master/.test(await p.textContent('.study-wrap')), 'counter "Card 1 of 20" and remaining-to-master shown');
  await p.click('#gotBtn');
  const missedR1 = [];
  for (let i = 1; i < 20; i++) {
    if (i === 4) { await p.click('#exitStudy'); await p.click('[data-resume="study-concept"]'); ok((await p.textContent('#roundCounter')).trim() === 'Card 5 of 20', 'Save & leave mid-round resumes at Card 5 of 20'); }
    const right = i % 5 !== 0;
    if (!right) missedR1.push(await S(p, () => view.queue[view.index]));
    if (i === 7) { await p.click('#knowBtn'); continue; }
    await answerCard(p, right);
  }
  ok(await p.locator('#roundSummary').count() === 1, 'after 20 cards the round summary shows');
  ok((await p.textContent('#roundScore')).trim() === '17 / 20', 'score screen shows X / 20 (17 / 20, "I know this" counts as right): ' + await p.textContent('#roundScore'));
  ok(/\d+ concept cards left to master/.test(await p.textContent('#roundLeft')) && /Next 20/.test(await p.textContent('#nextRound')) && /Back to chapter/.test(await p.textContent('#backChapter')), 'summary shows remaining-to-master, "Next 20" and "Back to chapter"');
  ok(await S(p, (F) => !state.sessions[F + ':study-concept'], F), 'a finished round leaves no stale save');
  await hideToast(p); await p.screenshot({ path: `${SHOTS}/round-summary-concept-phone.png`, fullPage: true });
  await p.click('#nextRound');
  st = await S(p, () => ({ q: view.queue.slice(), no: view.roundNo, active: view.queue.every((id) => !prog(id).retired) }));
  ok(st.no === 2 && st.q.length === 20 && st.active && missedR1.every((id) => st.q.includes(id)), `round 2 has 20 unmastered cards and mixes in the ${missedR1.length} just-missed ones`);
  ok(await S(p, () => view.queue.filter((id) => prog(id).missedAt).length) <= 6, 'only a few missed cards are mixed in');
  await p.click('#exitStudy');

  // --- old scenario save (from the shared "study" slot): answered-but-not-advanced scenario is kept
  await p.click('[data-resume="study-scenario"]');
  st = await S(p, () => ({ id: view.queue[view.index], picked: view.studyPicked, total: view.roundTotal }));
  ok(st.id === old.scen && st.picked !== null && st.total === Math.min(20, old.scn - 3) && await p.locator('#explainBox').count() === 1, 'old scenario save resumes on the answered scenario with its feedback');
  await p.click('#nextStudy');
  ok(/Card 2 of/.test(await p.textContent('#roundCounter')), 'scenario rounds count "Card N of M"');
  await p.click('#exitStudy');

  // --- old quiz save continues as rounds; totals carry over
  await p.click('[data-resume="quiz"]');
  ok((await p.textContent('#roundCounter')).trim() === 'Question 1 of 20' && await S(p, () => view.asked === 30 && view.score === 25 && view.index === 30), 'old quiz save resumes at question 31 as "Question 1 of 20" with its 25/30 kept');
  for (let i = 0; i < 20; i++) await answerQuiz(p, i !== 3);
  ok((await p.textContent('#roundScore')).trim() === '19 / 20' && /50 of \d+ answered/.test(await p.textContent('#roundSummary')), 'quiz round summary: 19 / 20 and chapter progress');
  await hideToast(p); await p.screenshot({ path: `${SHOTS}/round-summary-quiz-phone.png`, fullPage: true });
  await p.click('#backChapter');
  ok(/Round 2 done/.test(await p.textContent('[data-resume="quiz"]')), 'Back to chapter keeps the chapter quiz: "Round 2 done · ..."');
  ok(await S(p, (F) => folderById(F).quizBest === 65, F), 'quizBest untouched until the whole chapter has been answered');
  await p.click('[data-resume="quiz"]');
  ok((await p.textContent('#roundCounter')).trim() === 'Question 1 of 20' && await S(p, () => view.roundNo === 3 && view.index === 50), 'resuming between rounds starts round 3');
  while (!(await p.locator('#roundSummary').count()) || await p.locator('#nextRound').count()) {
    if (await p.locator('#nextRound').count()) await p.click('#nextRound');
    await answerQuiz(p, true);
  }
  const fin = await S(p, (F) => ({ best: folderById(F).quizBest, score: view.score, asked: view.asked, total: view.quizTotal }), F);
  ok(fin.asked === fin.total && fin.best === Math.round(fin.score / fin.asked * 100) && /Chapter quiz complete/.test(await p.textContent('#roundSummary')), `full pass done: quizBest is cumulative chapter accuracy (${fin.score}/${fin.asked} = ${fin.best}%)`);
  ok(await S(p, (F) => !state.sessions[F + ':quiz'], F), 'completed chapter quiz clears its save');
  await p.click('#backChapter');

  // --- a fresh full quiz: rounds of 20, unmastered first
  await p.click('#quizBtn'); await skipVis(p);
  const r1 = await S(p, () => ({ end: view.roundEnd, ids: view.queue.slice(0, 20) }));
  ok(r1.end === 20 && (await p.textContent('#roundCounter')).trim() === 'Question 1 of 20', 'new full quiz: first round is 20 questions');
  ok(await S(p, (ids) => ids.filter((id) => prog(id).retired).length, r1.ids) === 0, 'round 1 of the chapter quiz pulls unmastered cards first');
  await p.click('#exitStudy');
  // Quick quiz and boss stay as they were
  await p.click('#quickBtn'); await skipVis(p);
  ok((await p.textContent('#roundCounter')).trim() === 'Question 1 of 10' && await S(p, () => view.roundEnd === view.quizTotal), 'Quick quiz is unchanged (10 questions, one go)');
  await p.click('#exitStudy');
  await p.click('#bossBtn'); await skipVis(p);
  ok(await S(p, (F) => view.boss.ids.length === cardsIn(F).length, F), 'Boss quiz is still the full chapter');
  await p.click('#exitBoss');
  ok(await noBroke(p), 'app fine');
  await ctx.close();

  // --- sync: round saves + an old-format save from an old device merge and resume fine
  const store = makeGistStore();
  const A = await syncDevice({ store }), B = await syncDevice({ store, device: 'iPhone 13' });
  for (const d of [A, B]) { await d.p.click('#syncBtn'); await d.p.fill('#syncToken', GOOD_TOKEN); await d.p.click('#syncConnect'); await waitStatus(d.p, /Synced/); await d.p.click('#syncBack'); }
  await A.p.click(`[data-open="${F}"]`); await skipVis(A.p); await A.p.click('#conceptBtn'); await skipVis(A.p);
  await answerCard(A.p, false); await answerCard(A.p, true); await answerCard(A.p, true);
  const missA = await S(A.p, () => view.queue[0]);
  await A.p.click('#exitStudy');
  // B behaves like an old device: writes a pre-rounds quiz save.
  await S(B.p, (F) => { const ids = cardsIn(F).map((c) => c.id); state.sessions[F + ':quiz'] = { queue: ids, index: 7, score: 6, asked: 7, run: 1, missed: [], choices: [], picked: null, quizTotal: ids.length, quizSource: ids, quizFull: true, quizFolder: F, quizKind: 'full', savedAt: Date.now() }; save(); }, F);
  await syncNowAndWait(B.p); await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  ok(await S(B.p, (F) => { const s = state.sessions[F + ':study-concept']; return !!s && s.rounds === 1 && s.index === 3 && s.roundTotal === 20; }, F), 'a round save syncs to the other device');
  ok(await S(A.p, (id) => state.progress[id].streak === 0 && prog(id).missedAt > 0, missA), 'progress syncs and the local missed hint survives a pull');
  await B.p.click(`[data-open="${F}"]`); await skipVis(B.p); await B.p.click('[data-resume="study-concept"]');
  ok((await B.p.textContent('#roundCounter')).trim() === 'Card 4 of 20', 'the other device resumes the synced round at Card 4 of 20');
  await B.p.click('#exitStudy');
  await A.p.click('#backHome'); await A.p.click(`[data-open="${F}"]`); await skipVis(A.p); await A.p.click('[data-resume="quiz"]');
  ok((await A.p.textContent('#roundCounter')).trim() === 'Question 1 of 20' && await S(A.p, () => view.index === 7 && view.score === 6), "an old device's synced quiz save resumes as rounds");
  await A.ctx.close(); await B.ctx.close();
}

/* ---------- Shuffled answer order on every multiple-choice surface ---------- */
async function shownSpick(p) { return p.$$eval('[data-spick]', (bs) => bs.map((b) => Number(b.dataset.spick))); }
async function testShuffle() {
  console.log('\n[18] Answer order is shuffled per presentation; "of the above" stays last; resume keeps the order');
  const F = 'deck-c202-ch02';
  const { ctx, p } = await page();
  await p.goto(GIST); await hideToast(p);
  const r = await S(p, (F) => {
    const sc = cardsIn(F).filter(isScenario), co = cardsIn(F).filter((c) => !isScenario(c));
    const orders = new Set(); let okMap = true;
    sc.slice(0, 10).forEach((c) => { for (let k = 0; k < 15; k++) { const ch = makeChoices(c); orders.add(c.id + ':' + ch.map((x) => x.text).join('|')); const right = ch.filter((x) => x.correct); okMap = okMap && ch.length === c.choices.length && right.length === 1 && right[0].text === c.choices[c.correct]; } });
    let cOk = true, cOrders = new Set();
    co.slice(0, 5).forEach((c) => { for (let k = 0; k < 15; k++) { const ch = makeChoices(c); cOrders.add(c.id + ':' + ch.findIndex((x) => x.correct)); cOk = cOk && ch.filter((x) => x.correct).length === 1 && ch.find((x) => x.correct).text === cardAnswerText(c); } });
    const fake = { id: 'fake', type: 'scenario', choices: ['Fire them', 'None of the above', 'Retrain them', 'Promote them'], correct: 1 };
    const fake2 = { id: 'fake2', type: 'scenario', choices: ['All of the above', 'Pay', 'Benefits', 'Training'], correct: 0 };
    let pinOk = true, mixed = new Set();
    for (let k = 0; k < 30; k++) {
      const a = makeChoices(fake), b = makeChoices(fake2);
      pinOk = pinOk && a[3].text === 'None of the above' && a[3].correct && a.filter((x) => x.correct).length === 1 && b[3].text === 'All of the above' && b[3].correct;
      mixed.add(a.slice(0, 3).map((x) => x.text).join('|'));
    }
    const order = orderChoices([{ text: 'x' }, { text: 'All of these' }, { text: 'y' }, { text: 'z' }], (c) => c.text);
    return { scen: sc.length, distinct: orders.size, okMap, cOk, cSpread: new Set([...cOrders].map((s) => s.split(':')[1])).size, pinOk, mixed: mixed.size, concept: order[3].text === 'All of these',
      bothKept: !pinsLast('Both employees and employers') && !pinsLast('Neither') && pinsLast('Both of the above') && pinsLast('none of these') };
  }, F);
  ok(r.okMap && r.distinct > 10 + 5, `scenario choices (quiz / quick / boss / practice) are shuffled and the correct one is remapped (${r.distinct} orders over 10 cards)`);
  ok(r.cOk && r.cSpread >= 3, `concept-card choices stay shuffled, correct answer lands in ${r.cSpread} different positions`);
  ok(r.pinOk && r.mixed > 1 && r.concept, '"None/All of the above"-style choices stay last (and keep the right answer) while the rest shuffle');
  ok(r.bothKept, 'plain "Both …" / "Neither" answers shuffle normally; only "… of the above/these" pins');

  // Scenario study: shown order is shuffled, clicks map to the right choice, feedback names the right answer
  await p.click(`[data-open="${F}"]`); await skipVis(p);
  await p.click('#scenarioBtn'); await skipVis(p);
  let nonId = 0, feedOk = true;
  for (let i = 0; i < 8; i++) {
    const order = await shownSpick(p);
    if (order.some((v, k) => v !== k)) nonId++;
    const c = await S(p, () => { const c = state.cards.find((x) => x.id === view.queue[view.index]); return { correct: c.correct, text: c.choices[c.correct], n: c.choices.length }; });
    const pickWrong = i % 2 === 1;
    const pick = pickWrong ? (c.correct + 1) % c.n : c.correct;
    await p.click(`[data-spick="${pick}"]`);
    const fb = await p.textContent('#explainBox');
    const greenText = (await p.textContent('.choice.correct')).replace(/\s*\((\d|Enter)\)\s*$/, '').trim();
    feedOk = feedOk && greenText === c.text.trim() && (pickWrong ? /Not quite/.test(fb) && fb.includes(c.text.slice(0, 40)) : /Correct/.test(fb));
    if (i === 3) {
      // answered + saved: same shown order after Save & leave and after a reload
      const before = await shownSpick(p);
      await p.click('#exitStudy'); await p.reload(); await p.click(`[data-open="${F}"]`); await skipVis(p); await p.click('[data-resume="study-scenario"]');
      ok(JSON.stringify(await shownSpick(p)) === JSON.stringify(before) && await p.locator('#explainBox').count() === 1, 'an answered scenario keeps its shown order through Save & leave and reload');
    }
    await p.click('#nextStudy');
  }
  ok(nonId >= 4, `scenario study shows shuffled orders (${nonId} of 8 not in authored order)`);
  ok(feedOk, 'the highlighted correct choice and the "Best answer" feedback always match the card');
  const unanswered = await shownSpick(p);
  await p.click('#exitStudy'); await p.click('[data-resume="study-scenario"]');
  ok(JSON.stringify(await shownSpick(p)) === JSON.stringify(unanswered), 'an unanswered scenario keeps its shown order on resume');
  await p.click('#exitStudy');

  // Quiz, quick, boss: the saved question keeps its shown order
  for (const [btn, slot, sel] of [['#quizBtn', 'quiz', '[data-choice]'], ['#quickBtn', 'quick', '[data-choice]'], ['#bossBtn', 'boss', '[data-bpick]']]) {
    p.dialogAnswers.push(true);
    await p.click(btn); await skipVis(p);
    const before = await p.$$eval(sel, (bs) => bs.map((b) => b.textContent.trim()));
    await p.click(slot === 'boss' ? '#exitBoss' : '#exitStudy');
    await p.reload(); await p.click(`[data-open="${F}"]`); await skipVis(p);
    await p.click(`[data-resume="${slot}"]`);
    const after = await p.$$eval(sel, (bs) => bs.map((b) => b.textContent.trim()));
    ok(before.length >= 2 && JSON.stringify(before) === JSON.stringify(after), `${slot}: a resumed question shows the same answer order`);
    await p.click(slot === 'boss' ? '#exitBoss' : '#exitStudy');
  }
  // Boss review and practice-missed point at the right answers
  p.dialogAnswers.push(true);
  await p.click('#bossBtn'); await skipVis(p);
  await answerBoss(p, () => false);
  const rev = await S(p, () => view.boss.answers.every((a) => { const c = state.cards.find((x) => x.id === a.id); const right = a.choices.find((x) => x.correct); return right && right.text === (isScenario(c) ? c.choices[c.correct] : cardAnswerText(c)); }));
  ok(rev, 'boss review: every "correct answer" matches its card');
  await p.click('#bossPractice');
  let pmOk = true;
  for (let i = 0; i < 6; i++) {
    const c = await S(p, () => { const c = currentCard(); const right = view.choices.find((x) => x.correct); return right && right.text === (isScenario(c) ? c.choices[c.correct] : cardAnswerText(c)); });
    pmOk = pmOk && c;
    await answerQuiz(p, true);
  }
  ok(pmOk && await S(p, () => view.quizKind === 'practice'), 'practice-missed questions are shuffled with the right answer marked');
  await p.click('#exitStudy');

  // Old save (before shuffling): an answered scenario keeps the authored order it was shown in
  const sc = await S(p, (F) => { const c = cardsIn(F).filter(isScenario)[0]; const st = JSON.parse(localStorage.getItem('flashcards.v1')); st.sessions[F + ':study-scenario'] = { studyMode: 'scenario', queue: [c.id], index: 0, flipped: false, studyPicked: c.correct, studyTargets: [], studySeen: [], roundTotal: 1, roundPos: 1, savedAt: Date.now() }; localStorage.setItem('flashcards.v1', JSON.stringify(st)); return { n: c.choices.length, text: c.choices[c.correct] }; }, F);
  await p.reload(); await p.click(`[data-open="${F}"]`); await skipVis(p); await p.click('[data-resume="study-scenario"]');
  ok(JSON.stringify(await shownSpick(p)) === JSON.stringify([...Array(sc.n).keys()]) && (await p.textContent('.choice.correct')).replace(/\s*\((\d|Enter)\)\s*$/, '').trim() === sc.text.trim(), 'an old answered scenario save resumes in its original order with the right answer highlighted');
  await p.click('#exitStudy');
  ok(await noBroke(p), 'app fine');
  await ctx.close();
}

/* ---------- Weak-area tracking ---------- */
async function attemptsOf(p, id) { return S(p, (id) => (state.attempts || {})[id] || null, id); }
async function testWeakSpots() {
  console.log('\n[19] Weak spots: attempts per card, per-section aggregation, review rounds, sync, export, plan text');
  const F = 'deck-c202-ch02';
  let { ctx, p } = await page({ device: 'iPhone 13' });
  await p.goto(GIST); await hideToast(p);
  // Old state (before attempts existed): streaks, a missedAt, a retired card
  const ids = await S(p, (F) => {
    const st = JSON.parse(localStorage.getItem('flashcards.v1'));
    const con = cardsIn(F).filter((c) => !isScenario(c)).map((c) => c.id);
    delete st.attempts;
    st.progress[con[0]] = { streak: 2, retired: true };
    st.progress[con[1]] = { streak: 0, retired: false, missedAt: 1760000000000 };
    st.progress[con[2]] = { streak: 1, retired: false };
    localStorage.setItem('flashcards.v1', JSON.stringify(st));
    return con;
  }, F);
  await p.reload(); await hideToast(p);
  const bf = await S(p, (ids) => ({ a: ids.slice(0, 4).map((id) => state.attempts[id] || null), p: ids.slice(0, 3).map((id) => state.progress[id]) }), ids);
  ok(JSON.stringify(bf.a) === JSON.stringify([[2, 0, 0, '11'], [0, 1, 0, '0'], [1, 0, 0, '1'], null]), 'backfill from old progress: streak -> recent rights, missedAt -> one miss, timestamp 0 ' + JSON.stringify(bf.a));
  ok(bf.p[0].retired && bf.p[0].streak === 2 && bf.p[1].missedAt === 1760000000000 && bf.p[2].streak === 1, 'existing progress is untouched by the backfill');

  // Section keys and coverage
  const sec = await S(p, () => ({
    multi: cardSection({ note: 'Read more: 2.4 Why culture matters; 2.5 Culture and HRM' }),
    plain: cardSection({ note: 'Read more - 3.1 Intro.' }), none: cardSection({ note: '' }), odd: cardSection({ note: 'See the textbook' }),
    c202: state.cards.filter((c) => /^deck-c202/.test(c.folderId)).length,
    general: state.cards.filter((c) => /^deck-c202/.test(c.folderId) && cardSection(c) === 'General').length
  }));
  ok(sec.multi === '2.4 Why culture matters' && sec.plain === '3.1 Intro' && sec.none === 'General' && sec.odd === 'General', 'section key: first "Read more" section, else General');
  ok(sec.c202 > 2000 && sec.general === 0, `every bundled C202 card has a usable section (${sec.c202} cards, ${sec.general} fall back to General)`);

  // Every surface records attempts
  await p.click(`[data-open="${F}"]`); await skipVis(p);
  await p.click('#conceptBtn'); await skipVis(p);
  let id = await S(p, () => view.queue[view.index]); let before = await attemptsOf(p, id);
  await answerCard(p, false);
  let a = await attemptsOf(p, id);
  ok(a && a[1] === ((before && before[1]) || 0) + 1 && a[3].endsWith('0') && a[2] > 0, 'concept study records a miss');
  await p.click('#exitStudy');
  await p.click('#scenarioBtn'); await skipVis(p);
  id = await S(p, () => view.queue[view.index]); await answerCard(p, true);
  a = await attemptsOf(p, id); ok(a && a[0] === 1 && a[3] === '1', 'scenario study records a right answer');
  await p.click('#exitStudy');
  for (const [btn, label] of [['#quizBtn', 'multiple choice'], ['#quickBtn', 'quick quiz']]) {
    p.dialogAnswers.push(true);
    await p.click(btn); await skipVis(p);
    id = await S(p, () => currentCard().id); before = await attemptsOf(p, id);
    await answerQuiz(p, false);
    a = await attemptsOf(p, id); ok(a && a[1] === ((before && before[1]) || 0) + 1, `${label} records attempts`);
    await p.click('#exitStudy');
  }
  p.dialogAnswers.push(true);
  await p.click('#bossBtn'); await skipVis(p);
  const bossIds = await S(p, () => view.boss.ids.slice());
  const tot0 = await S(p, (ids) => ids.reduce((n, id) => { const a = (state.attempts || {})[id]; return n + (a ? a[0] + a[1] : 0); }, 0), bossIds);
  await answerBoss(p, (i) => i % 4 !== 0);
  const tot1 = await S(p, (ids) => ids.reduce((n, id) => { const a = (state.attempts || {})[id]; return n + (a ? a[0] + a[1] : 0); }, 0), bossIds);
  ok(tot1 - tot0 === bossIds.length, `boss records one attempt per question (${tot1 - tot0})`);
  await p.click('#bossPractice');
  id = await S(p, () => currentCard().id); before = await attemptsOf(p, id);
  await answerQuiz(p, true);
  a = await attemptsOf(p, id); ok(a && a[0] === before[0] + 1, 'practice-missed records attempts');
  await p.click('#exitStudy');

  // Thresholds: start clean, then build a weak section
  const S1 = await S(p, (F) => {
    state.attempts = {}; save();
    const st = sectionStats(F).filter((s) => s.cards.length >= 4).sort((a, b) => b.cards.length - a.cards.length);
    return { name: st[0].section, cards: st[0].cards, other: st[1].section, ocards: st[1].cards };
  }, F);
  await S(p, (c) => { recordAttempt(c[0], false); c.slice(1, 4).forEach((id) => recordAttempt(id, true)); recordAttempt(c[1], true); recordAttempt(c[2], true); save(); }, S1.cards);
  ok(await S(p, (F) => weakSections(F).length, F) === 0, 'one miss in 6 tries does not flag a section');
  await S(p, (c) => { recordAttempt(c[0], false); recordAttempt(c[1], false); recordAttempt(c[3], false); save(); }, S1.cards);
  await S(p, (c) => { c.forEach((id) => recordAttempt(id, false)); c.forEach((id) => recordAttempt(id, true)); save(); }, S1.ocards.slice(0, 2));
  const w = await S(p, (F) => weakSections(F).map((s) => [s.section, s.miss, s.n]), F);
  ok(w.length >= 1 && w[0][0] === S1.name && w[0][1] === 4 && w[0][2] === 9, 'a section with 4 of 9 recent tries missed is flagged first: ' + JSON.stringify(w));
  ok(!w.some((x) => x[0] === S1.other), 'a section at 50% missed but only 4 tries stays unflagged (minimum attempts)');
  await p.click('#backHome'); await p.click(`[data-open="${F}"]`); await skipVis(p);
  const panel = await p.textContent('#weakPanel');
  ok(/Weak spots/.test(panel) && panel.includes(S1.name) && /44% missed · 4 of 9 recent tries · \d+ cards/.test(panel), 'folder screen shows the Weak spots panel with miss rate, tries and cards');
  ok(await p.locator('#weakPanel [data-review]').count() >= 1 && await p.locator('#weakPanel [data-wguide]').count() >= 1, 'each weak section has Review this and a study-guide link');
  await hideToast(p);
  await p.locator('#weakPanel').scrollIntoViewIfNeeded();
  await p.locator('#weakPanel').screenshot({ path: `${SHOTS}/weak-spots-panel-phone.png` });
  await p.screenshot({ path: `${SHOTS}/weak-spots-folder-phone.png`, fullPage: true });

  // Guide link jumps to the section heading
  await p.click(`#weakPanel [data-wguide="${S1.name}"]`);
  ok(await S(p, () => view.page === 'guide') && await p.locator('#guideArticle .flash-target').count() === 1 && await S(p, () => { const r = document.querySelector('#guideArticle .flash-target').getBoundingClientRect(); return r.top >= -5 && r.top < innerHeight; }), 'study-guide link opens the guide at that section heading');
  await p.click('#guideBack');

  // Review this: a round from that section, missed first; save/resume works
  await p.click(`#weakPanel [data-review="${S1.name}"]`); await skipVis(p);
  const rv = await S(p, () => ({ mode: view.studyMode, q: view.queue.slice(), total: view.roundTotal, sec: view.reviewSection, all: studyPool(view.folderId, 'review').map((c) => c.id) }));
  ok(rv.mode === 'review' && rv.sec === S1.name && rv.total === Math.min(20, rv.all.length) && rv.q.every((id) => rv.all.includes(id)), `Review this starts a round of ${rv.total} from that section only`);
  ok(rv.q.slice(0, 3).sort().join() === [S1.cards[0], S1.cards[1], S1.cards[3]].sort().join(), 'recently missed cards come first');
  ok(/Card 1 of/.test(await p.textContent('#roundCounter')) && /Weak-spot review/.test(await p.textContent('#headerSub')), 'review shows the round counter and its name');
  await answerCard(p, true);
  await p.click('#exitStudy');
  ok(/Continue weak-spot review/.test(await p.textContent('#resumeRow')) && /Card 2 of/.test(await p.textContent('[data-resume="study-review"]')), 'review saves into its own slot');
  await p.click('[data-resume="study-review"]');
  ok(await S(p, (n) => view.studyMode === 'review' && view.reviewSection === n && view.index === 1, S1.name), 'review resumes in its section');
  while (!(await p.locator('#roundSummary').count())) await answerCard(p, true);
  ok(/Review again/.test(await p.textContent('#nextRound')) && /no longer flagged|still a weak spot/.test(await p.textContent('#reviewState')), 'review summary says whether the section is still weak');
  await p.click('#backChapter');
  // Improvement clears the flag (recent window)
  await S(p, (c) => { for (let k = 0; k < 8; k++) c.forEach((id) => recordAttempt(id, true)); save(); render(); }, S1.cards);
  ok(!(await S(p, ([F, n]) => weakSections(F).some((s) => s.section === n), [F, S1.name])) && await S(p, (c) => state.attempts[c[0]][1] >= 2, S1.cards), 'answering right 8 times clears the flag; lifetime misses are kept');
  await S(p, (c) => { c.forEach((id) => { recordAttempt(id, false); recordAttempt(id, false); recordAttempt(id, false); }); save(); }, S1.cards);

  // Home badge
  await p.click('#backHome');
  ok(/Weak spot/.test(await p.textContent(`[data-open="${F}"] .weak-badge`)) && await p.locator('[data-open="deck-c202-ch03"] .weak-badge').count() === 0, 'home flags only the chapter with a weak section');

  // Plan text + share summary
  await p.click('#planBtn'); await p.click('#savePlan'); await hideToast(p); await p.click('#planBack');
  const share = await S(p, () => ({ plan: planText(SYNC_PLAN_COURSE), sum: syncSummary() }));
  const ch2 = share.sum.courses.C202 ? share.sum.courses.C202.find((x) => x.ch === 2) : Object.values(share.sum.courses).flat().find((x) => x.ch === 2);
  ok(/Weak spots \(last 8 tries per card/.test(share.plan) && share.plan.includes('Ch 2   ' + S1.name), 'plan text (c202-plan.txt / share doc) lists weakest sections');
  ok(ch2 && ch2.weak.length >= 1 && ch2.weak[0].section === S1.name && ch2.weak[0].missRate > 30, 'share summary carries weak sections per chapter');

  // Export includes attempts
  const [dl] = await Promise.all([p.waitForEvent('download'), S(p, () => exportData())]);
  const exp = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(exp.attempts && Array.isArray(exp.attempts[S1.cards[0]]) && exp.attempts[S1.cards[0]].length === 4, 'Export includes attempts');

  // Merge rules
  const mg = await S(p, () => {
    const L = { a: { x: [3, 1, 100, '1101'], y: [1, 0, 5, '1'] } }, R = { a: { x: [5, 0, 50, '11'], z: [0, 2, 9, '00'] } };
    const M1 = mergeSyncPayloads(L, R), M2 = mergeSyncPayloads(M1, R), M3 = mergeSyncPayloads(M1, M1), old = mergeSyncPayloads({ p: {} }, L);
    return { m: M1.a, again: JSON.stringify(M2.a) === JSON.stringify(M1.a) && JSON.stringify(M3.a) === JSON.stringify(M1.a), old: JSON.stringify(old.a) === JSON.stringify(L.a) };
  });
  ok(JSON.stringify(mg.m) === JSON.stringify({ x: [5, 1, 100, '1101'], y: [1, 0, 5, '1'], z: [0, 2, 9, '00'] }), 'merge: counts keep the max, recent window from the latest attempt');
  ok(mg.again && mg.old, 'merging again never double counts; payloads from older app versions (no attempts) merge fine');
  await ctx.close();

  // Two devices over gist sync
  const store = makeGistStore();
  const A = await syncDevice({ store }), B = await syncDevice({ store, device: 'iPhone 13' });
  for (const d of [A, B]) { await d.p.click('#syncBtn'); await d.p.fill('#syncToken', GOOD_TOKEN); await d.p.click('#syncConnect'); await waitStatus(d.p, /Synced/); await d.p.click('#syncBack'); }
  const cid = await S(A.p, (F) => cardsIn(F)[0].id, F);
  await S(A.p, (id) => { recordAttempt(id, false); recordAttempt(id, false); recordAttempt(id, true); save(); }, cid);
  await syncNowAndWait(A.p); await syncNowAndWait(B.p);
  ok(JSON.stringify((await attemptsOf(B.p, cid)).slice(0, 2)) === '[1,2]', 'attempts sync to the other device');
  await S(B.p, (id) => { recordAttempt(id, true); save(); }, cid);
  await syncNowAndWait(B.p); await syncNowAndWait(A.p); await syncNowAndWait(B.p); await syncNowAndWait(A.p);
  const aA = await attemptsOf(A.p, cid), aB = await attemptsOf(B.p, cid);
  ok(JSON.stringify(aA) === JSON.stringify(aB) && aA[0] === 2 && aA[1] === 2 && aA[3] === '0011', 'repeated syncs converge without double counting (2 right, 2 wrong, "0011")');
  await A.ctx.close(); await B.ctx.close();
}

/* ---------- Number-key shortcuts ---------- */
async function kn(p, sel) { return S(p, (sel) => { const el = document.querySelector(sel); const k = el && el.querySelector(':scope > .kn'); return k ? { t: k.textContent, shown: getComputedStyle(k).display !== 'none', aria: el.getAttribute('aria-keyshortcuts') } : null; }, sel); }
async function press(p, key) { await p.keyboard.press(key); await p.waitForTimeout(30); }
async function testKeys() {
  console.log('\n[20] Number-key shortcuts (desktop), Enter flips, custom confirm dialog');
  const F = 'deck-c202-ch02';
  const { ctx, p } = await page({ manualDialogs: true });
  await p.goto(GIST); await hideToast(p);
  const home = await kn(p, '[data-open]');
  ok(home && home.t === '(1)' && home.shown && home.aria === '1', 'home: chapter cards are numbered (1)..(9) with aria-keyshortcuts');
  await p.click(`[data-open="${F}"]`);
  ok(await p.locator('#confirmDlg').count() === 1 && /locked/.test(await p.textContent('#confirmDlg')), 'locked chapter asks in the custom dialog');
  await press(p, '1');
  const grid = await S(p, () => Array.from(document.querySelectorAll('.mode-grid button')).map((b) => [b.id, (b.querySelector('.kn') || {}).textContent]));
  ok(JSON.stringify(grid) === JSON.stringify([['studyBtn', '(1)'], ['conceptBtn', '(2)'], ['scenarioBtn', '(3)'], ['quizBtn', '(4)'], ['quickBtn', '(5)'], ['matchBtn', '(6)'], ['bossBtn', '(7)']]), 'chapter screen: modes are 1 Study shuffled … 7 Boss');
  await press(p, '2');
  ok(await p.locator('#ovSkip').count() === 1 && (await kn(p, '#ovSkip')).t === '(1)' && (await kn(p, '#ovGo')).t === '(2)', 'custom dialogs number their buttons in order');
  await press(p, '1');
  ok(await S(p, () => view.page === 'study' && view.studyMode === 'concept'), 'keys: 2 starts concept cards, 1 skips the guide prompt');
  // Study card: Enter flips, 1 missed, 2 got it, 3 I know this; Space does nothing
  ok((await kn(p, '#flipBtn')).t === '(Enter)' && (await kn(p, '#flipBtn')).aria === 'Enter' && (await kn(p, '#missBtn')).t === '(1)' && (await kn(p, '#gotBtn')).t === '(2)' && (await kn(p, '#knowBtn')).t === '(3)', 'study card: (Enter) flip, (1) Missed it, (2) Got it, (3) I know this');
  await hideToast(p); await p.screenshot({ path: `${SHOTS}/keys-study-desktop.png` });
  await press(p, ' ');
  ok(!(await S(p, () => view.flipped)), 'Space does not flip');
  await press(p, '2');
  ok(!(await S(p, () => view.flipped)) && await S(p, () => view.index) === 0, 'grading keys do nothing before the answer is shown (disabled)');
  await press(p, 'Enter');
  ok(await S(p, () => view.flipped), 'Enter flips the card');
  await press(p, 'Enter');
  ok(!(await S(p, () => view.flipped)), 'Enter flips it back');
  await press(p, 'Enter');
  let id = await S(p, () => view.queue[view.index]);
  await press(p, '2');
  ok(await S(p, (id) => view.index === 1 && state.progress[id].streak >= 1, id), '2 = Got it');
  await press(p, 'Enter');
  id = await S(p, () => view.queue[view.index]);
  await press(p, '1');
  ok(await S(p, (id) => view.index === 2 && state.progress[id].streak === 0, id), '1 = Missed it');
  // Held keys don't repeat
  await press(p, 'Enter');
  await S(p, () => { for (let i = 0; i < 5; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', repeat: i > 0, bubbles: true })); });
  ok(await S(p, () => view.index) === 3, 'holding a key triggers once (repeats ignored)');
  await press(p, '3');
  ok(await S(p, () => view.index === 4 && state.progress[view.queue[3]].retired), '3 = I know this');
  // Round summary: 1 Next, last = Back to chapter
  await S(p, () => { view.index = view.queue.length - 1; view.flipped = true; render(); });
  await press(p, '2');
  ok((await kn(p, '#nextRound')).t === '(1)' && (await kn(p, '#backChapter')).t === '(2)', 'round summary: (1) Next 20, (2) Back to chapter');
  await press(p, 'Enter');
  ok(await S(p, () => view.roundNo === 2 && view.index === 0), 'Enter on the summary = Next 20');
  await p.click('#exitStudy');

  // Scenario study: numbers follow the shown (shuffled) order, then Next and I know this
  await press(p, '3');
  const sc = await S(p, () => ({ order: Array.from(document.querySelectorAll('[data-spick]')).map((b) => Number(b.dataset.spick)), n: document.querySelectorAll('[data-spick]').length }));
  ok((await kn(p, `[data-spick="${sc.order[0]}"]`)).t === '(1)' && (await kn(p, `[data-spick="${sc.order[sc.n - 1]}"]`)).t === `(${sc.n})`, 'scenario: choices numbered 1..n top to bottom');
  await press(p, '2');
  ok(await S(p, (o) => view.studyPicked === o[1], sc.order), 'scenario: 2 picks the second shown choice');
  ok((await kn(p, '#nextStudy')).t === `(${sc.n + 1})`, `scenario: Next is (${sc.n + 1})`);
  await press(p, 'Enter');
  ok(await S(p, () => view.index === 1 && view.studyPicked === null), 'Enter = Next after answering');
  await p.click('#exitStudy');

  // Quiz: 1-4 choices in shown order, 5 / Enter = Next
  await press(p, '4');
  const q = await S(p, () => view.choices.map((c) => c.text));
  ok((await kn(p, '[data-choice="0"]')).t === '(1)' && (await kn(p, '[data-choice="3"]')).t === '(4)', 'quiz: choices (1)..(4)');
  await press(p, '3');
  ok(await S(p, () => view.picked === 2), 'quiz: 3 picks the third shown choice');
  ok((await kn(p, '#nextQuiz')).t === '(5)', 'quiz: Next is (5)');
  await press(p, '1');
  ok(await S(p, () => view.picked === 2), 'answered: choice keys are inert');
  await press(p, 'Enter');
  ok(await S(p, () => view.index === 1 && view.picked === null), 'Enter = Next question');
  await hideToast(p); await p.screenshot({ path: `${SHOTS}/keys-quiz-desktop.png` });
  await press(p, '2'); await press(p, '5');
  ok(await S(p, () => view.index === 2), '5 = Next');
  await p.click('#exitStudy');

  // Custom confirm replaces native confirm(): 1 = yes, 2 = no, Esc = no
  await press(p, '4');
  ok(await p.locator('#confirmDlg').count() === 1 && (await kn(p, '#cdYes')).t === '(1)' && (await kn(p, '#cdNo')).t === '(2)', 'restarting a saved quiz asks in a keyed dialog: (1) Start fresh, (2) Keep it');
  await press(p, '2');
  ok(await S(p, (F) => view.page === 'folder' && !!state.sessions[F + ':quiz'], F), '2 keeps the saved quiz');
  await press(p, '4'); await press(p, 'Escape');
  ok(await S(p, (F) => view.page === 'folder' && !!state.sessions[F + ':quiz'], F), 'Esc also keeps it');
  await press(p, '4'); await press(p, '1');
  ok(await S(p, () => view.page === 'quiz' && view.index === 0), '1 starts fresh');
  await p.click('#exitStudy');

  // Boss: numbers select, Enter locks in
  await press(p, '7');
  await press(p, '2');
  ok(await S(p, () => view.boss.sel === 1) && (await kn(p, '#bossNext')).t === `(${await S(p, () => view.boss.choices.length + 1)})`, 'boss: 2 selects the second choice; Lock in is the next number');
  await press(p, 'Enter');
  ok(await S(p, () => view.boss.index === 1 && view.boss.answers.length === 1), 'Enter = Lock in & next');
  await p.click('#exitBoss');

  // Match: numbers pick a term, then a definition
  await press(p, '6');
  const m = await S(p, () => ({ terms: view.match.pairs.map((x) => x.id), defs: view.match.defs.slice() }));
  ok((await kn(p, `[data-term="${m.terms[0]}"]`)).t === '(1)' && (await kn(p, `[data-def="${m.defs[0]}"]`)).t === '(1)', 'match: both columns numbered');
  await press(p, '1');
  ok(await S(p, (t) => view.match.selTerm === t, m.terms[0]), 'match: 1 picks the first term');
  await press(p, String(m.defs.indexOf(m.terms[0]) + 1));
  ok(await S(p, (t) => view.match.matched.includes(t), m.terms[0]), 'match: the definition number completes the pair');
  await p.click('#exitMatch');

  // Typing in inputs is ignored
  await p.click('#addCardBtn');
  await p.locator('.dialog-body input[type="text"], .dialog-body textarea').first().click();
  await press(p, '1'); await press(p, '2');
  ok(await S(p, () => modal.open) && (await p.locator('.dialog-body input[type="text"], .dialog-body textarea').first().inputValue()).endsWith('12'), 'digits typed into a form field stay in the field');
  await press(p, 'Escape');
  ok(await noBroke(p), 'app fine');
  await ctx.close();

  // Touch phone: labels hidden, progress untouched
  const ph = await page({ device: 'iPhone 13' });
  await ph.p.goto(GIST); await ph.p.click(`[data-open="${F}"]`); await ph.p.waitForSelector('#studyBtn');
  ok(!(await kn(ph.p, '#studyBtn')).shown && (await kn(ph.p, '#studyBtn')).aria === '1', 'phone: (n) labels hidden by media query (aria-keyshortcuts kept)');
  await ph.ctx.close();
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
  fs.mkdirSync(T, { recursive: true });
  execSync(`cd ${ROOT} && git show 0066785:flashcards.html > ${T}/original.html`);
  execSync(`cd ${ROOT} && git show 2186ee7:decks/inbox/c202-ch01.json > ${T}/ch01-prev.json`);
  fs.rmSync(T + '/inbox', { recursive: true, force: true }); fs.mkdirSync(T + '/inbox', { recursive: true });
  for (const f of fs.readdirSync(ROOT + '/decks/samples')) fs.copyFileSync(ROOT + '/decks/samples/' + f, T + '/inbox/' + f);
  execSync(`${ROOT}/build.sh --firebase-config none --inbox ${T}/inbox --out ${T}/dist-samples.html`);
  fs.rmSync(T + '/inbox-prev', { recursive: true, force: true }); fs.mkdirSync(T + '/inbox-prev');
  fs.copyFileSync(T + '/ch01-prev.json', T + '/inbox-prev/c202-ch01.json');
  execSync(`${ROOT}/build.sh --firebase-config none --inbox ${T}/inbox-prev --out ${T}/dist-prev.html`);
  fs.writeFileSync(T + '/fbcfg.json', JSON.stringify({ apiKey: 'fake-api-key', authDomain: 'study-buddy-1000.firebaseapp.com', projectId: 'study-buddy-1000', appId: '1:123:web:abc', messagingSenderId: '123' }));
  execSync(`${ROOT}/build.sh --firebase-config ${T}/fbcfg.json --out ${T}/dist-google.html`);
  execSync(`${ROOT}/build.sh --firebase-config none --out ${T}/dist-gist.html`);
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
    await testCounter();
    await testSync();
    await testSlotsAndKnow();
    await testDistractors();
    await testGoogleSync();
    await testRounds();
    await testShuffle();
    await testWeakSpots();
    await testKeys();
    await screenshots();
  } catch (e) { fail++; console.log('EXCEPTION', e); }
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ':\n' + errors.join('\n') : ''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
