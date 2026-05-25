# Automated Deploy System

Архитектура:
```
GitHub Actions (build & push → GHCR)
       │
       │  webhook POST /deploy
       ▼
  [deployer] ── docker compose up -d ──► сервисы на VPS
   на VPS
```

## Быстрый старт

### 1. На VPS — запустить deployer

```bash
# Создать директорию
mkdir -p /opt/deployer && cd /opt/deployer

# Скопировать docker-compose.deployer.yml и .env.deployer
# (файлы из этого репо)

# Создать токен для авторизации webhook
# любой случайный string, например: openssl rand -hex 32

# Запустить
docker compose -f docker-compose.deployer.yml up -d
```

Deployer слушает порт 9090, endpoint `/deploy`.

### 2. В GitHub repo — добавить Secret

```
Settings → Secrets and variables → Actions → New repository secret

Name:  DEPLOY_WEBHOOK
Value: http://<VPS_IP>:9090/deploy?token=<TOKEN_ИЗ_.ENV>
```

### 3. В проекте — добавить workflow

Скопировать `.github/workflows/deploy.yml` в проект.

### 4. Git push → автоматический деплой

---

## Как это работает

1. **Push на main** → GitHub Actions собирает Docker-образ
2. **Push в GHCR** → приватный образ `ghcr.io/isklv/<project>:<sha>`
3. **Webhook на VPS** → deployer получает POST /deploy
4. **Deployer** клонирует repo, делает `docker compose pull + up -d` в `/opt/projects/<name>/`
5. **Лог + статус** → ответ webhook'а содержит результат

## Структура проектов на VPS

```
/opt/projects/
├── short-link/
│   ├── docker-compose.yml    ← клонируется из GitHub
│   └── .env                  ← создаётся вручную или из secrets
├── another-app/
│   ├── docker-compose.yml
│   └── .env
└── ...
```

Deployer клонирует repo в `/opt/projects/<repo_name>/` и запускает compose оттуда.
