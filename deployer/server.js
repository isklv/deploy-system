const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Config from env
const PORT = parseInt(process.env.PORT) || 9090;
const TOKEN = process.env.DEPLOY_TOKEN || crypto.randomBytes(32).toString('hex');
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/opt/projects';
const LOG_WEBHOOK = process.env.LOG_WEBHOOK || '';

console.log(`🚀 Deployer started on port ${PORT}`);
console.log(`📁 Projects dir: ${PROJECTS_DIR}`);
console.log(`🔑 Token: ${TOKEN.substring(0, 8)}...`);

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  if (url.pathname === '/deploy' && req.method === 'POST') {
    return handleDeploy(req, res, url);
  }

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

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const project = data.project;       // project name, e.g. "video-callback"
      const composeContent = data.compose; // docker-compose.yml content
      const envContent = data.env;         // .env content (optional)

      if (!project) {
        return json(res, 400, { error: 'Missing "project" field' });
      }

      if (!composeContent) {
        return json(res, 400, { error: 'Missing "compose" field (docker-compose.yml content)' });
      }

      const projectDir = `${PROJECTS_DIR}/${project}`;
      log(`📦 Deploying ${project} → ${projectDir}`);

      const steps = [];

      // 1. Write docker-compose.yml
      execSync(`mkdir -p ${projectDir}`);
      fs.writeFileSync(`${projectDir}/docker-compose.yml`, composeContent);
      steps.push({ step: 'write-compose', status: 'success', output: 'docker-compose.yml written' });
      log('✅ docker-compose.yml written');

      // 2. Write .env if provided
      if (envContent) {
        fs.writeFileSync(`${projectDir}/.env`, envContent);
        steps.push({ step: 'write-env', status: 'success', output: '.env written' });
        log('✅ .env written');
      }

      // 3. Docker login (GHCR)
      const ghToken = process.env.GHCR_TOKEN;
      if (ghToken) {
        steps.push({
          step: 'login',
          cmd: `echo '${ghToken}' | docker login ghcr.io -u isklv --password-stdin`,
          output: '',
          status: ''
        });
      }

      // 4. Pull + deploy
      steps.push({
        step: 'deploy',
        cmd: `cd ${projectDir} && docker compose pull && docker compose up -d`,
        output: '',
        status: ''
      });

      // Execute
      const results = [];
      for (const step of steps) {
        if (step.status) {
          results.push(step);
          continue;
        }
        try {
          const output = execSync(step.cmd, {
            encoding: 'utf8',
            timeout: 300000,
            env: { ...process.env, HOME: '/root' }
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

      if (LOG_WEBHOOK) {
        forwardLog(project, allOk, results);
      }

      json(res, allOk ? 200 : 500, {
        success: allOk,
        project,
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
        const ps = execSync(`cd ${dir} && docker compose ps --format json 2>/dev/null || echo "[]"`, { encoding: 'utf8' });
        containers = JSON.parse(ps || '[]');
      } catch {}
      return { name, path: dir, containers };
    });
    json(res, 200, { projects });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

function forwardLog(project, success, results) {
  try {
    const summary = results.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.step}`).join('\n');
    const msg = `**${success ? '✅ Deploy OK' : '❌ Deploy Failed'}**\n\n` +
      `**Project:** ${project}\n\n` +
      `${summary}`;

    const data = JSON.stringify({ text: msg, parse_mode: 'Markdown' });
    const tmpFile = `/tmp/deploy-log-${Date.now()}.json`;
    fs.writeFileSync(tmpFile, data);
    execSync(`curl -s -X POST -H "Content-Type: application/json" -d @${tmpFile} ${LOG_WEBHOOK}`, {
      timeout: 5000, encoding: 'utf8'
    });
    fs.unlinkSync(tmpFile);
  } catch (err) {
    log(`⚠️ Log webhook failed: ${err.message}`);
  }
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

httpServer.listen(PORT, () => {
  log(`Listening on :${PORT}`);
});
