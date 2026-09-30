//go:build darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func matchesDirectory(file *os.File, identity directoryIdentity) bool {
	var stat unix.Stat_t
	if unix.Fstat(int(file.Fd()), &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return false
	}
	return identity.Device == strconv.FormatUint(uint64(stat.Dev), 10) && identity.Inode == strconv.FormatUint(stat.Ino, 10)
}

// Walk relative to the verified root handle. No component may redirect the
// walk through a symlink; the final handle must match the caller's identity.
func pinCwd(req launchRequest) (*os.File, error) {
	relative, err := filepath.Rel(req.TaskRoot, req.Cwd)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") || filepath.IsAbs(relative) {
		return nil, errors.New("cwd-out-of-task")
	}
	fd, err := unix.Open(req.TaskRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("invalid-task-root")
	}
	current := os.NewFile(uintptr(fd), "pinned-directory")
	if !matchesDirectory(current, req.RootIdentity) {
		current.Close()
		return nil, errors.New("task-root-changed")
	}
	if relative != "." {
		for _, part := range strings.Split(relative, string(os.PathSeparator)) {
			next, err := unix.Openat(int(current.Fd()), part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			current.Close()
			if err != nil {
				return nil, errors.New("invalid-cwd")
			}
			current = os.NewFile(uintptr(next), "pinned-directory")
		}
	}
	if !matchesDirectory(current, req.CwdIdentity) {
		current.Close()
		return nil, errors.New("cwd-changed")
	}
	return current, nil
}
