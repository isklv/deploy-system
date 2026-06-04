# Deployer

Лёгкий HTTP-сервер на Go для управления Docker-контейнерами на VPS.

## API

Все эндпоинты требуют `?token=DEPLOY_TOKEN`.

### Health

```
GET /health
```

### Deploy

```
POST /deploy?token=TOKEN
Content-Type: application/json

{
  "project": "video-demo",
  "compose_b64": "<base64-encoded docker-compose.yml>",
  "env_b64": "<base64-encoded .env (опционально)>"
}
```

Последовательность: write compose → write env → docker login → pull → force-clean stale → down → up.

### Контейнеры

```
GET /containers?token=TOKEN
```

Список всех контейнеров: ID, имя, образ, статус, порты.

### Логи

```
GET /logs?token=TOKEN&name=container&tail=100
```

Последние N строк логов контейнера.

### Стоп

```
POST /stop?token=TOKEN&name=container&timeout=10
```

Остановка контейнера (docker stop -t N).

### Удаление

```
POST /remove?token=TOKEN&name=container&force=1
```

Удаление контейнера (docker rm [-f]).

## Развертывание

```bash
cp .env.deployer.example .env.deployer
# Заполни DEPLOY_TOKEN и GHCR_TOKEN

docker compose -f docker-compose.deployer.yml up -d
```

## Сборка

```bash
cd deployer
CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o deployer .
```

Бинарь ~15MB, статически линкованный, без зависимостей.
