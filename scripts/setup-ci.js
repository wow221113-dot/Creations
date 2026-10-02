// Runs on GitHub when building: fills in your username/repo automatically.
const fs = require('fs');
const [owner, repo] = String(process.env.GITHUB_REPOSITORY || '').split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is missing');
const c = JSON.parse(fs.readFileSync('config.json', 'utf8')); c.githubOwner = owner; c.githubRepo = repo;
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.build.publish = { provider: 'github', owner, repo, releaseType: 'release' };
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
