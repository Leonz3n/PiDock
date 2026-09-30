//go:build windows

package main

import (
	"errors"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsOwner struct {
	job     windows.Handle
	process windows.Handle
	pid     int
}

type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

func (owner *windowsOwner) PID() int { return owner.pid }

func (owner *windowsOwner) Wait() (int, error) {
	state, err := windows.WaitForSingleObject(owner.process, windows.INFINITE)
	if err != nil || state != windows.WAIT_OBJECT_0 {
		return 0, errors.New("process-wait-failed")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(owner.process, &code); err != nil {
		return 0, errors.New("process-wait-failed")
	}
	return int(code), nil
}

func (owner *windowsOwner) Stop() error {
	terminated := windows.TerminateJobObject(owner.job, 1) == nil
	confirmed := false
	for until := time.Now().Add(2 * time.Second); time.Now().Before(until); {
		var state jobAccounting
		if err := windows.QueryInformationJobObject(owner.job, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&state)), uint32(unsafe.Sizeof(state)), nil); err == nil && state.ActiveProcesses == 0 {
			confirmed = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	closed := windows.CloseHandle(owner.job) == nil
	if !terminated || !confirmed || !closed {
		return errors.New("termination-unconfirmed")
	}
	return nil
}

func environmentBlock(env map[string]string) ([]uint16, error) {
	names := make([]string, 0, len(env))
	seen := make(map[string]bool, len(env))
	for name := range env {
		folded := strings.ToUpper(name)
		if seen[folded] {
			return nil, errors.New("duplicate-environment")
		}
		seen[folded] = true
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToUpper(names[i]) < strings.ToUpper(names[j]) })
	block := make([]uint16, 0, 1024)
	for _, name := range names {
		block = append(block, syscall.StringToUTF16(name+"="+env[name])...)
	}
	block = append(block, 0)
	if len(names) == 0 {
		block = append(block, 0)
	}
	return block, nil
}

func inheritedHandle(source windows.Handle) (windows.Handle, error) {
	current, err := windows.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var inherited windows.Handle
	if err := windows.DuplicateHandle(current, source, current, &inherited, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return 0, err
	}
	return inherited, nil
}

func startOwned(req launchRequest) (ownedService, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, errors.New("job-unavailable")
	}
	closeJob := true
	defer func() {
		if closeJob {
			windows.CloseHandle(job)
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, errors.New("job-unavailable")
	}
	input, err := os.Open(os.DevNull)
	if err != nil {
		return nil, errors.New("stdio-unavailable")
	}
	defer input.Close()
	stdin, err := inheritedHandle(windows.Handle(input.Fd()))
	if err != nil {
		return nil, errors.New("stdio-unavailable")
	}
	defer windows.CloseHandle(stdin)
	logs, err := inheritedHandle(windows.Handle(os.Stderr.Fd()))
	if err != nil {
		return nil, errors.New("stdio-unavailable")
	}
	defer windows.CloseHandle(logs)
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, errors.New("stdio-unavailable")
	}
	defer attributes.Delete()
	handles := []windows.Handle{stdin, logs}
	if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
		return nil, errors.New("stdio-unavailable")
	}
	startup := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES,
			StdInput: stdin, StdOutput: logs, StdErr: logs},
		ProcThreadAttributeList: attributes.List(),
	}
	app, err := windows.UTF16PtrFromString(req.Program)
	if err != nil {
		return nil, errors.New("invalid-launch")
	}
	line, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{req.Program}, req.Args...)))
	if err != nil {
		return nil, errors.New("invalid-launch")
	}
	block, err := environmentBlock(req.Env)
	if err != nil {
		return nil, err
	}
	var process windows.ProcessInformation
	if err := windows.CreateProcess(app, line, nil, nil, true,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT,
		&block[0], nil, &startup.StartupInfo, &process); err != nil {
		return nil, errors.New("spawn-failed")
	}
	runtime.KeepAlive(handles)
	runtime.KeepAlive(block)
	defer windows.CloseHandle(process.Thread)
	closeProcess := true
	defer func() {
		if closeProcess {
			windows.CloseHandle(process.Process)
		}
	}()
	if err := windows.AssignProcessToJobObject(job, process.Process); err != nil {
		windows.TerminateProcess(process.Process, 1)
		return nil, errors.New("job-assignment-failed")
	}
	if _, err := windows.ResumeThread(process.Thread); err != nil {
		windows.TerminateJobObject(job, 1)
		return nil, errors.New("resume-failed")
	}
	closeJob = false
	closeProcess = false
	return &windowsOwner{job: job, process: process.Process, pid: int(process.ProcessId)}, nil
}

func runAnchor(_ time.Duration) { os.Exit(2) }
