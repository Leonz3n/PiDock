//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

type windowsHarness struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	status <-chan event
	output <-chan string
}

func buildTestBinary(t *testing.T, target, source string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), target)
	build := exec.Command("go", "build", "-o", binary, source)
	if result, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v: %s", source, err, result)
	}
	return binary
}

func newWindowsHarness(t *testing.T, req launchRequest) *windowsHarness {
	t.Helper()
	binary := buildTestBinary(t, "supervisor.exe", ".")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
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
	return &windowsHarness{cmd: cmd, stdin: stdin, status: statuses, output: lines}
}

func (h *windowsHarness) next(t *testing.T, want string) event {
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

func windowsRequest(root, program string, args ...string) launchRequest {
	return launchRequest{TaskRoot: root, Cwd: root, Program: program, Args: args,
		Env: map[string]string{"SystemRoot": os.Getenv("SystemRoot")}, GraceMS: 100}
}

func childHandle(t *testing.T, pid int) windows.Handle {
	t.Helper()
	if pid <= 0 {
		t.Fatal("invalid process pid")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if err == windows.ERROR_INVALID_PARAMETER {
			return 0
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { windows.CloseHandle(handle) })
	return handle
}

func expectWindowsGone(t *testing.T, handle windows.Handle) {
	t.Helper()
	if handle == 0 {
		return
	}
	state, err := windows.WaitForSingleObject(handle, 3000)
	if err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("owned process still alive: wait state=%d error=%v", state, err)
	}
}

func TestWindowsJobStop(t *testing.T) {
	root := t.TempDir()
	fixture := buildTestBinary(t, "fixture.exe", "./testdata/fixture")
	h := newWindowsHarness(t, windowsRequest(root, fixture, "sleep"))
	process := childHandle(t, h.next(t, "ready").PID)
	if _, err := io.WriteString(h.stdin, "stop\n"); err != nil {
		t.Fatal(err)
	}
	h.next(t, "stopped")
	expectWindowsGone(t, process)
}

func TestWindowsJobParentExitCleansDescendant(t *testing.T) {
	root := t.TempDir()
	fixture := buildTestBinary(t, "fixture.exe", "./testdata/fixture")
	h := newWindowsHarness(t, windowsRequest(root, fixture, "parent", "exit"))
	h.next(t, "ready")
	var pid int
	select {
	case line := <-h.output:
		pid, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	process := childHandle(t, pid)
	h.next(t, "exit")
	expectWindowsGone(t, process)
}

func TestWindowsJobSupervisorCrashCleansDescendant(t *testing.T) {
	root := t.TempDir()
	fixture := buildTestBinary(t, "fixture.exe", "./testdata/fixture")
	h := newWindowsHarness(t, windowsRequest(root, fixture, "parent"))
	h.next(t, "ready")
	var pid int
	select {
	case line := <-h.output:
		pid, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	process := childHandle(t, pid)
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	expectWindowsGone(t, process)
}

func TestWindowsControlDisconnectCleansDescendant(t *testing.T) {
	root := t.TempDir()
	fixture := buildTestBinary(t, "fixture.exe", "./testdata/fixture")
	h := newWindowsHarness(t, windowsRequest(root, fixture, "parent"))
	h.next(t, "ready")
	var pid int
	select {
	case line := <-h.output:
		pid, _ = strconv.Atoi(strings.TrimSpace(line))
	case <-time.After(5 * time.Second):
		t.Fatal("missing descendant pid")
	}
	process := childHandle(t, pid)
	h.stdin.Close()
	h.next(t, "stopped")
	expectWindowsGone(t, process)
}

func TestWindowsCwdEscapeRefused(t *testing.T) {
	root := t.TempDir()
	fixture := buildTestBinary(t, "fixture.exe", "./testdata/fixture")
	req := windowsRequest(root, fixture, "sleep")
	req.Cwd = t.TempDir()
	h := newWindowsHarness(t, req)
	h.next(t, "error")
}
