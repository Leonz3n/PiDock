//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Experiment only: Windows still re-resolves paths during File.Chdir.
// This does not implement the directory-identity contract used on macOS.
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
