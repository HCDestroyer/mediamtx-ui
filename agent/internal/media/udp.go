package media

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"os"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/ts"
)

// findInterface resolves an interface given by name (eth0) or by one of its IP addresses.
func findInterface(spec string) (*net.Interface, error) {
	if spec == "" {
		return nil, nil
	}
	if ifi, err := net.InterfaceByName(spec); err == nil {
		return ifi, nil
	}
	if ip := net.ParseIP(spec); ip != nil {
		ifaces, _ := net.Interfaces()
		for i := range ifaces {
			addrs, _ := ifaces[i].Addrs()
			for _, a := range addrs {
				if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
					return &ifaces[i], nil
				}
			}
		}
	}
	return nil, fmt.Errorf("network interface %q not found", spec)
}

// ---- input ----

type udpInput struct {
	udp  addr.UDP
	rtp  bool
	ifi  *net.Interface
	pool int
}

func newUDPInput(a addr.Address) (Input, error) {
	u, err := addr.ParseUDP(a)
	if err != nil {
		return nil, err
	}
	ifi, err := findInterface(u.Interface)
	if err != nil {
		return nil, err
	}
	return &udpInput{udp: u, rtp: a.Scheme == "rtp", ifi: ifi}, nil
}

func (in *udpInput) Run(ctx context.Context, emit func([]byte)) error {
	local := &net.UDPAddr{IP: in.udp.IP, Port: in.udp.Port}
	var conn *net.UDPConn
	var err error
	if in.udp.Multicast() {
		conn, err = net.ListenMulticastUDP("udp4", in.ifi, local)
	} else {
		conn, err = net.ListenUDP("udp4", local)
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(8 << 20) // bursts of IPTV streams overrun the default kernel buffer

	go func() { <-ctx.Done(); conn.Close() }()
	buf := make([]byte, 65536)
	var align Aligner
	for {
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		payload := buf[:n]
		if in.rtp {
			if payload = rtpPayload(payload); payload == nil {
				continue
			}
		}
		align.Write(payload, emit)
	}
}

// rtpPayload strips the RTP header (CSRC list and extension included); nil when malformed.
func rtpPayload(p []byte) []byte {
	if len(p) < 12 || p[0]>>6 != 2 {
		return nil
	}
	off := 12 + int(p[0]&0x0F)*4
	if p[0]&0x10 != 0 {
		if len(p) < off+4 {
			return nil
		}
		off += 4 + int(binary.BigEndian.Uint16(p[off+2:]))*4
	}
	if off >= len(p) {
		return nil
	}
	return p[off:]
}

// ---- output ----

type udpOutput struct {
	udp     addr.UDP
	rtp     bool
	ifi     *net.Interface
	ttl     int
	perPack int
}

func newUDPOutput(a addr.Address) (Output, error) {
	u, err := addr.ParseUDP(a)
	if err != nil {
		return nil, err
	}
	ifi, err := findInterface(u.Interface)
	if err != nil {
		return nil, err
	}
	ttl, err := a.Int("ttl", 32)
	if err != nil {
		return nil, err
	}
	per, err := a.Int("pkt", 7)
	if err != nil {
		return nil, err
	}
	if per < 1 || per > 7 || ttl < 1 || ttl > 255 {
		return nil, fmt.Errorf("pkt must be 1-7 (packets per datagram) and ttl 1-255")
	}
	if _, bad := a.Options["cbr"]; bad {
		return nil, fmt.Errorf("cbr is a property of the service profile (cbrKbps), not of one output")
	}
	return &udpOutput{udp: u, rtp: a.Scheme == "rtp", ifi: ifi, ttl: ttl, perPack: per}, nil
}

func (o *udpOutput) Run(ctx context.Context, in <-chan []byte) error {
	dest := &net.UDPAddr{IP: o.udp.IP, Port: o.udp.Port}
	conn, err := net.DialUDP("udp4", nil, dest)
	if err != nil {
		return err
	}
	defer conn.Close()
	if o.udp.Multicast() {
		if err := setMulticast(conn, o.ttl, o.ifi); err != nil {
			return err
		}
	}
	var seq uint16
	ssrc := rand.Uint32()
	start := time.Now()
	for {
		select {
		case <-ctx.Done():
			return nil
		case batch, ok := <-in:
			if !ok {
				return nil
			}
			for len(batch) > 0 {
				n := min(len(batch), o.perPack*ts.PacketSize)
				datagram := batch[:n]
				if o.rtp {
					h := make([]byte, 12, 12+n)
					h[0], h[1] = 0x80, 33 // version 2, payload type 33 = MPEG-2 TS
					binary.BigEndian.PutUint16(h[2:], seq)
					binary.BigEndian.PutUint32(h[4:], uint32(time.Since(start).Seconds()*90000))
					binary.BigEndian.PutUint32(h[8:], ssrc)
					seq++
					datagram = append(h, datagram...)
				}
				if _, err := conn.Write(datagram); err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
					return err
				}
				batch = batch[n:]
			}
		}
	}
}
