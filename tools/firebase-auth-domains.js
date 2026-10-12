#!/usr/bin/env node
// Add domains to Firebase Auth's authorized domains, using the firebase CLI's own login and API client
// (the same call the CLI makes for Hosting preview channels). Usage: node tools/firebase-auth-domains.js PROJECT DOMAIN...
const path = require('path'), { execSync } = require('child_process');
const root = execSync('npm root -g').toString().trim();
const lib = (p) => require(path.join(root, 'firebase-tools', 'lib', p));
(async () => {
  const [project, ...domains] = process.argv.slice(2);
  if (!project || !domains.length) { console.error('usage: firebase-auth-domains.js PROJECT DOMAIN...'); process.exit(2); }
  const { requireAuth } = lib('requireAuth');
  await requireAuth({});
  const auth = lib('gcp/auth');
  const current = await auth.getAuthDomains(project);
  const next = Array.from(new Set([...current, ...domains]));
  if (next.length === current.length) { console.log('  already authorized: ' + domains.join(', ')); return; }
  const saved = await auth.updateAuthDomains(project, next);
  console.log('  authorized domains: ' + saved.join(', '));
})().catch((e) => { console.error('  ' + (e && e.message ? e.message : e)); process.exit(1); });
