//go:build darwin

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
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
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
	return newHarnessBinary(t, req, binary)
}

func newHarnessBinary(t *testing.T, req launchRequest, binary string) *supervisorHarness {
	t.Helper()
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

func identity(path string) directoryIdentity {
	var stat syscall.Stat_t
	if syscall.Stat(path, &stat) != nil {
		return directoryIdentity{}
	}
	return directoryIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}
}

func request(root, program string, args ...string) launchRequest {
	return launchRequest{TaskRoot: root, Cwd: root, RootIdentity: identity(root), CwdIdentity: identity(root), Program: program, Args: args,
		Env: map[string]string{"PATH": "/usr/bin:/bin"}, GraceMS: 100}
}

func observeAnchor(t *testing.T, servicePID int) func() string {
	t.Helper()
	pid, err := syscall.Getpgid(servicePID)
	if err != nil {
		return func() string { return "group-unavailable" }
	}
	queue, err := unix.Kqueue()
	if err != nil {
		return func() string { return "queue-unavailable" }
	}
	t.Cleanup(func() { unix.Close(queue) })
	change := unix.Kevent_t{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT | unix.NOTE_EXITSTATUS}
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		return func() string { return "watch-unavailable" }
	}
	return func() string {
		events := make([]unix.Kevent_t, 1)
		count, err := unix.Kevent(queue, nil, events, &unix.Timespec{Sec: 1})
		if err != nil || count != 1 {
			return "no-exit-event"
		}
		return "anchor-wait-status-" + strconv.FormatInt(events[0].Data, 10)
	}
}

func TestAnchorDelayedKill(t *testing.T) {
	mode := os.Args[len(os.Args)-1]
	if mode == "--delayed-anchor" || mode == "--failed-anchor" {
		runAnchorWithSignal(50*time.Millisecond, func(group int, signal syscall.Signal) error {
			if signal == syscall.SIGKILL {
				if mode == "--failed-anchor" {
					return syscall.EPERM
				}
				go func() { time.Sleep(20 * time.Millisecond); _ = syscall.Kill(os.Getpid(), syscall.SIGKILL) }()
			}
			return nil
		})
		return
	}
	for _, mode := range []string{"--delayed-anchor", "--failed-anchor"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAnchorDelayedKill$", "--", mode)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			ready, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer ready.Close()
			defer writer.Close()
			cmd.ExtraFiles = []*os.File{writer}
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			writer.Close()
			var token [1]byte
			if _, err := io.ReadFull(ready, token[:]); err != nil || token[0] != 1 {
				t.Fatal("anchor not ready")
			}
			input.Close()
			err = cmd.Wait()
			if mode == "--delayed-anchor" && !anchorStopped(err) {
				t.Fatalf("delayed SIGKILL lost to anchor exit: %v", err)
			}
			if mode == "--failed-anchor" {
				exit, ok := err.(*exec.ExitError)
				if !ok || exit.ExitCode() != 2 || anchorStopped(err) {
					t.Fatalf("failed kill was not refused: %v", err)
				}
			}
		})
	}
}

func TestRepeatedLifecycle(t *testing.T) {
	binary := os.Getenv("PIDOCK_TEST_SUPERVISOR_BINARY")
	if binary == "" {
		binary = filepath.Join(t.TempDir(), "service-supervisor")
		if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
			t.Fatalf("build: %v: %s", err, output)
		}
	}
	slots := make(chan struct{}, 8)
	for attempt := 0; attempt < 120; attempt++ {
		t.Run(strconv.Itoa(attempt), func(t *testing.T) {
			t.Parallel()
			slots <- struct{}{}
			defer func() { <-slots }()
			script, terminal := "sleep 30 & echo $!; exit 3", "exit"
			if attempt%2 == 1 {
				script, terminal = "sleep 30 & echo $!; wait", "stopped"
			}
			req := request(t.TempDir(), "/bin/sh", "-c", script)
			req.GraceMS = 50
			h := newHarnessBinary(t, req, binary)
			ready := h.next(t, "ready")
			observed := observeAnchor(t, ready.PID)
			var pid int
			select {
			case line := <-h.output:
				pid, _ = strconv.Atoi(line)
			case <-time.After(time.Second):
				t.Fatal("missing descendant")
			}
			if pid <= 0 {
				t.Fatal("invalid descendant")
			}
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			if terminal == "stopped" {
				h.stdin.Close()
			}
			select {
			case result := <-h.status:
				if result.Event != terminal || terminal == "exit" && result.Code != 3 {
					select {
					case diagnostic := <-h.output:
						t.Fatalf("terminal=%+v diagnostic=%s observed=%s", result, diagnostic, observed())
					case <-time.After(time.Second):
						t.Fatalf("terminal=%+v; no diagnostic", result)
					}
				}
			case <-time.After(5 * time.Second):
				t.Fatal("terminal timeout")
			}
			expectGone(t, pid)
		})
	}
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
