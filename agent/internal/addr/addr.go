// Package addr parses media addresses in the style of Astra: type://address#options,
// with options separated by &, for example udp://eth0@239.255.1.1:1234#pnr=100&timeout=5.
package addr

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// Address is a parsed media address.
type Address struct {
	Scheme  string
	Rest    string // everything between "://" and "#"
	Options map[string]string
	Raw     string
}

// Parse splits an address into scheme, body and options.
func Parse(raw string) (Address, error) {
	raw = strings.TrimSpace(raw)
	scheme, rest, ok := strings.Cut(raw, "://")
	if !ok || scheme == "" || rest == "" {
		return Address{}, fmt.Errorf("address must look like type://address, got %q", raw)
	}
	a := Address{Scheme: strings.ToLower(scheme), Options: map[string]string{}, Raw: raw}
	body, opts, hasOpts := strings.Cut(rest, "#")
	a.Rest = body
	if hasOpts && opts != "" {
		for _, pair := range strings.Split(opts, "&") {
			key, value, _ := strings.Cut(pair, "=")
			if key == "" {
				return Address{}, fmt.Errorf("empty option in %q", raw)
			}
			a.Options[key] = value
		}
	}
	if a.Rest == "" {
		return Address{}, fmt.Errorf("address %q has no host", raw)
	}
	return a, nil
}

// Int reads an integer option, or the default when absent.
func (a Address) Int(key string, def int) (int, error) {
	v, ok := a.Options[key]
	if !ok {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("option %s must be a number, got %q", key, v)
	}
	return n, nil
}

// WithoutOptions returns the address as a plain URL, without the #options part.
func (a Address) WithoutOptions() string { return a.Scheme + "://" + a.Rest }

// UDP is a decoded udp:// or rtp:// body: [iface@]host:port.
type UDP struct {
	Interface string
	IP        net.IP
	Port      int
}

// ParseUDP reads [iface@]host:port. The interface is a name (eth0) or the IP address of one.
func ParseUDP(a Address) (UDP, error) {
	u := UDP{}
	body := a.Rest
	if iface, rest, ok := strings.Cut(body, "@"); ok {
		u.Interface, body = iface, rest
	}
	host, portText, err := net.SplitHostPort(body)
	if err != nil {
		// Astra allows omitting the port: the default is 1234.
		host, portText = strings.Trim(body, "[]"), "1234"
	}
	if host == "" { // udp://@:1234 listens on every interface
		u.IP = net.IPv4zero
	} else if u.IP = net.ParseIP(host); u.IP == nil {
		return UDP{}, fmt.Errorf("%q is not an IP address", host)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return UDP{}, fmt.Errorf("invalid port %q", portText)
	}
	u.Port = port
	return u, nil
}

// Multicast reports whether the address is a multicast group.
func (u UDP) Multicast() bool { return u.IP.IsMulticast() }
