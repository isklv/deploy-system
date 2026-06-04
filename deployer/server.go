package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ---- config ----

var (
	port        = flag.String("port", envOr("PORT", "9090"), "HTTP listen port")
	token       = flag.String("token", envOr("DEPLOY_TOKEN", ""), "Deploy token (generated if empty)")
	projectsDir = flag.String("projects-dir", envOr("PROJECTS_DIR", "/opt/projects"), "Directory for project files")
	ghcrToken   = flag.String("ghcr-token", envOr("GHCR_TOKEN", ""), "GitHub PAT for ghcr.io login")
	logWebhook  = flag.String("log-webhook", envOr("LOG_WEBHOOK", ""), "Telegram webhook URL for deploy notifications")
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var startTime time.Time

// ---- helpers ----

func runCmd(dir, command string, args ...string) (string, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "HOME=/root")
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func runCmdShell(dir, script string) (string, error) {
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "HOME=/root")
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func checkToken(r *http.Request) bool {
	return r.URL.Query().Get("token") == *token
}

func mustRandomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// ---- deploy step tracking ----

type deployStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
	Output string `json:"output"`
}

type deployResponse struct {
	Success bool         `json:"success"`
	Project string       `json:"project"`
	Steps   []deployStep `json:"steps"`
}

func newDeployResp(project string) *deployResponse {
	return &deployResponse{Project: project, Steps: []deployStep{}}
}

func (d *deployResponse) addStep(step, status, output string) {
	d.Steps = append(d.Steps, deployStep{Step: step, Status: status, Output: truncate(output, 1000)})
}

func (d *deployResponse) allSuccess() bool {
	for _, s := range d.Steps {
		if s.Status != "success" {
			return false
		}
	}
	return true
}

// ---- handlers ----

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"status":  "ok",
		"uptime":  time.Since(startTime).String(),
		"version": "1.0.0-go",
	})
}

// POST /deploy?token=X
// Body: {"project": "video-demo", "compose_b64": "...", "env_b64": "..."}
func deployHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if !checkToken(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid token"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}

	var req struct {
		Project    string `json:"project"`
		ComposeB64 string `json:"compose_b64"`
		EnvB64     string `json:"env_b64"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Project == "" {
		writeJSON(w, 400, map[string]string{"error": "missing project"})
		return
	}
	if req.ComposeB64 == "" {
		writeJSON(w, 400, map[string]string{"error": "missing compose_b64"})
		return
	}

	resp := newDeployResp(req.Project)
	projectDir := filepath.Join(*projectsDir, req.Project)

	log.Printf("📦 Deploying %s → %s", req.Project, projectDir)

	// 1. Create project dir
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		resp.addStep("mkdir", "error", err.Error())
		writeJSON(w, 500, resp)
		return
	}

	// 2. Write docker-compose.yml
	composeData, err := base64.StdEncoding.DecodeString(req.ComposeB64)
	if err != nil {
		resp.addStep("decode-compose", "error", err.Error())
		writeJSON(w, 400, resp)
		return
	}
	if err := os.WriteFile(filepath.Join(projectDir, "docker-compose.yml"), composeData, 0644); err != nil {
		resp.addStep("write-compose", "error", err.Error())
		writeJSON(w, 500, resp)
		return
	}
	resp.addStep("write-compose", "success", "docker-compose.yml written")
	log.Printf("✅ docker-compose.yml written")

	// 3. Write .env if provided
	if req.EnvB64 != "" {
		envData, err := base64.StdEncoding.DecodeString(req.EnvB64)
		if err != nil {
			resp.addStep("decode-env", "error", err.Error())
			writeJSON(w, 400, resp)
			return
		}
		if err := os.WriteFile(filepath.Join(projectDir, ".env"), envData, 0644); err != nil {
			resp.addStep("write-env", "error", err.Error())
			writeJSON(w, 500, resp)
			return
		}
		resp.addStep("write-env", "success", ".env written")
		log.Printf("✅ .env written")
	}

	// 4. Docker login (GHCR)
	if *ghcrToken != "" {
		loginOut, loginErr := runCmdShell("", fmt.Sprintf("echo '%s' | docker login ghcr.io -u isklv --password-stdin", *ghcrToken))
		if loginErr != nil {
			resp.addStep("login", "error", loginOut)
			log.Printf("❌ Docker login: %s", loginOut)
		} else {
			resp.addStep("login", "success", loginOut)
			log.Printf("✅ Docker login: OK")
		}
	}

	// 5. Determine compose command
	composeCmd := "docker"
	composeSub := "compose"
	if _, err := runCmd("", "docker", "compose", "version"); err != nil {
		// Fallback to standalone docker-compose
		composeCmd = "docker-compose"
		composeSub = ""
		if _, err := runCmd("", composeCmd, "version"); err != nil {
			resp.addStep("compose-check", "error", "neither docker compose nor docker-compose found")
			writeJSON(w, 500, resp)
			return
		}
	}
	resp.addStep("compose-check", "success", fmt.Sprintf("using %s %s", composeCmd, composeSub))

	composeRun := func(args ...string) (string, error) {
		fullArgs := []string{}
		if composeSub != "" {
			fullArgs = append(fullArgs, composeSub)
		}
		fullArgs = append(fullArgs, args...)
		return runCmd(projectDir, composeCmd, fullArgs...)
	}

	// 6. Pull images
	pullOut, pullErr := composeRun("pull")
	if pullErr != nil {
		resp.addStep("pull", "error", pullOut)
		log.Printf("❌ Pull: %s", pullOut)
	} else {
		resp.addStep("pull", "success", pullOut)
		log.Printf("✅ Pull: OK")
	}

	// 7. Force remove stale containers
	prefix := strings.ReplaceAll(req.Project, "-", "_")
	staleOut, staleErr := runCmd("", "docker", "ps", "-aq", "--filter", "name="+prefix+"_")
	if staleErr == nil && strings.TrimSpace(staleOut) != "" {
		stale := strings.Fields(staleOut)
		rmArgs := append([]string{"rm", "-f"}, stale...)
		rmOut, rmErr := runCmd("", "docker", rmArgs...)
		if rmErr != nil {
			resp.addStep("force-clean", "error", rmOut)
		} else {
			resp.addStep("force-clean", "success", fmt.Sprintf("removed %d stale containers", len(stale)))
			log.Printf("🧹 Force removed %d stale containers", len(stale))
		}
	} else {
		resp.addStep("force-clean", "success", "none found")
	}

	// 8. Compose down
	downOut, downErr := composeRun("down")
	if downErr != nil {
		resp.addStep("down", "error", downOut)
		log.Printf("❌ Down: %s", downOut)
	} else {
		resp.addStep("down", "success", downOut)
		log.Printf("✅ Down: OK")
	}

	// Brief pause for ports
	time.Sleep(3 * time.Second)

	// 9. Compose up -d
	upOut, upErr := composeRun("up", "-d")
	if upErr != nil {
		resp.addStep("up", "error", upOut)
		log.Printf("❌ Up: %s", upOut)
	} else {
		resp.addStep("up", "success", upOut)
		log.Printf("✅ Up: OK")
	}

	// Webhook notification
	if *logWebhook != "" {
		go sendWebhook(req.Project, resp.allSuccess(), resp.Steps)
	}

	if resp.allSuccess() {
		writeJSON(w, 200, resp)
	} else {
		writeJSON(w, 500, resp)
	}
}

// GET /containers?token=X
func containersHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "GET only"})
		return
	}
	if !checkToken(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid token"})
		return
	}

	out, err := runCmd("", "docker", "ps", "-a", "--format",
		"{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "docker ps failed: " + err.Error()})
		return
	}

	type containerInfo struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Image      string `json:"image"`
		Status     string `json:"status"`
		State      string `json:"state"`
		Ports      string `json:"ports"`
		RunningFor string `json:"running_for"`
	}

	var containers []containerInfo
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) < 4 {
			continue
		}

		status := parts[3]
		state := "unknown"
		runningFor := ""
		if strings.HasPrefix(status, "Up ") {
			state = "running"
			runningFor = strings.TrimPrefix(status, "Up ")
		} else if strings.HasPrefix(status, "Exited") {
			state = "exited"
		} else if strings.HasPrefix(status, "Created") {
			state = "created"
		} else if strings.HasPrefix(status, "Restarting") {
			state = "restarting"
		}

		containers = append(containers, containerInfo{
			ID:         parts[0],
			Name:       parts[1],
			Image:      parts[2],
			Status:     status,
			State:      state,
			Ports:      parts[4],
			RunningFor: runningFor,
		})
	}

	writeJSON(w, 200, map[string]any{"containers": containers})
}

// GET /logs?token=X&name=container&tail=100
func logsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "GET only"})
		return
	}
	if !checkToken(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid token"})
		return
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		writeJSON(w, 400, map[string]string{"error": "missing name parameter"})
		return
	}

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "100"
	}

	args := []string{"logs", "--tail", tail}
	if r.URL.Query().Get("follow") == "1" {
		args = append(args, "-f")
	}
	args = append(args, name)

	cmd := exec.Command("docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeJSON(w, 500, map[string]any{
			"error":  "docker logs failed",
			"output": string(out),
		})
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(200)
	w.Write(out)
}

// POST /stop?token=X&name=container&timeout=10
func stopHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if !checkToken(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid token"})
		return
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		writeJSON(w, 400, map[string]string{"error": "missing name parameter"})
		return
	}

	timeout := r.URL.Query().Get("timeout")
	if timeout == "" {
		timeout = "10"
	}

	out, err := runCmd("", "docker", "stop", "-t", timeout, name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error(), "output": out})
		return
	}

	log.Printf("⏹ Stopped container %s", name)
	writeJSON(w, 200, map[string]any{"status": "stopped", "name": name, "output": out})
}

// POST /remove?token=X&name=container&force=1
func removeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if !checkToken(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid token"})
		return
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		writeJSON(w, 400, map[string]string{"error": "missing name parameter"})
		return
	}

	args := []string{"rm"}
	if r.URL.Query().Get("force") == "1" {
		args = append(args, "-f")
	}
	args = append(args, name)

	out, err := runCmd("", "docker", args...)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error(), "output": out})
		return
	}

	log.Printf("🗑 Removed container %s", name)
	writeJSON(w, 200, map[string]any{"status": "removed", "name": name, "output": out})
}

// ---- webhook ----

func sendWebhook(project string, success bool, steps []deployStep) {
	var lines []string
	for _, s := range steps {
		icon := "✅"
		if s.Status != "success" {
			icon = "❌"
		}
		lines = append(lines, fmt.Sprintf("%s %s", icon, s.Step))
	}

	title := "✅ Deploy OK"
	if !success {
		title = "❌ Deploy Failed"
	}

	msg := fmt.Sprintf("**%s**\n\n**Project:** %s\n\n%s", title, project, strings.Join(lines, "\n"))

	data, _ := json.Marshal(map[string]string{
		"text":       msg,
		"parse_mode": "Markdown",
	})

	tmpFile := fmt.Sprintf("/tmp/deploy-webhook-%d.json", time.Now().UnixNano())
	os.WriteFile(tmpFile, data, 0644)
	defer os.Remove(tmpFile)

	out, err := runCmd("", "curl", "-s", "-X", "POST",
		"-H", "Content-Type: application/json",
		fmt.Sprintf("-d@%s", tmpFile),
		*logWebhook)
	if err != nil {
		log.Printf("⚠️ Webhook failed: %s %s", out, err)
	}
}

// ---- main ----

func main() {
	flag.Parse()
	startTime = time.Now()

	if *token == "" {
		*token = mustRandomHex(32)
	}

	log.Printf("🚀 Deployer starting on :%s", *port)
	log.Printf("📁 Projects dir: %s", *projectsDir)
	log.Printf("🔑 Token: %s...", (*token)[:minLen(len(*token), 8)])

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/deploy", deployHandler)
	mux.HandleFunc("/containers", containersHandler)
	mux.HandleFunc("/logs", logsHandler)
	mux.HandleFunc("/stop", stopHandler)
	mux.HandleFunc("/remove", removeHandler)

	log.Printf("Listening on :%s", *port)
	if err := http.ListenAndServe(":"+*port, mux); err != nil {
		log.Fatalf("❌ Server failed: %s", err)
	}
}

func minLen(a, b int) int {
	if a < b {
		return a
	}
	return b
}
