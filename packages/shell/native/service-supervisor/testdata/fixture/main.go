package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "sleep":
		time.Sleep(30 * time.Second)
	case "parent", "host-parent":
		if os.Args[1] == "host-parent" {
			fmt.Println(os.Getenv("FIXTURE_VALUE"))
		}
		child := exec.Command(os.Args[0], "sleep")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		if os.Args[1] == "host-parent" {
			fmt.Printf("descendant:%d\n", child.Process.Pid)
		} else {
			fmt.Println(child.Process.Pid)
		}
		if len(os.Args) > 2 && os.Args[2] == "exit" {
			if os.Args[1] == "host-parent" {
				os.Exit(3)
			}
			os.Exit(0)
		}
		_ = child.Wait()
	default:
		os.Exit(2)
	}
}
