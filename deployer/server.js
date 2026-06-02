const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Config from env
const PORT = parseInt(process.env.PORT) || 9090;
const TOKEN = process.env.DEPLOY_TOKEN || crypto.randomBytes(32).toString('hex');
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/opt/projects';
const LOG_WEBHOOK = process.env.LOG_WEBHOOK || ''; // optional: forward logs to another webhook (e.g., Telegram bot)

console.log(`🚀 Deployer started on port ${PORT}`);
console.log(`📁 Projects dir: ${PROJECTS_DIR}`);
console.log(`🔑 Token: ${TOKEN.substring(0, 8)}...`);

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  // Deploy endpoint
  if (url.pathname === '/deploy' && req.method === 'POST') {
    return handleDeploy(req, res, url);
  }

  // List projects
  if (url.pathname === '/projects' && req.method === 'GET') {
    return listProjects(req, res, url);
  }

  json(res, 404, { error: 'Not found. Use /deploy (POST), /projects (GET), /health (GET)' });
});

function handleDeploy(req, res, url) {
  const token = url.searchParams.get('token');
  if (token !== TOKEN) {
    return json(res, 403, { error: 'Invalid token' });
  }

  // Read body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      const repo = data.repo;          // e.g. "isklv/short-link"
      const branch = data.branch || 'main';
      const composeFile = data.compose_file || 'docker-compose.yml';
      const serviceName = data.service || null; // deploy specific service only
      const envVars = data.env || {};   // optional: inline env vars

      if (!repo) {
        return json(res, 400, { error: 'Missing "repo" field. Expected: "owner/repo"' });
      }

      const projectName = repo.split('/').pop();
      const projectDir = `${PROJECTS_DIR}/${projectName}`;
      const ghToken = process.env.GHCR_TOKEN || process.env.GITHUB_TOKEN || '';
      const cloneBase = ghToken
        ? `https://${ghToken}@github.com/${repo}.git`
        : `https://github.com/${repo}.git`;

      log(`📦 Deploying ${repo} (${branch}) → ${projectDir}`);

      const steps = [];

      // 1. Clone or update
      if (exists(projectDir)) {
        log(`🔄 Updating ${projectDir}`);
        steps.push({ step: 'update', cmd: `cd ${projectDir} && git remote set-url origin ${cloneBase} && git pull origin ${branch}`, output: '' });
      } else {
        log(`📥 Cloning ${cloneBase} → ${projectDir}`);
        execSync(`mkdir -p ${PROJECTS_DIR}`);
        steps.push({ step: 'clone', cmd: `git clone --branch ${branch} --depth 1 ${cloneBase} ${projectDir}`, output: '' });
      }

      // 2. Docker login (GHCR)
      if (ghToken) {
        steps.push({
          step: 'login',
          cmd: `echo '${ghToken}' | docker login ghcr.io -u ${repo.split('/')[0]} --password-stdin`,
          output: ''
        });
      }

      // 3. Docker compose up
      const composeCmd = serviceName
        ? `cd ${projectDir} && docker compose -f ${composeFile} up -d --pull always ${serviceName}`
        : `cd ${projectDir} && docker compose -f ${composeFile} up -d --pull always`;

      steps.push({ step: 'deploy', cmd: composeCmd, output: '' });

      // Execute steps
      const results = [];
      for (const step of steps) {
        try {
          const output = execSync(step.cmd, {
            encoding: 'utf8',
            timeout: 120000,
            env: { ...process.env, HOME: '/root', GIT_TERMINAL_PROMPT: '0' }
          });
          step.output = output;
          step.status = 'success';
          results.push(step);
          log(`✅ ${step.step}: OK`);
        } catch (err) {
          step.output = err.stdout || err.message;
          step.status = 'error';
          results.push(step);
          log(`❌ ${step.step}: ${err.message}`);
        }
      }

      const allOk = results.every(r => r.status === 'success');

      // Forward to log webhook (Telegram, etc.)
      if (LOG_WEBHOOK) {
        forwardLog(repo, branch, projectName, allOk, results);
      }

      json(res, allOk ? 200 : 500, {
        success: allOk,
        project: projectName,
        repo,
        branch,
        results
      });
    } catch (err) {
      log(`💥 Fatal: ${err.message}`);
      json(res, 500, { success: false, error: err.message });
    }
  });
}

function listProjects(req, res, url) {
  const token = url.searchParams.get('token');
  if (token !== TOKEN) return json(res, 403, { error: 'Invalid token' });

  try {
    const output = execSync(`ls -1 ${PROJECTS_DIR}`, { encoding: 'utf8' });
    const projects = output.trim().split('\n').filter(Boolean).map(name => {
      const dir = `${PROJECTS_DIR}/${name}`;
      let containers = [];
      try {
        const ps = execSync(`docker compose -f ${dir}/docker-compose.yml ps --format json 2>/dev/null || echo "[]"`, { encoding: 'utf8' });
        containers = JSON.parse(ps || '[]');
      } catch {}
      return { name, path: dir, containers };
    });
    json(res, 200, { projects });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

function forwardLog(repo, branch, project, success, results) {
  try {
    const summary = results.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.step}`).join('\n');
    const msg = `**${success ? '✅ Deploy OK' : '❌ Deploy Failed'}**\n\n` +
      `**Project:** ${project}\n` +
      `**Repo:** ${repo}\n` +
      `**Branch:** ${branch}\n\n` +
      `${summary}`;

    const data = JSON.stringify({ text: msg, parse_mode: 'Markdown' });
    // Use --data-binary to avoid shell escaping issues
    const tmpFile = `/tmp/deploy-log-${Date.now()}.json`;
    require('fs').writeFileSync(tmpFile, data);
    execSync(`curl -s -X POST -H "Content-Type: application/json" -d @${tmpFile} ${LOG_WEBHOOK}`, {
      timeout: 5000, encoding: 'utf8'
    });
    require('fs').unlinkSync(tmpFile);
  } catch (err) {
    log(`⚠️ Log webhook failed: ${err.message}`);
  }
}

// Helpers
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function exists(path) {
  try { require('fs').accessSync(path); return true; } catch { return false; }
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

httpServer.listen(PORT, () => {
  log(`Listening on :${PORT}`);
});
