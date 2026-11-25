//go:build !linux

package media

import "net"

// setMulticast is a no-op where the agent is not supported; the agent targets Linux hosts.
func setMulticast(*net.UDPConn, int, *net.Interface) error { return nil }
