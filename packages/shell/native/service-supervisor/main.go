package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxRequest = 256 * 1024

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type launchRequest struct {
	TaskRoot string            `json:"taskRoot"`
	Cwd      string            `json:"cwd"`
	Program  string            `json:"program"`
	Args     []string          `json:"args"`
	Env      map[string]string `json:"env"`
	GraceMS  int               `json:"graceMs"`
}

type event struct {
	Event string `json:"event"`
	PID   int    `json:"pid,omitempty"`
	Code  int    `json:"code,omitempty"`
}

type ownedService interface {
	PID() int
	Wait() (int, error)
	Stop() error
}

func validate(req launchRequest) error {
	if !filepath.IsAbs(req.TaskRoot) || !filepath.IsAbs(req.Cwd) || !filepath.IsAbs(req.Program) ||
		req.GraceMS < 50 || req.GraceMS > 3000 || len(req.Args) > 100 || len(req.Env) > 200 {
		return errors.New("invalid-launch")
	}
	for _, arg := range req.Args {
		if len(arg) > 4096 || strings.ContainsRune(arg, 0) {
			return errors.New("invalid-argument")
		}
	}
	for name, value := range req.Env {
		if len(name) > 100 || !envName.MatchString(name) || len(value) > 4096 || strings.ContainsRune(value, 0) {
			return errors.New("invalid-environment")
		}
	}
	return nil
}

// Verify the resolved path and opened directory before changing cwd. This is
// not yet an atomic binding to the Host's task root: the root/path can change
// before open, and Windows File.Chdir resolves a path again. Keep this helper
// disconnected from production until both cases have verified ownership.
func pinCwd(req launchRequest) (*os.File, error) {
	root, err := filepath.EvalSymlinks(req.TaskRoot)
	if err != nil {
		return nil, errors.New("invalid-task-root")
	}
	cwd, err := filepath.EvalSymlinks(req.Cwd)
	if err != nil {
		return nil, errors.New("invalid-cwd")
	}
	inside, err := filepath.Rel(root, cwd)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(os.PathSeparator)) || filepath.IsAbs(inside) {
		return nil, errors.New("cwd-out-of-task")
	}
	before, err := os.Stat(cwd)
	if err != nil || !before.IsDir() {
		return nil, errors.New("invalid-cwd")
	}
	opened, err := os.Open(cwd)
	if err != nil {
		return nil, errors.New("invalid-cwd")
	}
	after, err := opened.Stat()
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		opened.Close()
		return nil, errors.New("cwd-changed")
	}
	return opened, nil
}

func supervise(scanner *bufio.Scanner) error {
	if !scanner.Scan() {
		return errors.New("missing-launch")
	}
	var req launchRequest
	decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return errors.New("invalid-launch")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("invalid-launch")
	}
	if err := validate(req); err != nil {
		return err
	}
	cwd, err := pinCwd(req)
	if err != nil {
		return err
	}
	defer cwd.Close()
	if err := cwd.Chdir(); err != nil {
		return errors.New("invalid-cwd")
	}
	owner, err := startOwned(req)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(event{Event: "ready", PID: owner.PID()}); err != nil {
		_ = owner.Stop()
		return errors.New("control-disconnected")
	}
	type completion struct {
		code int
		err  error
	}
	exited := make(chan completion, 1)
	go func() {
		code, err := owner.Wait()
		exited <- completion{code, err}
	}()
	control := make(chan bool, 1)
	go func() { control <- scanner.Scan() && scanner.Text() == "stop" }()
	select {
	case result := <-exited:
		if err := owner.Stop(); err != nil {
			return err
		}
		if result.err != nil {
			return errors.New("process-wait-failed")
		}
		return encoder.Encode(event{Event: "exit", Code: result.code})
	case <-control:
		if err := owner.Stop(); err != nil {
			return err
		}
		return encoder.Encode(event{Event: "stopped"})
	}
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--anchor" {
		ms, err := strconv.Atoi(os.Args[2])
		if err != nil || ms < 50 || ms > 3000 {
			os.Exit(2)
		}
		runAnchor(time.Duration(ms) * time.Millisecond)
		return
	}
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), maxRequest)
	if err := supervise(scanner); err != nil {
		fmt.Fprintln(os.Stderr, "service-supervisor:", err)
		_ = json.NewEncoder(os.Stdout).Encode(event{Event: "error"})
		os.Exit(1)
	}
}
