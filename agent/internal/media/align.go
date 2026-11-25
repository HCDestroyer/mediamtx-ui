// Package media moves transport-stream bytes in and out of the agent: UDP and RTP sockets,
// HTTP, files, and FFmpeg as an adapter for every protocol MediaMTX or FFmpeg can speak.
package media

import "nodo/agent/internal/ts"

// Aligner turns an arbitrary byte stream into whole 188-byte packets. It finds the packet
// boundary again after garbage or a partial write by requiring three sync bytes in a row.
type Aligner struct {
	buf []byte
}

const maxChunk = ts.PacketSize * 64

// Write feeds bytes and calls emit with chunks that are multiples of 188 bytes and start on a
// sync byte. The slice passed to emit is only valid during the call.
func (a *Aligner) Write(data []byte, emit func([]byte)) {
	a.buf = append(a.buf, data...)
	for {
		if len(a.buf) < ts.PacketSize*3 {
			return
		}
		start := a.findSync()
		if start < 0 {
			// Keep the tail: a boundary may begin inside the last bytes.
			a.buf = append(a.buf[:0], a.buf[len(a.buf)-ts.PacketSize*3+1:]...)
			return
		}
		a.buf = a.buf[start:]
		n := 0
		for n+ts.PacketSize <= len(a.buf) && a.buf[n] == ts.SyncByte && n < maxChunk {
			n += ts.PacketSize
		}
		if n == 0 {
			// Sync was confirmed by findSync, so this cannot happen; drop a byte to guarantee progress.
			a.buf = a.buf[1:]
			continue
		}
		emit(a.buf[:n])
		a.buf = a.buf[n:]
		if len(a.buf) >= ts.PacketSize && a.buf[0] != ts.SyncByte {
			continue // lost sync: look for it again
		}
		if len(a.buf) < ts.PacketSize {
			return
		}
	}
}

// findSync returns the offset of the first byte followed by sync bytes one and two packets later.
func (a *Aligner) findSync() int {
	for i := 0; i+ts.PacketSize*2 < len(a.buf); i++ {
		if a.buf[i] == ts.SyncByte && a.buf[i+ts.PacketSize] == ts.SyncByte && a.buf[i+ts.PacketSize*2] == ts.SyncByte {
			return i
		}
	}
	return -1
}
