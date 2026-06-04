# Build stage
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates
WORKDIR /build
COPY go.mod .
RUN go mod download
COPY server.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o deployer .

# Runtime — minimal + Docker CLI + docker-compose standalone
FROM alpine:3.19

RUN apk add --no-cache docker-cli curl ca-certificates tzdata \
    && wget -qO /usr/local/bin/docker-compose \
       "https://github.com/docker/compose/releases/download/v2.32.1/docker-compose-linux-x86_64" \
    && chmod +x /usr/local/bin/docker-compose

COPY --from=builder /build/deployer /usr/local/bin/deployer

EXPOSE 9090

ENTRYPOINT ["deployer"]
CMD []
