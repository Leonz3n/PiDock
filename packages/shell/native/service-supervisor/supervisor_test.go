//go:build darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

type supervisorHarness struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	status <-chan event
	output <-chan string
}

func newHarness(t *testing.T, req launchRequest) *supervisorHarness {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "service-supervisor")
	build := exec.Command("go", "build", "-o", binary, ".")
	if result, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build supervisor: %v: %s", err, result)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	cmd := exec.CommandContext(ctx, binary)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	statusRead, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	outputRead, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stdin.Close()
		cancel()
		cmd.Wait()
		statusRead.Close()
		outputRead.Close()
	})
	statuses := make(chan event, 10)
	go func() {
		defer close(statuses)
		scan := bufio.NewScanner(statusRead)
		for scan.Scan() {
			var received event
			if json.Unmarshal(scan.Bytes(), &received) == nil {
				statuses <- received
			}
		}
	}()
	lines := make(chan string, 10)
	go func() {
		defer close(lines)
		scan := bufio.NewScanner(outputRead)
		for scan.Scan() {
			lines <- scan.Text()
		}
	}()
	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stdin.Write(append(payload, '\n')); err != nil {
		t.Fatal(err)
	}
	return &supervisorHarness{cmd: cmd, stdin: stdin, status: statuses, output: lines}
}

func (h *supervisorHarness) next(t *testing.T, want string) event {
	t.Helper()
	select {
	case received, ok := <-h.status:
		if !ok || received.Event != want {
			t.Fatalf("expected %s, got %+v (open=%v)", want, received, ok)
		}
		return received
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", want)
		return event{}
	}
}

func expectGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	t.Fatalf("process %d was not reaped after supervisor stopped", pid)
}

func request(root, program string, args ...string) launchRequest {
	return launchRequest{TaskRoot: root, Cwd: root, Program: program, Args: args,
		Env: map[string]string{"PATH": "/usr/bin:/bin"}, GraceMS: 100}
}

func TestStopTerminatesOwnedService(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, request(root, "/bin/sleep", "30"))
	pid := h.next(t, "ready").PID
	if pid <= 0 {
		t.Fatal("missing service pid")
	}
	if _, err := io.WriteString(h.stdin, "stop\n"); err != nil {
		t.Fatal(err)
	}
	h.next(t, "stopped")
	expectGone(t, pid)
}

func TestParentExitCleansDescendant(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, request(root, "/bin/sh", "-c", "sleep 30 & echo $!; exit 0"))
	h.next(t, "ready")
	var descendant int
	select {
	case line := <-h.output:
		descendant, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	if descendant <= 0 {
		t.Fatal("invalid descendant pid")
	}
	t.Cleanup(func() { _ = syscall.Kill(descendant, syscall.SIGKILL) })
	h.next(t, "exit")
	expectGone(t, descendant)
}

func TestSupervisorCrashCleansDescendant(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, request(root, "/bin/sh", "-c", "sleep 30 & echo $!; wait"))
	h.next(t, "ready")
	var descendant int
	select {
	case line := <-h.output:
		descendant, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	if descendant <= 0 {
		t.Fatal("invalid descendant pid")
	}
	t.Cleanup(func() { _ = syscall.Kill(descendant, syscall.SIGKILL) })
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	expectGone(t, descendant)
}

func TestCwdEscapeRefusedBeforeSpawn(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	req := request(root, "/bin/sleep", "30")
	req.Cwd = outside
	h := newHarness(t, req)
	h.next(t, "error")
}

func TestControlDisconnectCleansDescendant(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, request(root, "/bin/sh", "-c", "sleep 30 & echo $!; wait"))
	h.next(t, "ready")
	var descendant int
	select {
	case line := <-h.output:
		descendant, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	if descendant <= 0 {
		t.Fatal("invalid descendant pid")
	}
	t.Cleanup(func() { _ = syscall.Kill(descendant, syscall.SIGKILL) })
	h.stdin.Close()
	h.next(t, "stopped")
	expectGone(t, descendant)
}
