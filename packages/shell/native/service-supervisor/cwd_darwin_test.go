//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCwdIdentityRefusesReplacement(t *testing.T) {
	for _, replaceRoot := range []bool{false, true} {
		t.Run(map[bool]string{false: "cwd", true: "root"}[replaceRoot], func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "root")
			cwd := filepath.Join(root, "worktree", "app")
			if err := os.MkdirAll(cwd, 0700); err != nil {
				t.Fatal(err)
			}
			req := request(root, "/bin/sleep", "30")
			req.Cwd, req.CwdIdentity = cwd, identity(cwd)
			target := cwd
			if replaceRoot {
				target = root
			}
			if err := os.Rename(target, target+"-old"); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(cwd, 0700); err != nil {
				t.Fatal(err)
			}
			h := newHarness(t, req)
			h.next(t, "error")
		})
	}
}

func TestCwdRefusesSymlinkComponentsAndMissingIdentity(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	req := request(root, "/bin/sleep", "30")
	req.Cwd, req.CwdIdentity = link, identity(outside)
	if file, err := pinCwd(req); err == nil {
		file.Close()
		t.Fatal("accepted symlink")
	}
	req = request(root, "/bin/sleep", "30")
	req.RootIdentity = directoryIdentity{}
	if file, err := pinCwd(req); err == nil {
		file.Close()
		t.Fatal("accepted missing identity")
	}
}

func TestPinnedCwdSurvivesRenameWithoutFollowingReplacement(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "app")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	req := request(root, "/bin/sleep", "30")
	req.Cwd, req.CwdIdentity = cwd, identity(cwd)
	pinned, err := pinCwd(req)
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	if err := os.Rename(cwd, cwd+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	// Run fchdir in a child to avoid changing the test runner's global cwd.
	child := exec.Command(os.Args[0], "-test.run=^TestPinnedDirectoryChild$")
	child.ExtraFiles = []*os.File{pinned}
	child.Env = append(os.Environ(), "PIDOCK_CWD_PROBE=1", "PIDOCK_CWD_DEVICE="+req.CwdIdentity.Device, "PIDOCK_CWD_INODE="+req.CwdIdentity.Inode)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("cwd probe: %v: %s", err, output)
	}
	if identity(cwd) == req.CwdIdentity {
		t.Fatal("replacement reused identity")
	}
}

func TestNestedPinnedCwdLaunch(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "worktree", "app")
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	req := request(root, "/bin/pwd", "-P")
	req.Cwd, req.CwdIdentity = cwd, identity(cwd)
	h := newHarness(t, req)
	h.next(t, "ready")
	select {
	case line := <-h.output:
		expected, err := filepath.EvalSymlinks(cwd)
		if err != nil || line != expected {
			t.Fatalf("unexpected cwd %q, expected %q", line, expected)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing cwd output")
	}
	h.next(t, "exit")
}

func TestPinnedDirectoryChild(t *testing.T) {
	if os.Getenv("PIDOCK_CWD_PROBE") != "1" {
		return
	}
	directory := os.NewFile(3, "pinned")
	defer directory.Close()
	if err := directory.Chdir(); err != nil {
		t.Fatal(err)
	}
	if identity(".") != (directoryIdentity{Device: os.Getenv("PIDOCK_CWD_DEVICE"), Inode: os.Getenv("PIDOCK_CWD_INODE")}) {
		t.Fatal("fchdir followed replacement")
	}
}
