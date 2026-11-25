package host

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// InterfaceRate is the live view of one interface.
type InterfaceRate struct {
	Interface
	RxBps uint64 `json:"rxBps"`
	TxBps uint64 `json:"txBps"`
	// RecentErrors counts errors and drops over the last minute.
	RecentErrors uint64 `json:"recentErrors"`
}

// View is a snapshot plus what can only be known by watching: usage, rates and recent loss.
type View struct {
	Snapshot
	CPUUsage float64         `json:"cpuUsage"` // percent over the last interval
	Rates    []InterfaceRate `json:"rates"`
	// RecentUDPDrops counts UDP receive-buffer overflows over the last minute.
	RecentUDPDrops uint64    `json:"recentUdpDrops"`
	Findings       []Finding `json:"findings"`
}

type sample struct {
	at   time.Time
	snap Snapshot
}

// Monitor samples the machine and keeps about a minute of history.
type Monitor struct {
	root     string
	interval time.Duration
	tools    func() []ToolPresence
	encoders func() []string

	mu      sync.Mutex
	samples []sample
	view    View
}

// ToolPresence tells the advisor which helpers are installed.
type ToolPresence struct {
	ID    string
	Found bool
}

// NewMonitor creates a monitor; call Run to start sampling.
func NewMonitor(root string, interval time.Duration, tools func() []ToolPresence, encoders func() []string) *Monitor {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	m := &Monitor{root: root, interval: interval, tools: tools, encoders: encoders}
	m.Sample(time.Now())
	return m
}

// Run samples until ctx ends.
func (m *Monitor) Run(ctx context.Context) {
	t := time.NewTicker(m.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			m.Sample(now)
		}
	}
}

// View returns the latest view.
func (m *Monitor) View() View {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.view
}

// Sample reads the machine once and recomputes the view. Exposed for tests.
func (m *Monitor) Sample(now time.Time) {
	snap := Read(m.root)
	m.mu.Lock()
	m.samples = append(m.samples, sample{now, snap})
	for len(m.samples) > 1 && now.Sub(m.samples[0].at) > 70*time.Second {
		m.samples = m.samples[1:]
	}
	view := buildView(m.samples)
	m.mu.Unlock()

	var present []ToolPresence
	if m.tools != nil {
		present = m.tools()
	}
	var enc []string
	if m.encoders != nil {
		enc = m.encoders()
	}
	view.Findings = Advise(view, present, enc)
	if view.Findings == nil {
		view.Findings = []Finding{}
	}
	m.mu.Lock()
	m.view = view
	m.mu.Unlock()
}

func sub(a, b uint64) uint64 {
	if a < b { // counters reset (interface removed, reboot)
		return 0
	}
	return a - b
}

func buildView(samples []sample) View {
	last := samples[len(samples)-1]
	v := View{Snapshot: last.snap, Rates: []InterfaceRate{}}
	prev, oldest := samples[0], samples[0]
	if len(samples) > 1 {
		prev = samples[len(samples)-2]
	}
	secs := last.at.Sub(prev.at).Seconds()
	if t := sub(last.snap.CPUTotal, prev.snap.CPUTotal); t > 0 {
		v.CPUUsage = 100 * float64(sub(last.snap.CPUBusy, prev.snap.CPUBusy)) / float64(t)
	}
	index := func(s Snapshot) map[string]Interface {
		m := map[string]Interface{}
		for _, i := range s.Interfaces {
			m[i.Name] = i
		}
		return m
	}
	before, old := index(prev.snap), index(oldest.snap)
	for _, ifc := range last.snap.Interfaces {
		r := InterfaceRate{Interface: ifc}
		if p, ok := before[ifc.Name]; ok && secs > 0 {
			r.RxBps = uint64(float64(sub(ifc.RxBytes, p.RxBytes)) * 8 / secs)
			r.TxBps = uint64(float64(sub(ifc.TxBytes, p.TxBytes)) * 8 / secs)
		}
		if o, ok := old[ifc.Name]; ok {
			r.RecentErrors = sub(ifc.RxErrors+ifc.RxDropped+ifc.TxErrors+ifc.TxDropped, o.RxErrors+o.RxDropped+o.TxErrors+o.TxDropped)
		}
		v.Rates = append(v.Rates, r)
	}
	v.RecentUDPDrops = sub(last.snap.UDP.RcvbufErrors, oldest.snap.UDP.RcvbufErrors)
	return v
}

// Encoders lists the video encoders of an FFmpeg binary that matter for hardware use.
func Encoders(ffmpeg string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-encoders").Output()
	if err != nil {
		return nil
	}
	want := []string{"libx264", "h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_vaapi", "h264_amf"}
	var found []string
	for _, w := range want {
		for _, line := range strings.Split(string(out), "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[1] == w {
				found = append(found, w)
				break
			}
		}
	}
	return found
}
