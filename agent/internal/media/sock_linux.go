//go:build linux

package media

import (
	"net"
	"syscall"
)

// setMulticast sets the TTL and the outgoing interface of a multicast sender.
func setMulticast(conn *net.UDPConn, ttl int, ifi *net.Interface) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var serr error
	err = raw.Control(func(fd uintptr) {
		serr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_TTL, ttl)
		if serr != nil || ifi == nil {
			return
		}
		addrs, _ := ifi.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil {
				var ip [4]byte
				copy(ip[:], n.IP.To4())
				serr = syscall.SetsockoptInet4Addr(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, ip)
				return
			}
		}
	})
	if err != nil {
		return err
	}
	return serr
}
