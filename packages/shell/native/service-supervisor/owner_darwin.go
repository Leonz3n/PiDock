//go:build darwin

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

type darwinOwner struct {
	service *exec.Cmd
	anchor  *exec.Cmd
	input   io.WriteCloser
	grace   time.Duration
}

func (owner *darwinOwner) PID() int { return owner.service.Process.Pid }

func (owner *darwinOwner) Wait() (int, error) {
	err := owner.service.Wait()
	if err == nil {
		return 0, nil
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode(), nil
	}
	return 0, err
}

func (owner *darwinOwner) Stop() error {
	owner.input.Close()
	wait := make(chan error, 1)
	go func() { wait <- owner.anchor.Wait() }()
	select {
	case err := <-wait:
		if anchorStopped(err) {
			return nil
		}
		return anchorWaitFailure(err)
	case <-time.After(owner.grace + 2*time.Second):
		if err := syscall.Kill(-owner.anchor.Process.Pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			return errors.New("termination-unconfirmed")
		}
		select {
		case err := <-wait:
			if anchorStopped(err) {
				return nil
			}
			return anchorWaitFailure(err)
		case <-time.After(time.Second):
		}
		return errors.New("termination-unconfirmed:anchor-timeout")
	}
}

func startOwned(req launchRequest) (ownedService, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, errors.New("supervisor-unavailable")
	}
	ready, writer, err := os.Pipe()
	if err != nil {
		return nil, errors.New("anchor-unavailable")
	}
	defer ready.Close()
	anchor := exec.Command(exe, "--anchor", strconv.Itoa(req.GraceMS))
	anchor.Env = []string{}
	anchor.Stdout = io.Discard
	anchor.Stderr = io.Discard
	anchor.ExtraFiles = []*os.File{writer}
	anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	input, err := anchor.StdinPipe()
	if err != nil {
		writer.Close()
		return nil, errors.New("anchor-unavailable")
	}
	if err = anchor.Start(); err != nil {
		writer.Close()
		input.Close()
		return nil, errors.New("anchor-unavailable")
	}
	writer.Close()
	owner := &darwinOwner{anchor: anchor, input: input, grace: time.Duration(req.GraceMS) * time.Millisecond}
	var token [1]byte
	_, err = io.ReadFull(ready, token[:])
	if err != nil || token[0] != 1 {
		_ = owner.Stop()
		return nil, errors.New("anchor-not-ready")
	}
	service := exec.Command(req.Program, req.Args...)
	service.Env = make([]string, 0, len(req.Env))
	for name, value := range req.Env {
		service.Env = append(service.Env, name+"="+value)
	}
	service.Stdin = nil
	service.Stdout = os.Stderr
	service.Stderr = os.Stderr
	service.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: anchor.Process.Pid}
	if err := service.Start(); err != nil {
		_ = owner.Stop()
		return nil, errors.New("spawn-failed")
	}
	owner.service = service
	return owner, nil
}

// The anchor's PID cannot be reused while the group is live. Its private
// stdin closes when the supervisor dies, even if the service holds stdout.
func runAnchor(grace time.Duration) {
	runAnchorWithSignal(grace, syscall.Kill)
}

func runAnchorWithSignal(grace time.Duration, sendSignal func(int, syscall.Signal) error) {
	signal.Ignore(syscall.SIGTERM)
	ready := os.NewFile(3, "anchor-ready")
	if ready == nil {
		os.Exit(2)
	}
	_, err := ready.Write([]byte{1})
	ready.Close()
	if err != nil {
		os.Exit(2)
	}
	buffer := make([]byte, 1024)
	for {
		if _, err := os.Stdin.Read(buffer); err != nil {
			break
		}
	}
	group := -os.Getpid()
	_ = sendSignal(group, syscall.SIGTERM)
	time.Sleep(grace)
	if err := sendSignal(group, syscall.SIGKILL); err != nil {
		os.Exit(2)
	}
	// Group SIGKILL delivery can lag the successful syscall on macOS. Do not
	// race it with an ordinary exit, which would invalidate ownership proof.
	for {
		time.Sleep(time.Hour)
	}
}

func anchorWaitFailure(err error) error {
	if exit, ok := err.(*exec.ExitError); ok {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				return fmt.Errorf("termination-unconfirmed:anchor-signal-%d", status.Signal())
			}
			return fmt.Errorf("termination-unconfirmed:anchor-exit-%d", status.ExitStatus())
		}
	}
	return errors.New("termination-unconfirmed:anchor-wait-failed")
}

func anchorStopped(err error) bool {
	if exit, ok := err.(*exec.ExitError); ok {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok {
			return status.Signaled() && status.Signal() == syscall.SIGKILL
		}
	}
	return false
}
