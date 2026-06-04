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
      const project = data.project;
      const composeB64 = data.compose_b64;
      const envB64 = data.env_b64;

      if (!project) return json(res, 400, { error: 'Missing "project" field' });
      if (!composeB64) return json(res, 400, { error: 'Missing "compose_b64" field' });

      const composeContent = Buffer.from(composeB64, 'base64').toString('utf8');
      const envContent = envB64 ? Buffer.from(envB64, 'base64').toString('utf8') : '';

      const projectDir = `${PROJECTS_DIR}/${project}`;
      log(`📦 Deploying ${project} → ${projectDir}`);

      const results = [];

      // 1. Write docker-compose.yml
      execSync(`mkdir -p ${projectDir}`);
      fs.writeFileSync(`${projectDir}/docker-compose.yml`, composeContent);
      results.push({ step: 'write-compose', status: 'success', output: 'docker-compose.yml written' });
      log('✅ docker-compose.yml written');

      // 2. Write .env if provided
      if (envContent) {
        fs.writeFileSync(`${projectDir}/.env`, envContent);
        results.push({ step: 'write-env', status: 'success', output: '.env written' });
        log('✅ .env written');
      }

      // 3. Docker login (GHCR)
      const ghToken = process.env.GHCR_TOKEN;
      if (ghToken) {
        try {
          const output = execSync(`echo '${ghToken}' | docker login ghcr.io -u isklv --password-stdin`, {
            encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: '/root' }
          });
          results.push({ step: 'login', status: 'success', output: output.trim() });
          log('✅ Docker login: OK');
        } catch (err) {
          results.push({ step: 'login', status: 'error', output: err.message });
          log(`❌ Docker login: ${err.message}`);
        }
      }

      // Try docker compose (plugin) first, fallback to docker-compose (standalone)
      let composeCmd = 'docker compose';
      try {
        execSync('which docker-compose || docker compose version', { encoding: 'utf8', timeout: 5000 });
        // docker-compose exists, use it
        composeCmd = 'docker-compose';
      } catch {
        // docker compose plugin or fallback
        try {
          execSync('docker compose version', { encoding: 'utf8', timeout: 5000 });
          composeCmd = 'docker compose';
        } catch {
          results.push({ step: 'compose-check', status: 'error', output: 'Neither docker-compose nor docker compose plugin found' });
          log('❌ Docker Compose not found!');
        }
      }

      // 4. Pull images
      try {
        const pullOutput = execSync(`cd ${projectDir} && ${composeCmd} pull`, {
          encoding: 'utf8', timeout: 300000, env: { ...process.env, HOME: '/root' }
        });
        results.push({ step: 'pull', status: 'success', output: pullOutput.trim() });
        log('✅ Pull: OK');
      } catch (err) {
        results.push({ step: 'pull', status: 'error', output: err.message });
        log(`❌ Pull: ${err.message}`);
      }

      // 5. Stop old containers (to free ports)
      try {
        const downOutput = execSync(`cd ${projectDir} && ${composeCmd} down`, {
          encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: '/root' }
        });
        results.push({ step: 'down', status: 'success', output: downOutput.trim() });
        log('✅ Down: OK');
      } catch (err) {
        results.push({ step: 'down', status: 'error', output: err.message });
        log(`❌ Down: ${err.message}`);
      }

      // 6. Compose up -d (start/restart containers)
      try {
        const upOutput = execSync(`cd ${projectDir} && ${composeCmd} up -d`, {
          encoding: 'utf8', timeout: 300000, env: { ...process.env, HOME: '/root' }
        });
        results.push({ step: 'up', status: 'success', output: upOutput.trim() });
        log('✅ Up: OK');
      } catch (err) {
        results.push({ step: 'up', status: 'error', output: err.message });
        log(`❌ Up: ${err.message}`);
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
